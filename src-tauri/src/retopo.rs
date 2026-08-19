//! Retopology and baking, the Rust half.
//!
//! The engine lives in this repository, in the retopo crates under
//! `src-tauri/crates/`: quadric error decimation with the link condition, flip
//! test and crease constraints. None of it knows about
//! Tauri or about this application, which is the point: the same functions serve
//! the Retopo tab, the `remesh` command line and, later, the optional HTTP API.
//!
//! **The engine runs in a child process, and that is not an accident.**
//! Measured on this machine, at Albedo's release profile:
//!
//! | Build | Bytes |
//! |---|---:|
//! | Albedo alone | 3,947,008 |
//! | with the engine, `panic = "abort"` kept | 4,720,128 |
//! | with the engine, `panic = "abort"` dropped | 8,893,440 |
//!
//! The engine costs 0.77 MB. Dropping `abort` so a `catch_unwind` could fire
//! costs 4.17 MB, because unwinding tables land on the whole binary and not on
//! the engine alone. Paying five times the engine's own weight for a guard is a
//! bad trade, and a child process is a better guard anyway: it survives a stack
//! overflow and an allocation failure, which no `catch_unwind` ever catches.
//!
//! The pattern is already in this repository. `shell-thumbnails` runs
//! `albedo.exe --thumbnail` one process per file for exactly this reason.
//!
//! **Files, not IPC payloads.** A model worth retopologising is tens of
//! megabytes, and Tauri's default command encoding would turn that into a JSON
//! array of numbers on the way in and again on the way out.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// What the caller may set. Everything has a default that works, because the
/// only value a user should be forced to think about is the triangle budget.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemeshRequest {
    /// `decimate` spends a budget where the silhouette needs it. `isotropic`
    /// rebuilds toward even edge lengths and a valence of six, which is what a
    /// model that will deform or subdivide wants instead.
    pub method: String,
    /// Stop once this many triangles remain.
    pub target_triangles: usize,
    /// The *other* stop condition, and the one that matters when quality is the
    /// goal rather than a budget: stop when the next collapse would move the
    /// surface further than this, as a share of the bounding box diagonal.
    ///
    /// Infinity disables it, which is the default, because a triangle budget is
    /// what most people arrive with. Set it and the run stops when the shape
    /// starts to suffer instead of when the counter runs out, which is the
    /// difference between "make it 5000 triangles" and "make it as small as it
    /// can be without visibly changing".
    pub max_error: f32,
    /// Close boundary loops before anything else runs. A hole reached by the
    /// bake later is a hole the cage projects through.
    pub fill_holes: bool,
    /// Pin open borders in place.
    pub preserve_boundary: bool,
    /// Dihedral angle, in degrees, above which an edge counts as a crease.
    pub sharp_angle_deg: f32,
    /// Extra cost for collapsing across a UV seam or a normal split.
    pub seam_penalty: f32,
    /// Tangential relax passes, each one reprojected onto the source.
    pub relax_iterations: u32,
    /// How far toward the neighbour average each pass moves a vertex, `0..1`.
    ///
    /// Passes and strength are not the same knob wearing two hats: many gentle
    /// passes converge on an even mesh, while a few strong ones overshoot and
    /// wobble. Exposing only the count is why the engine's relax felt blunt.
    pub relax_strength: f32,
    /// The crease angle **relaxation** uses, which is deliberately not the one
    /// decimation uses.
    ///
    /// Sharing them once cost a debugging session: relax inherited the
    /// decimation angle, pinned eighty six percent of the vertices and silently
    /// did nothing. A mesh reduced fifty to one is faceted everywhere, so the
    /// angle that means "crease" to a decimator means "the whole model" to a
    /// smoother. Two questions, two numbers.
    pub relax_angle_deg: f32,
    /// Pair adjacent triangles into quads and carry the diagonal mask out.
    pub pair_quads: bool,

    // --- the bake ---
    /// Reproject the source onto the result and write the maps into it.
    pub bake: bool,
    /// Side of the square atlas, in texels.
    pub map_size: u32,
    /// How far above the surface a ray starts, as a share of the bounding box
    /// diagonal. Too small and it misses anything poking out of the low poly;
    /// too large and it reaches across a gap onto the next part.
    pub cage_out: f32,
    /// How far below the surface it keeps looking.
    pub cage_in: f32,
    /// Empty texels between islands, so mip levels cannot mix two charts.
    pub gutter: u32,
    /// Painted colour smeared past every chart border, so filtering never
    /// samples the background. Not the same thing as the gutter, and both
    /// matter.
    pub bleed: u32,
    /// Above this angle a chart stops growing and a new one starts.
    pub island_angle_deg: f32,
    /// Tangent space normal map from the high poly geometry.
    pub bake_normal: bool,
    /// Metallic and roughness, read off the high poly.
    ///
    /// Without it the whole low poly inherits one pair of scalars, so a gold
    /// ring on a wooden handle comes back as matte wood. Albedo is not a
    /// material.
    pub bake_metallic_roughness: bool,
    /// Emissive, for anything that gives off light rather than reflecting it.
    /// Dropped automatically when nothing on the model emits.
    pub bake_emissive: bool,
    /// Ambient occlusion, by cosine weighted hemisphere sampling.
    pub bake_ao: bool,
    /// Rays per texel for occlusion. Sixteen is enough to read.
    pub ao_samples: u32,
    /// How far occlusion looks, as a share of the bounding box diagonal. Short
    /// means creases only, long means the whole silhouette shades itself.
    pub ao_distance: f32,

    // --- what was painted on the model ---
    //
    // The painting itself is not in here. It travels as a sidecar beside the
    // input GLB, for the same reason the model does: it is tens of thousands of
    // points, and Tauri's command encoding would turn that into a JSON array of
    // numbers on the way across. What the request carries is how hard to listen
    // to it.
    /// How hard painted density pulls, `0..1`. Zero ignores it entirely.
    pub density_influence: f32,
    /// How hard a flow guide biases which edges are spent, `0..1`.
    pub flow_strength: f32,
    /// Read the painting at all. Off is the way to compare a run against the
    /// same run without it, which is the only way to judge what the brush did.
    pub use_painting: bool,

    // --- the bake, in part ---
    /// Keep the UV layout the low poly already has instead of unwrapping again.
    ///
    /// A bake has always rebuilt the atlas, which is why re-baking could never be
    /// a *correction*: what came back had its islands somewhere else, so it
    /// replaced the previous texture rather than improving it.
    pub reuse_uvs: bool,
    /// Re-shoot only the painted region and blend it into the existing maps.
    pub patch_bake: bool,
    /// Texels of cross-fade at the border of the patch.
    pub patch_feather: u32,
}

