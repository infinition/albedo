//! Retopology and baking, the Rust half.
//!
//! The engine comes from the plancton crates: quadric error decimation with the
//! link condition, flip test and crease constraints. None of it knows about
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
use std::sync::Mutex;

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
}

impl Default for RemeshRequest {
    fn default() -> Self {
        // Mirrors plancton's own defaults rather than inventing a second set,
        // so a result obtained here and one obtained from its CLI agree.
        Self {
            method: "decimate".into(),
            target_triangles: 0,
            fill_holes: false,
            preserve_boundary: true,
            sharp_angle_deg: 40.0,
            seam_penalty: 4.0,
            relax_iterations: 0,
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
            // model came out with 85 charts where plancton gives 103. Every
            // default in this struct is worth checking against the engine's own
            // instead of guessed, which is the only way a result obtained here
            // and one obtained from plancton's CLI can be compared at all.
            island_angle_deg: 50.0,
            bake_normal: true,
            bake_metallic_roughness: true,
            bake_emissive: true,
            bake_ao: false,
            ao_samples: 16,
            ao_distance: 0.15,
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
}

/// Run the whole pipeline on one GLB and write another. No Tauri in it.
///
/// Shared by the `remesh` subcommand and, later, the HTTP handler, so the doors
/// cannot drift apart. The order is the one plancton settled on: close holes on
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
    let mut mesh = plancton_core::glb::load_bytes(&bytes).map_err(|e| format!("{e:#}"))?;

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
        let fill = plancton_remesh::fill_holes(&mut mesh, &plancton_remesh::FillOptions { max_loop_edges: 5_000 });
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
    let source_bvh = plancton_core::Bvh::build(&mesh);

    // Stage 2: reduce.
    let mut result = match req.method.as_str() {
        "isotropic" => {
            let opts = plancton_remesh::IsotropicOptions {
                target_triangles: req.target_triangles,
                sharp_angle_deg: req.sharp_angle_deg,
                ..Default::default()
            };
            let (m, s) = plancton_remesh::isotropic(&mesh, &opts, &mut |f| progress(r0 + f * (r1 - r0)));
            report.collapses = s.collapses;
            m
        }
        _ => {
            let opts = plancton_remesh::DecimateOptions {
                target_triangles: req.target_triangles,
                preserve_boundary: req.preserve_boundary,
                sharp_angle_deg: req.sharp_angle_deg,
                seam_penalty: req.seam_penalty,
                ..Default::default()
            };
            let (m, s) = plancton_remesh::decimate(&mesh, &opts, &mut |f| progress(r0 + f * (r1 - r0)));
            report.collapses = s.collapses;
            report.rejected_topology = s.rejected_topology;
            report.rejected_flip = s.rejected_flip;
            report.max_error = s.max_error;
            m
        }
    };
    progress(r1);

    // Stage 3: relax, always reprojected. The tangential projection is what
    // stops a sphere deflating a little on every pass.
    if req.relax_iterations > 0 {
        let opts = plancton_remesh::RelaxOptions {
            iterations: req.relax_iterations,
            preserve_features: true,
            sharp_angle_deg: req.relax_angle_deg,
            ..Default::default()
        };
        let s = plancton_remesh::relax(&mut result, Some(&source_bvh), &opts, &mut |f| {
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
        let opts = plancton_remesh::QuadOptions::default();
        let pairing = plancton_remesh::pair_into_quads(&result, &opts);
        report.quads = pairing.stats.quads;
        report.quad_fraction = pairing.stats.quad_fraction;

        let mut raw = Vec::with_capacity(pairing.edge_mask.len() * 4);
        for m in &pairing.edge_mask {
            raw.extend_from_slice(&m.to_le_bytes());
        }
        let _ = std::fs::write(sidecar(output, "quads"), &raw);
    }
    progress(b0);

    // Stage 5: bake. The source is reprojected onto the result and the maps are
    // written into it, so what leaves here is a textured low poly rather than a
    // bare one plus a pile of loose PNGs.
    //
    // Five maps and not one. Baking base colour alone was a real omission and it
    // showed immediately: a gold ring on a wooden handle came back as matte wood,
    // because the whole low poly inherited a single pair of metallic and
    // roughness scalars.
    if req.bake {
        result = run_bake(&result, &mesh, req, &mut report, &mut |f| {
            progress(b0 + f * (b1 - b0))
        })?;
    }

    // How far the result actually moved, per vertex, for the heatmap.
    let dev = plancton_core::wire::deviation_against(&result, &source_bvh);
    report.deviation_max = dev.iter().copied().fold(0.0f32, f32::max);
    let mut raw = Vec::with_capacity(dev.len() * 4);
    for d in &dev {
        raw.extend_from_slice(&d.to_le_bytes());
    }
    let _ = std::fs::write(sidecar(output, "dev"), &raw);

    let out = plancton_core::glb::to_bytes(&result).map_err(|e| format!("{e:#}"))?;
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
    low: &plancton_core::Mesh,
    high: &plancton_core::Mesh,
    req: &RemeshRequest,
    report: &mut RemeshReport,
    progress: &mut dyn FnMut(f32),
) -> Result<plancton_core::Mesh, String> {
    let opts = plancton_bake::BakeOptions {
        atlas: plancton_bake::AtlasOptions {
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
    };
    let baked =
        plancton_bake::bake(low, high, &opts, progress).map_err(|e| format!("bake: {e:#}"))?;

    report.charts = baked.stats.charts;
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

    let hb = std::fs::read(high).map_err(|e| format!("lecture de la source impossible: {e}"))?;
    let lb = std::fs::read(low).map_err(|e| format!("lecture du résultat impossible: {e}"))?;
    let high = plancton_core::glb::load_bytes(&hb).map_err(|e| format!("{e:#}"))?;
    let low = plancton_core::glb::load_bytes(&lb).map_err(|e| format!("{e:#}"))?;

    report.input_triangles = high.triangle_count();
    report.output_triangles = low.triangle_count();

    let baked = run_bake(&low, &high, req, &mut report, progress)?;

    let out = plancton_core::glb::to_bytes(&baked).map_err(|e| format!("{e:#}"))?;
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
            "--relax" => {
                req.relax_iterations = take(i).and_then(|v| v.parse().ok()).unwrap_or(0);
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

/// Read the quad mask that travelled beside a result, if there is one.
///
/// One `u32` per triangle. Bit `k` set means the edge from corner `k` to corner
/// `k+1` is a real edge; the cleared bit on a paired triangle is the quad's
/// diagonal. That is the whole convention, and it is what lets a viewer draw
/// quads out of a triangle soup without the file format ever knowing.
#[tauri::command]
pub fn retopo_quad_mask(output: String) -> Option<Vec<u32>> {
    let raw = std::fs::read(sidecar(Path::new(&output), "quads")).ok()?;
    if raw.len() % 4 != 0 {
        return None;
    }
    Some(
        raw.chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
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
            .arg(request.relax_angle_deg.to_string());
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