impl Default for RemeshRequest {
    fn default() -> Self {
        // Mirrors the engine's own defaults rather than inventing a second set,
        // so a result obtained here and one obtained from its CLI agree.
        Self {
            method: "decimate".into(),
            target_triangles: 0,
            max_error: f32::INFINITY,
            fill_holes: false,
            preserve_boundary: true,
            sharp_angle_deg: 40.0,
            seam_penalty: 4.0,
            relax_iterations: 0,
            relax_strength: 0.5,
            relax_angle_deg: 75.0,
            pair_quads: false,
            bake: false,
            map_size: 2048,
            cage_out: 0.02,
            cage_in: 0.02,
            gutter: 4,
            bleed: 8,
            // 50, taken from `AtlasOptions::default()` rather than picked
            // because it felt right. It was 66 here first, which is how the same
            // model came out with 85 charts where the engine gives 103. Every
            // default in this struct is worth checking against the engine's own
            // instead of guessed, which is the only way a result obtained here
            // and one obtained from the engine's CLI can be compared at all.
            island_angle_deg: 50.0,
            bake_normal: true,
            bake_metallic_roughness: true,
            bake_emissive: true,
            bake_ao: false,
            ao_samples: 16,
            ao_distance: 0.15,
            density_influence: 0.75,
            flow_strength: 0.5,
            use_painting: true,
            reuse_uvs: false,
            patch_bake: false,
            patch_feather: 8,
        }
    }
}

/// What a run has to say for itself.
///
/// The refusals are reported rather than swallowed because they are how you tell
/// "this mesh is already as small as its topology allows" from "the budget was
/// met". A run with a large refusal count and an untouched triangle count is the
/// signature of a guard firing on every candidate, which has happened before and
/// cost a debugging session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemeshReport {
    pub input_triangles: usize,
    pub output_triangles: usize,
    pub collapses: usize,
    pub rejected_topology: usize,
    pub rejected_flip: usize,
    /// Largest accepted surface displacement, in model units.
    pub max_error: f32,
    /// Boundary loops closed, and the ones left alone for being too large.
    pub holes_filled: usize,
    pub holes_left: usize,
    /// Mean triangle aspect ratio before and after relaxation. The mean is the
    /// honest number here: the worst triangle sits on a crease, which relaxation
    /// pins on purpose, so it barely moves even when the mesh improved
    /// throughout.
    pub aspect_before: f32,
    pub aspect_after: f32,
    pub quads: usize,
    /// Share of the surface covered by quads rather than lone triangles.
    pub quad_fraction: f32,
    /// Atlas charts, and how much of the square they actually fill.
    pub charts: usize,
    pub utilisation: f32,
    /// Rays that found the high poly, and rays that did not. A miss rate that
    /// climbs is a cage too short, or a chart wrapped around something thin.
    pub hits: usize,
    pub misses: usize,
    pub maps: Vec<String>,
    /// Largest distance from the result back to the source, in model units.
    pub deviation_max: f32,
    pub millis: u128,

    // --- what the painting did, if there was one ---
    //
    // Reported rather than left to be inferred from the picture. A brush whose
    // effect you can only judge by eye is a brush you cannot tell from one that
    // silently did nothing, and the failure mode that matters here, a sidecar
    // whose points do not land on this mesh, produces exactly that: a run that
    // looks ordinary and ignored everything you drew.
    /// Painted points in the sidecar.
    pub paint_samples: usize,
    /// How many of the mesh's own welded points a painted sample landed on. Far
    /// below `paint_samples` means the two do not describe the same model.
    pub paint_matched: usize,
    /// Guide curves read.
    pub paint_guides: usize,
    /// Welded points the painting held still: frozen, on a crease guide, or
    /// outside the region the run was restricted to.
    pub paint_locked: usize,
    /// Texels a patch bake re-shot, when it was one. `None` for a whole bake.
    ///
    /// The number that says whether the region reached the atlas at all: a patch
    /// that touched forty texels of four million is a region painted where this
    /// mesh is not, and from the outside that is indistinguishable from a bake
    /// that quietly did nothing.
    pub texels_patched: Option<usize>,
}

/// Run the whole pipeline on one GLB and write another. No Tauri in it.
///
/// Shared by the `remesh` subcommand and, later, the HTTP handler, so the doors
/// cannot drift apart. The order is the one the engine settled on: close holes on
/// the source first, because a boundary the decimator has to respect is a
/// boundary the bake later projects through; then reduce; then relax, which only
/// makes sense once the triangles it is smoothing exist; then pair.
///
/// Two things travel beside the GLB, because glTF has nowhere to put them:
///
/// - `<output>.quads`, one `u32` per triangle. Bit `k` set means the edge from
///   corner `k` to corner `k+1` is a real edge; the cleared bit on a paired
///   triangle is the quad's diagonal. glTF has no quads, so this is how quad
///   topology survives a format that cannot hold it.
/// - `<output>.dev`, one `f32` per vertex, the distance back to the source
///   through its BVH. This is what a deviation heatmap reads.
pub fn remesh_file(
    input: &Path,
    output: &Path,
    req: &RemeshRequest,
    progress: &mut dyn FnMut(f32),
) -> Result<RemeshReport, String> {
    let started = std::time::Instant::now();
    let mut report = RemeshReport::default();

    let bytes = std::fs::read(input).map_err(|e| format!("lecture impossible: {e}"))?;
    let mut mesh = retopo_core::glb::load_bytes(&bytes).map_err(|e| format!("{e:#}"))?;

    let source_count = mesh.triangle_count();
    report.input_triangles = source_count;
    if req.target_triangles == 0 {
        return Err("aucun budget de triangles".into());
    }
    if req.target_triangles >= source_count {
        return Err(format!(
            "le budget ({}) n'est pas inférieur au maillage source ({source_count})",
            req.target_triangles
        ));
    }

    // Stage 1: holes. Cheap, so it gets the first five percent of the bar.
    if req.fill_holes {
        let fill = retopo_remesh::fill_holes(&mut mesh, &retopo_remesh::FillOptions { max_loop_edges: 5_000 });
        report.holes_filled = fill.loops_filled;
        report.holes_left = fill.loops_found.saturating_sub(fill.loops_filled);
    }
    progress(0.05);

    // Progress is apportioned by what each stage actually costs rather than
    // evenly. Baking is the slow one by a wide margin, several seconds against
    // one, so when it is on it takes most of the bar and the rest compresses.
    let (r0, r1, x0, x1, b0, b1) = if req.bake {
        (0.05, 0.38, 0.38, 0.48, 0.52, 0.97)
    } else {
        (0.05, 0.65, 0.65, 0.85, 0.92, 0.92)
    };

    // The source, as it will be measured against afterwards. Built before the
    // reduction so relaxation and the deviation both compare to what came in.
    let source_bvh = retopo_core::Bvh::build(&mesh);

    /*
     * What was painted on this mesh, if anything.
     *
     * Read from a sidecar beside the *input*, not the output: it describes the
     * model going in. Absent is the ordinary case and not an error, most runs
     * have no painting, but a sidecar that exists and cannot be read is, because
     * a brush that silently does nothing is indistinguishable from a brush that
     * is broken.
     *
     * Two shapes of the same data, and both are needed. The spatial field
     * answers for any point, which is what the isotropic remesher and the relax
     * pass need: both work on vertices that did not exist when the painting was
     * made. The resolved table answers per welded vertex of *this* mesh, which is
     * what the decimator needs: it asks about the same points a million times.
     */
    let painting = if req.use_painting {
        retopo_core::Painting::load(&sidecar(input, "paint"))?
    } else {
        None
    };
    let field = painting.and_then(retopo_core::PaintField::from_painting).map(Arc::new);
    let vertex_field = field.as_ref().map(|f| Arc::new(f.resolve(&mesh)));
    if let (Some(f), Some(v)) = (field.as_ref(), vertex_field.as_ref()) {
        report.paint_samples = f.sample_count();
        report.paint_guides = f.guide_count();
        report.paint_matched = v.matched;
    }

    // Stage 2: reduce.
    let mut result = match req.method.as_str() {
        "isotropic" => {
            let opts = retopo_remesh::IsotropicOptions {
                target_triangles: req.target_triangles,
                sharp_angle_deg: req.sharp_angle_deg,
                field: field.clone(),
                density_influence: req.density_influence,
                ..Default::default()
            };
            let (m, s) = retopo_remesh::isotropic(&mesh, &opts, &mut |f| progress(r0 + f * (r1 - r0)));
            report.collapses = s.collapses;
            m
        }
        _ => {
            let opts = retopo_remesh::DecimateOptions {
                target_triangles: req.target_triangles,
                max_error: req.max_error,
                preserve_boundary: req.preserve_boundary,
                sharp_angle_deg: req.sharp_angle_deg,
                seam_penalty: req.seam_penalty,
                field: vertex_field.clone(),
                density_influence: req.density_influence,
                flow_strength: req.flow_strength,
                ..Default::default()
            };
            let (m, s) = retopo_remesh::decimate(&mesh, &opts, &mut |f| progress(r0 + f * (r1 - r0)));
            report.collapses = s.collapses;
            report.rejected_topology = s.rejected_topology;
            report.rejected_flip = s.rejected_flip;
            report.max_error = s.max_error;
            report.paint_locked = s.locked_by_paint;
            m
        }
    };
    progress(r1);

    // Stage 3: relax, always reprojected. The tangential projection is what
    // stops a sphere deflating a little on every pass.
    if req.relax_iterations > 0 {
        let opts = retopo_remesh::RelaxOptions {
            iterations: req.relax_iterations,
            strength: req.relax_strength,
            preserve_features: true,
            sharp_angle_deg: req.relax_angle_deg,
            // Frozen paint and anything outside the region hold still here too.
            // Without it a run restricted to one area still smoothed the whole
            // model, which reads as the restriction having done nothing.
            field: field.clone(),
            ..Default::default()
        };
        let s = retopo_remesh::relax(&mut result, Some(&source_bvh), &opts, &mut |f| {
            progress(x0 + f * (x1 - x0))
        });
        // The mean, not the worst. See the field's own comment.
        report.aspect_before = s.mean_before;
        report.aspect_after = s.mean_after;
    }
    progress(x1);

    report.output_triangles = result.triangle_count();

    // Stage 4: pair into quads, and carry the mask out beside the file.
    if req.pair_quads {
        let opts = retopo_remesh::QuadOptions::default();
        let pairing = retopo_remesh::pair_into_quads(&result, &opts);
        report.quads = pairing.stats.quads;
        report.quad_fraction = pairing.stats.quad_fraction;

        let mut raw = Vec::with_capacity(pairing.edge_mask.len() * 4);
        for m in &pairing.edge_mask {
            raw.extend_from_slice(&m.to_le_bytes());
        }
        let _ = std::fs::write(sidecar(output, "quads"), &raw);
    }
    progress(b0);

    // Filled by the bake when it can vouch for the mapping; see run_bake.
    let mut chart_bytes: Option<Vec<u8>> = None;

    // Stage 5: bake. The source is reprojected onto the result and the maps are
    // written into it, so what leaves here is a textured low poly rather than a
    // bare one plus a pile of loose PNGs.
    //
    // Five maps and not one. Baking base colour alone was a real omission and it
    // showed immediately: a gold ring on a wooden handle came back as matte wood,
    // because the whole low poly inherited a single pair of metallic and
    // roughness scalars.
    if req.bake {
        result = run_bake(&result, &mesh, req, field.as_ref(), &mut report, &mut chart_bytes, &mut |f| {
            progress(b0 + f * (b1 - b0))
        })?;
    }
    if let Some(raw) = &chart_bytes {
        let _ = std::fs::write(sidecar(output, "charts"), raw);
    }

    // How far the result actually moved, per vertex, for the heatmap.
    let dev = retopo_core::wire::deviation_against(&result, &source_bvh);
    report.deviation_max = dev.iter().copied().fold(0.0f32, f32::max);
    let mut raw = Vec::with_capacity(dev.len() * 4);
    for d in &dev {
        raw.extend_from_slice(&d.to_le_bytes());
    }
    let _ = std::fs::write(sidecar(output, "dev"), &raw);

    let out = retopo_core::glb::to_bytes(&result).map_err(|e| format!("{e:#}"))?;
    std::fs::write(output, &out).map_err(|e| format!("écriture impossible: {e}"))?;
    progress(1.0);

    report.millis = started.elapsed().as_millis();
    Ok(report)
}

/// Reproject `high` onto `low` and hand back the low poly carrying its maps.
///
/// Its own function because baking is not a stage of the retopology job. It is
/// its own operation on two meshes that already exist, which is what makes
/// changing a map size or a cage distance cost a bake rather than a whole
/// decimation. The Retopo mode calls it both ways.
fn run_bake(
    low: &retopo_core::Mesh,
    high: &retopo_core::Mesh,
    req: &RemeshRequest,
    field: Option<&Arc<retopo_core::PaintField>>,
    report: &mut RemeshReport,
    chart_bytes: &mut Option<Vec<u8>>,
    progress: &mut dyn FnMut(f32),
) -> Result<retopo_core::Mesh, String> {
    /*
     * A patch needs a region to be a patch.
     *
     * Refused rather than quietly downgraded to a whole bake: the two cost
     * wildly different amounts of time and produce wildly different results, and
     * "I asked for a touch-up and it re-baked everything" is the kind of surprise
     * that costs somebody an afternoon of work they had done on the old texture.
     */
    let patch = if req.patch_bake {
        let field = field.ok_or(
            "retouche demandée sans zone peinte : peins la zone à refaire d'abord",
        )?;
        if !field.has_region() {
            return Err(
                "retouche demandée mais aucune zone n'est peinte, seulement de la densité \
                 ou du gel : c'est le pinceau Zone qui dit où retoucher"
                    .into(),
            );
        }
        Some(retopo_bake::PatchOptions {
            field: field.clone(),
            feather: req.patch_feather,
        })
    } else {
        None
    };

    let opts = retopo_bake::BakeOptions {
        atlas: retopo_bake::AtlasOptions {
            resolution: req.map_size,
            // The gutter and the bleed are two different things and both matter.
            // This is the empty space between islands, so a mip level cannot mix
            // two charts.
            padding: req.gutter,
            max_chart_angle_deg: req.island_angle_deg,
            ..Default::default()
        },
        cage_out: req.cage_out,
        cage_in: req.cage_in,
        bake_normal: req.bake_normal,
        bake_metallic_roughness: req.bake_metallic_roughness,
        bake_emissive: req.bake_emissive,
        bake_ao: req.bake_ao,
        ao_samples: req.ao_samples,
        ao_distance: req.ao_distance,
        // And this is the painted colour smeared past each border, so filtering
        // never samples the background through a seam.
        dilate: req.bleed,
        reuse_uvs: req.reuse_uvs,
        patch,
    };
    let baked =
        retopo_bake::bake(low, high, &opts, progress).map_err(|e| format!("bake: {e:#}"))?;

    // The chart each triangle landed in, so the viewer can colour the atlas.
    //
    // `BakeResult` does not carry the atlas, and unwrapping a second time is the
    // honest way to get it: the alternative is widening the engine's public API
    // from here, which is the wrong direction for a dependency. The unwrap is a
    // fraction of the bake's own cost, since the expensive part is firing rays
    // and not growing charts.
    //
    // Guarded rather than trusted. The bake re-indexes the low poly against the
    // atlas, so if it ever splits or reorders triangles the mask would line up
    // with nothing and paint noise that looks like a real chart layout. Counts
    // disagreeing means no file, and the viewer keeps the mode switched off.
    /*
     * The same atlas the bake used, not a fresh one.
     *
     * This re-derives the chart ids so the viewer can colour the islands, and it
     * has to take the same branch the bake took. Unwrapping again while the bake
     * kept the mesh's own coordinates would hand the viewer a plausible chart
     * layout belonging to an atlas that does not exist, which is worse than no
     * layout at all: it would be read as the truth.
     */
    let charts = match (opts.reuse_uvs || opts.patch.is_some())
        .then(|| retopo_bake::atlas::from_uvs(low))
        .flatten()
    {
        Some(a) => a,
        None => retopo_bake::unwrap(low, &opts.atlas),
    };
    if charts.chart_of_tri.len() != baked.mesh.triangle_count() {
        eprintln!(
            "ilots ignores : {} ids pour {} triangles cuits ({} triangles dans l'atlas)",
            charts.chart_of_tri.len(),
            baked.mesh.triangle_count(),
            charts.triangles.len()
        );
    }
    if charts.chart_of_tri.len() == baked.mesh.triangle_count() {
        let mut raw = Vec::with_capacity(charts.chart_of_tri.len() * 4);
        for c in &charts.chart_of_tri {
            raw.extend_from_slice(&c.to_le_bytes());
        }
        *chart_bytes = Some(raw);
    }

    report.charts = baked.stats.charts;
    report.texels_patched = baked.stats.texels_patched;
    report.utilisation = baked.stats.utilisation;
    report.hits = baked.stats.hits;
    report.misses = baked.stats.misses;
    report.maps.clear();
    report.maps.push("Couleur de base".into());
    if baked.stats.has_metallic_roughness {
        report.maps.push("Métal et rugosité".into());
    }
    if baked.stats.has_normal {
        report.maps.push("Normale".into());
    }
    // Emissive is dropped when nothing on the model emits, so asking for it
    // costs nothing and the report says whether it actually happened.
    if baked.stats.has_emissive {
        report.maps.push("Émissif".into());
    }
    if baked.stats.has_ao {
        report.maps.push("Occlusion".into());
    }
    Ok(baked.mesh)
}

/// Bake one file onto another, with no remeshing in between.
///
/// `high` is what the detail comes from, `low` is what receives it. Nothing is
/// decimated here, so iterating on a bad map costs seconds instead of a minute.
pub fn bake_file(
    high: &Path,
    low: &Path,
    output: &Path,
    req: &RemeshRequest,
    progress: &mut dyn FnMut(f32),
) -> Result<RemeshReport, String> {
    let started = std::time::Instant::now();
    let mut report = RemeshReport::default();

    // Kept before the meshes shadow the arguments: the painting sits beside the
    // source *file*, and by the next line `high` is a mesh.
    let high_path = high;
    let hb = std::fs::read(high).map_err(|e| format!("lecture de la source impossible: {e}"))?;
    let lb = std::fs::read(low).map_err(|e| format!("lecture du résultat impossible: {e}"))?;
    let high = retopo_core::glb::load_bytes(&hb).map_err(|e| format!("{e:#}"))?;
    let low = retopo_core::glb::load_bytes(&lb).map_err(|e| format!("{e:#}"))?;

    report.input_triangles = high.triangle_count();
    report.output_triangles = low.triangle_count();

    /*
     * The painting travels beside the source, and a re-bake reads it fresh.
     *
     * Deliberately re-read here rather than remembered from the run that made
     * this pair: the whole point of patching is that you look at a bad result,
     * paint the part that is wrong, and re-bake *that*. The region is therefore
     * always newer than the geometry it applies to.
     */
    let painting = if req.use_painting {
        retopo_core::Painting::load(&sidecar(high_path, "paint"))?
    } else {
        None
    };
    let field = painting
        .and_then(retopo_core::PaintField::from_painting)
        .map(Arc::new);
    if let Some(f) = field.as_ref() {
        report.paint_samples = f.sample_count();
        report.paint_guides = f.guide_count();
    }

    let mut chart_bytes: Option<Vec<u8>> = None;
    let baked = run_bake(&low, &high, req, field.as_ref(), &mut report, &mut chart_bytes, progress)?;
    if let Some(raw) = &chart_bytes {
        let _ = std::fs::write(sidecar(output, "charts"), raw);
    }

    let out = retopo_core::glb::to_bytes(&baked).map_err(|e| format!("{e:#}"))?;
    std::fs::write(output, &out).map_err(|e| format!("écriture impossible: {e}"))?;

    report.millis = started.elapsed().as_millis();
    Ok(report)
}

/// `result.glb` plus an extension, so the extras sit next to what they describe.
fn sidecar(output: &Path, ext: &str) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(ext);
    output.with_file_name(name)
}

// --- the command line ------------------------------------------------------

const USAGE: &str = "\
albedo remesh <modèle.glb> --faces <N> [options]
albedo bake <source.glb> <résultat.glb> [options du bake]

 Le bake seul ne remaille rien : il reprojette la source sur un résultat qui
 existe déjà, donc revenir sur une taille de carte coûte un bake et pas une
 décimation entière.

  --faces <N>        budget de triangles (obligatoire)
  --out <fichier>    sortie, par défaut <modèle>-retopo.glb
  --isotropic        reconstruire vers des arêtes régulières au lieu de décimer
  --holes            combler les trous avant de réduire
  --angle <degrés>   angle de pli pour la réduction, défaut 40
  --seam <coût>      coût d'une couture d'UV, défaut 4
  --open-borders     laisser les bords ouverts se faire décimer
  --relax <passes>   passes de lissage reprojetées, défaut 0
  --relax-angle <d>  angle de pli du lissage, défaut 75, volontairement
                     différent de --angle
  --quads            apparier les triangles en quads

 Ce qui a été peint sur le modèle, lu dans <modèle.glb>.paint s'il existe :
  --no-paint         ignorer la peinture, pour comparer avec et sans
  --density <0..1>   force de la densité peinte, défaut 0.75
  --flow <0..1>      force des guides de flux, défaut 0.5

 Bake, la source reprojetée sur le résultat :
  --bake             produire les maps et les écrire dans le résultat
  --uv-size <N>      côté de l'atlas en texels, défaut 2048
  --cage-out <f>     départ du rayon au-dessus de la surface, défaut 0.02
  --cage-in <f>      profondeur de recherche sous la surface, défaut 0.02
  --gutter <N>       texels vides entre îlots, défaut 4
  --bleed <N>        texels de bavure peints hors des îlots, défaut 8
  --island-angle <d> angle au-delà duquel un îlot s'arrête, défaut 66
  --no-normal        ne pas produire la normale
  --no-mr            ne pas produire métal et rugosité
  --no-emissive      ne pas produire l'émissif
  --ao               produire l'occlusion ambiante
  --ao-samples <N>   rayons par texel, défaut 16
  --ao-distance <f>  portée de l'occlusion, défaut 0.15

 Retoucher plutôt que refaire :
  --keep-uv          garder les UV du maillage au lieu de le redéplier
  --patch            ne recuire que la zone peinte, et la fondre dans l'existant
  --feather <N>      texels de fondu au bord de la retouche, défaut 8
";

/// `albedo.exe remesh …`, or `None` when this is an ordinary launch.
///
/// Returns an exit code, and the caller must exit on it before Tauri is built:
/// there is no window here, no webview and no event loop, only geometry.
///
/// This is also the crash boundary the Retopo tab relies on. A malformed mesh
/// that reaches an unchecked index takes this process down and the application
/// carries on, which is the whole reason the release profile can keep
/// `panic = "abort"` and its 4.17 MB.
pub fn cli_main() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(String::as_str);
    if sub != Some("remesh") && sub != Some("bake") {
        return None;
    }
    let baking = sub == Some("bake");
    attach_console();

    let mut input: Option<String> = None;
    let mut second: Option<String> = None;
    let mut output: Option<String> = None;
    let mut req = RemeshRequest::default();
    let mut machine = false;

    let mut i = 1;
    while i < args.len() {
        let take = |i: usize| args.get(i + 1).cloned();
        match args[i].as_str() {
            "--faces" => {
                req.target_triangles = take(i).and_then(|v| v.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "--out" => {
                output = take(i);
                i += 2;
            }
            "--angle" => {
                req.sharp_angle_deg = take(i).and_then(|v| v.parse().ok()).unwrap_or(40.0);
                i += 2;
            }
            "--seam" => {
                req.seam_penalty = take(i).and_then(|v| v.parse().ok()).unwrap_or(4.0);
                i += 2;
            }
            "--open-borders" => {
                req.preserve_boundary = false;
                i += 1;
            }
            "--isotropic" => {
                req.method = "isotropic".into();
                i += 1;
            }
            "--holes" => {
                req.fill_holes = true;
                i += 1;
            }
            "--quads" => {
                req.pair_quads = true;
                i += 1;
            }
            "--no-paint" => {
                req.use_painting = false;
                i += 1;
            }
            "--keep-uv" => {
                req.reuse_uvs = true;
                i += 1;
            }
            "--patch" => {
                req.patch_bake = true;
                i += 1;
            }
            "--feather" => {
                req.patch_feather = take(i).and_then(|v| v.parse().ok()).unwrap_or(8);
                i += 2;
            }
            "--density" => {
                req.density_influence = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.75);
                i += 2;
            }
            "--flow" => {
                req.flow_strength = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.5);
                i += 2;
            }
            "--relax" => {
                req.relax_iterations = take(i).and_then(|v| v.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "--max-error" => {
                req.max_error = take(i).and_then(|v| v.parse().ok()).unwrap_or(f32::INFINITY);
                i += 2;
            }
            "--relax-strength" => {
                req.relax_strength = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.5);
                i += 2;
            }
            "--relax-angle" => {
                req.relax_angle_deg = take(i).and_then(|v| v.parse().ok()).unwrap_or(75.0);
                i += 2;
            }
            "--bake" => {
                req.bake = true;
                i += 1;
            }
            "--uv-size" => {
                req.map_size = take(i).and_then(|v| v.parse().ok()).unwrap_or(2048);
                i += 2;
            }
            "--cage-out" => {
                req.cage_out = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.02);
                i += 2;
            }
            "--cage-in" => {
                req.cage_in = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.02);
                i += 2;
            }
            "--gutter" => {
                req.gutter = take(i).and_then(|v| v.parse().ok()).unwrap_or(4);
                i += 2;
            }
            "--bleed" => {
                req.bleed = take(i).and_then(|v| v.parse().ok()).unwrap_or(8);
                i += 2;
            }
            "--island-angle" => {
                req.island_angle_deg = take(i).and_then(|v| v.parse().ok()).unwrap_or(50.0);
                i += 2;
            }
            "--no-normal" => {
                req.bake_normal = false;
                i += 1;
            }
            "--no-mr" => {
                req.bake_metallic_roughness = false;
                i += 1;
            }
            "--no-emissive" => {
                req.bake_emissive = false;
                i += 1;
            }
            "--ao" => {
                req.bake_ao = true;
                i += 1;
            }
            "--ao-samples" => {
                req.ao_samples = take(i).and_then(|v| v.parse().ok()).unwrap_or(16);
                i += 2;
            }
            "--ao-distance" => {
                req.ao_distance = take(i).and_then(|v| v.parse().ok()).unwrap_or(0.15);
                i += 2;
            }
            // How the tab drives this process: progress as parsable lines and
            // the report as JSON, rather than the prose a person wants.
            "--machine" => {
                machine = true;
                i += 1;
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Some(0);
            }
            other if !other.starts_with('-') && input.is_none() => {
                input = Some(other.to_string());
                i += 1;
            }
            // `bake` takes two: the detail comes from the first, the second
            // receives it.
            other if !other.starts_with('-') && baking && second.is_none() => {
                second = Some(other.to_string());
                i += 1;
            }
            other => {
                eprintln!("option inconnue : {other}\n\n{USAGE}");
                return Some(2);
            }
        }
    }

    let Some(input) = input else {
        eprintln!("{USAGE}");
        return Some(2);
    };
    let input = PathBuf::from(input);
    let output = output.map(PathBuf::from).unwrap_or_else(|| {
        let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned());
        input.with_file_name(format!("{}-retopo.glb", stem.unwrap_or_default()))
    });

    let mut last = -1.0f32;
    let mut progress = |fraction: f32| {
        if !machine {
            return;
        }
        // One line per percent, not one per collapse: a 406k mesh makes hundreds
        // of thousands of calls and a pipe is not free.
        let rounded = (fraction * 100.0).floor();
        if rounded > last {
            last = rounded;
            println!("progress {}", rounded / 100.0);
        }
    };

    let outcome = if baking {
        req.bake = true;
        let Some(low) = second.clone().map(PathBuf::from) else {
            eprintln!("bake attend deux fichiers : la source puis le résultat\n\n{USAGE}");
            return Some(2);
        };
        bake_file(&input, &low, &output, &req, &mut progress)
    } else {
        remesh_file(&input, &output, &req, &mut progress)
    };

    match outcome {
        Ok(r) => {
            if machine {
                println!("report {}", serde_json::to_string(&r).unwrap_or_default());
            } else if baking {
                // No deviation here: nothing was remeshed, so reporting one
                // would be reporting a zero that means "not measured".
                println!(
                    "cuit sur {} triangles en {:.2} s, source à {}",
                    r.output_triangles,
                    r.millis as f64 / 1000.0,
                    r.input_triangles
                );
            } else {
                println!(
                    "{} → {} triangles en {:.2} s, déviation max {:.5}",
                    r.input_triangles,
                    r.output_triangles,
                    r.millis as f64 / 1000.0,
                    r.deviation_max
                );
                if r.holes_filled > 0 || r.holes_left > 0 {
                    println!("trous : {} comblés, {} laissés ouverts", r.holes_filled, r.holes_left);
                }
                if r.aspect_after > 0.0 {
                    println!(
                        "rapport d'aspect moyen : {:.3} → {:.3}",
                        r.aspect_before, r.aspect_after
                    );
                }
                if r.quads > 0 {
                    println!(
                        "quads : {} ({:.0} % de la surface)",
                        r.quads,
                        r.quad_fraction * 100.0
                    );
                }
                if r.charts > 0 {
                    println!(
                        "atlas : {} îlots, {:.0} % occupé, {} touches, {} manques",
                        r.charts,
                        r.utilisation * 100.0,
                        r.hits,
                        r.misses
                    );
                    println!("maps : {}", r.maps.join(", "));
                }
                println!("écrit : {}", output.display());
            }
            Some(0)
        }
        Err(e) => {
            eprintln!("{e}");
            Some(1)
        }
    }
}

/// Borrow the calling terminal's console, so a GUI subsystem binary can answer.
///
/// Without this the executable is silent when run from a shell: it is linked as
/// a windows subsystem application on purpose, so that opening a model never
/// flashes a console behind it. Attaching the parent's console gives the command
/// line its output back without giving the window one.
#[cfg(windows)]
fn attach_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(windows))]
fn attach_console() {}

// --- the tab ---------------------------------------------------------------

/// Where a run's two files live.
///
/// Rust picks the location rather than the frontend, so the webview never needs
/// a path API and the capability set does not have to grow. The directory is one
/// per process: a retopology is worthless once the application is closed, and
/// leaving a numbered pile of GLBs in the user's temp folder is rude.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workdir {
    pub input: String,
    pub output: String,
    /// Where a bake on its own writes, so it never reads and writes one path and
    /// so the viewer is asked for a URL it has not cached.
    pub rebake: String,
}

#[tauri::command]
pub fn retopo_workdir() -> Result<Workdir, String> {
    let dir = std::env::temp_dir().join(format!("albedo-retopo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("dossier de travail impossible: {e}"))?;
    // A run number, because a second bake must not hand the loader a path it has
    // already cached under the same name.
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(Workdir {
        input: dir.join("source.glb").to_string_lossy().into_owned(),
        output: dir.join(format!("result-{n}.glb")).to_string_lossy().into_owned(),
        rebake: dir.join(format!("bake-{n}.glb")).to_string_lossy().into_owned(),
    })
}

/// Append the bake flags, so the two commands cannot describe a bake
/// differently.
fn bake_args(cmd: &mut Command, request: &RemeshRequest) {
    cmd.arg("--bake")
        .arg("--uv-size")
        .arg(request.map_size.to_string())
        .arg("--cage-out")
        .arg(request.cage_out.to_string())
        .arg("--cage-in")
        .arg(request.cage_in.to_string())
        .arg("--gutter")
        .arg(request.gutter.to_string())
        .arg("--bleed")
        .arg(request.bleed.to_string())
        .arg("--island-angle")
        .arg(request.island_angle_deg.to_string());
    if !request.bake_normal {
        cmd.arg("--no-normal");
    }
    if !request.bake_metallic_roughness {
        cmd.arg("--no-mr");
    }
    if !request.bake_emissive {
        cmd.arg("--no-emissive");
    }
    if request.bake_ao {
        cmd.arg("--ao")
            .arg("--ao-samples")
            .arg(request.ao_samples.to_string())
            .arg("--ao-distance")
            .arg(request.ao_distance.to_string());
    }
    /*
     * The engine runs in a child process, so anything the request gained has to
     * be spelled on the command line or it simply does not arrive.
     *
     * This is not theoretical: every field added to `RemeshRequest` since this
     * function existed has had to be added here too, and the failure mode when
     * it is forgotten is a setting that moves in the interface and changes
     * nothing in the result, with no error anywhere.
     */
    if request.patch_bake {
        cmd.arg("--patch").arg("--feather").arg(request.patch_feather.to_string());
    } else if request.reuse_uvs {
        cmd.arg("--keep-uv");
    }
}

/// Drive a child, forward its progress, and hand back what it reported.
/// The child currently running, so it can be killed from another command.
///
/// One run at a time is a deliberate limit, not an oversight: two decimations of
/// the same model racing to write the same file is not a feature anyone asked
/// for, and the front end disables the buttons anyway.
static RUNNING: Mutex<Option<std::process::Child>> = Mutex::new(None);
/// Set by a cancel so the failure that follows can be named as one. Without it a
/// killed child is indistinguishable from a crashed one, and reporting "the
/// engine failed" to someone who just pressed Annuler is a small lie.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// Read one of the files that travel beside a result.
///
/// Three kinds, one reader:
///
/// | kind | written by | one per | meaning |
/// |---|---|---|---|
/// | `quads` | pairing | triangle | bit `k` set means the edge from corner `k` to `k+1` is real; the cleared bit on a paired triangle is the quad's diagonal |
/// | `charts` | the atlas | triangle | which chart the triangle landed in |
/// | `dev` | the BVH | **vertex** | how far the result moved from the source, in model units |
///
/// **Everything comes back as `f32`, including the two integer kinds**, and that
/// is safe rather than sloppy: a quad mask is `0..7` and a chart id is a count of
/// islands, both far below the 2^24 where `f32` stops representing integers
/// exactly. One return type means one command instead of three that differ only
/// in a cast, and the caller feeds all three to the same vertex attribute anyway.
#[tauri::command]
pub fn retopo_sidecar(output: String, kind: String) -> Option<Vec<f32>> {
    let raw = std::fs::read(sidecar(Path::new(&output), &kind)).ok()?;
    if raw.len() % 4 != 0 || raw.is_empty() {
        return None;
    }
    let float = kind == "dev";
    Some(
        raw.chunks_exact(4)
            .map(|c| {
                let b = [c[0], c[1], c[2], c[3]];
                if float {
                    f32::from_le_bytes(b)
                } else {
                    u32::from_le_bytes(b) as f32
                }
            })
            .collect(),
    )
}

/// Stop the run in progress.
///
/// Killing the child is the whole implementation, and that is the point. In
/// process, cancelling a decimation would have meant threading a flag through
/// every inner loop of an engine that does not know this application exists.
/// Here the operating system does it, immediately, and reclaims the memory the
/// run had allocated on the way out.
#[tauri::command]
pub fn retopo_cancel() -> bool {
    let mut slot = RUNNING.lock().unwrap();
    match slot.as_mut() {
        Some(child) => {
            CANCELLED.store(true, Ordering::SeqCst);
            child.kill().is_ok()
        }
        None => false,
    }
}

fn drive(app: &tauri::AppHandle, mut cmd: Command) -> Result<RemeshReport, String> {
    use tauri::Emitter;

    cmd.arg("--machine").stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("lancement impossible: {e}"))?;

    // The pipes come out before the child goes into the shared slot, so reading
    // them never holds the lock a cancel needs.
    let stdout = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    CANCELLED.store(false, Ordering::SeqCst);
    *RUNNING.lock().unwrap() = Some(child);

    // The report arrives on the same pipe as the progress, tagged, so there is
    // one stream to read and no second channel to keep in step.
    let mut report: Option<RemeshReport> = None;
    if let Some(out) = stdout {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("progress ") {
                if let Ok(f) = rest.trim().parse::<f32>() {
                    let _ = app.emit("retopo://progress", f);
                }
            } else if let Some(rest) = line.strip_prefix("report ") {
                report = serde_json::from_str(rest).ok();
            }
        }
    }

    let mut stderr = String::new();
    if let Some(e) = stderr_pipe.as_mut() {
        use std::io::Read;
        let _ = e.read_to_string(&mut stderr);
    }

    // Take it back out and reap it, so a killed child does not linger and the
    // slot is empty before the next run fills it.
    let status = match RUNNING.lock().unwrap().take() {
        Some(mut c) => c.wait().map_err(|e| format!("attente échouée: {e}"))?,
        None => return Err("le processus a disparu".into()),
    };

    if CANCELLED.swap(false, Ordering::SeqCst) {
        return Err("annulé".into());
    }
    match report {
        Some(r) if status.success() => Ok(r),
        _ if !stderr.trim().is_empty() => Err(stderr.trim().to_string()),
        // No message and no report means the child died rather than refused: a
        // panic, a stack overflow or an allocation failure. It took the geometry
        // down with it and left this window alone, which is the entire point of
        // running it over there.
        _ => Err("le moteur a échoué sur ce maillage".into()),
    }
}

/// Reproject a source onto a result that already exists, with no remeshing.
///
/// Baking is its own operation and not a stage of the retopology job, so
/// changing a map size or a cage distance costs a bake rather than a whole
/// decimation.
#[tauri::command]
pub async fn retopo_bake(
    app: tauri::AppHandle,
    high: String,
    low: String,
    output: String,
    request: RemeshRequest,
) -> Result<RemeshReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = std::env::current_exe().map_err(|e| format!("exécutable introuvable: {e}"))?;
        let mut cmd = Command::new(exe);
        cmd.arg("bake").arg(&high).arg(&low).arg("--out").arg(&output);
        bake_args(&mut cmd, &request);
        drive(&app, cmd)
    })
    .await
    .map_err(|e| format!("tâche interrompue: {e}"))?
}

/// Run the engine in a child copy of this executable and report what it said.
#[tauri::command]
pub async fn retopo_decimate(
    app: tauri::AppHandle,
    input: String,
    output: String,
    request: RemeshRequest,
) -> Result<RemeshReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = std::env::current_exe().map_err(|e| format!("exécutable introuvable: {e}"))?;

        let mut cmd = Command::new(exe);
        cmd.arg("remesh")
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .arg("--faces")
            .arg(request.target_triangles.to_string())
            .arg("--angle")
            .arg(request.sharp_angle_deg.to_string())
            .arg("--seam")
            .arg(request.seam_penalty.to_string())
            .arg("--relax")
            .arg(request.relax_iterations.to_string())
            .arg("--relax-angle")
            .arg(request.relax_angle_deg.to_string())
            .arg("--relax-strength")
            .arg(request.relax_strength.to_string());
        // Infinity has no useful spelling on a command line, and its meaning is
        // "no second stop condition", so it is simply left off.
        if request.max_error.is_finite() && request.max_error > 0.0 {
            cmd.arg("--max-error").arg(request.max_error.to_string());
        }
        if !request.preserve_boundary {
            cmd.arg("--open-borders");
        }
        if request.method == "isotropic" {
            cmd.arg("--isotropic");
        }
        if request.fill_holes {
            cmd.arg("--holes");
        }
        if request.pair_quads {
            cmd.arg("--quads");
        }
        /*
         * The painting's own settings, forwarded like everything else.
         *
         * The painting itself is not passed: the child finds it beside the input
         * file on its own. That is the point of the sidecar, a hundred thousand
         * painted points would not fit on a command line, and this is the same
         * arrangement `.quads`, `.dev` and `.charts` already use on the way back.
         */
        if request.use_painting {
            cmd.arg("--density")
                .arg(request.density_influence.to_string())
                .arg("--flow")
                .arg(request.flow_strength.to_string());
        } else {
            cmd.arg("--no-paint");
        }
        if request.bake {
            bake_args(&mut cmd, &request);
        }
        drive(&app, cmd)
    })
    .await
    .map_err(|e| format!("tâche interrompue: {e}"))?
}

/// No console flash behind the window when the child starts.
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}
