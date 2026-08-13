//! Retopology and baking, the Rust half.
//!
//! The engine comes from the plancton crates: quadric error decimation with the
//! link condition, flip test and crease constraints, plus the isotropic
//! rebuilder, the quad pairing and the cage baker. None of it knows about Tauri
//! or about this application, which is the point: the same functions serve the
//! Retopo tab, the `remesh` command line and the optional HTTP API.
//!
//! **Files, not IPC payloads.** A model worth retopologising is tens of
//! megabytes, and Tauri's default command encoding would turn that into a JSON
//! array of numbers on the way in and again on the way out. The frontend writes
//! its exported GLB to a temporary file, hands over the path, and reads the
//! result back through the loader it already has. Nothing large crosses the
//! bridge.

use std::panic::AssertUnwindSafe;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the caller may set. Everything has a default that works, because the
/// only value a user should be forced to think about is the triangle budget.
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DecimateRequest {
    /// Stop once this many triangles remain.
    pub target_triangles: usize,
    /// Pin open borders in place.
    pub preserve_boundary: bool,
    /// Dihedral angle, in degrees, above which an edge counts as a crease.
    pub sharp_angle_deg: f32,
    /// Extra cost for collapsing across a UV seam or a normal split.
    pub seam_penalty: f32,
}

impl Default for DecimateRequest {
    fn default() -> Self {
        // Mirrors plancton's own defaults rather than inventing a second set,
        // so a result obtained here and one obtained from its CLI agree.
        Self {
            target_triangles: 0,
            preserve_boundary: true,
            sharp_angle_deg: 40.0,
            seam_penalty: 4.0,
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecimateReport {
    pub input_triangles: usize,
    pub output_triangles: usize,
    pub collapses: usize,
    pub rejected_topology: usize,
    pub rejected_flip: usize,
    /// Largest accepted surface displacement, in model units.
    pub max_error: f32,
    pub millis: u128,
}

/// Decimate one GLB into another. The whole engine call, with no Tauri in it.
///
/// Shared by the command, the `remesh` subcommand and the HTTP handler, so the
/// three doors cannot drift apart.
pub fn decimate_file(
    input: &Path,
    output: &Path,
    req: &DecimateRequest,
    progress: &mut dyn FnMut(f32),
) -> Result<DecimateReport, String> {
    let started = std::time::Instant::now();

    let bytes = std::fs::read(input).map_err(|e| format!("lecture impossible: {e}"))?;
    let mesh = plancton_core::glb::load_bytes(&bytes).map_err(|e| format!("{e:#}"))?;

    let mut options = plancton_remesh::DecimateOptions {
        target_triangles: req.target_triangles,
        preserve_boundary: req.preserve_boundary,
        sharp_angle_deg: req.sharp_angle_deg,
        seam_penalty: req.seam_penalty,
        ..Default::default()
    };
    // A target of zero means "no budget given", which would ask the decimator to
    // collapse the model out of existence. Refuse it here rather than let the
    // engine run to nothing.
    if options.target_triangles == 0 {
        return Err("aucun budget de triangles".into());
    }
    let source_count = mesh.triangle_count();
    if options.target_triangles >= source_count {
        return Err(format!(
            "le budget ({}) n'est pas inférieur au maillage source ({source_count})",
            options.target_triangles
        ));
    }
    options.target_triangles = options.target_triangles.min(source_count);

    let (result, stats) = plancton_remesh::decimate(&mesh, &options, progress);

    let out = plancton_core::glb::to_bytes(&result).map_err(|e| format!("{e:#}"))?;
    std::fs::write(output, &out).map_err(|e| format!("écriture impossible: {e}"))?;

    Ok(DecimateReport {
        input_triangles: stats.input_triangles,
        output_triangles: stats.output_triangles,
        collapses: stats.collapses,
        rejected_topology: stats.rejected_topology,
        rejected_flip: stats.rejected_flip,
        max_error: stats.max_error,
        millis: started.elapsed().as_millis(),
    })
}

/// The same call, with a panic turned back into an error.
///
/// The engine is a large amount of geometry code fed by files this application
/// did not write, and a malformed mesh reaching an unchecked index is a real
/// possibility. This executable is also the Explorer thumbnail provider, one
/// process per file, so a panic that escapes does not merely lose a job: it
/// takes out the preview for the folder.
///
/// This boundary only works because the release profile no longer sets
/// `panic = "abort"`. Under `abort` there is no unwind to catch and the process
/// is gone before any of this runs. See `docs/RETOPO.md`.
pub fn decimate_guarded(
    input: &Path,
    output: &Path,
    req: &DecimateRequest,
    progress: &mut dyn FnMut(f32),
) -> Result<DecimateReport, String> {
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        decimate_file(input, output, req, progress)
    })) {
        Ok(result) => result,
        Err(_) => Err("le moteur a échoué sur ce maillage".into()),
    }
}

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
}

#[tauri::command]
pub fn retopo_workdir() -> Result<Workdir, String> {
    let dir = std::env::temp_dir().join(format!("albedo-retopo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("dossier de travail impossible: {e}"))?;
    Ok(Workdir {
        input: dir.join("source.glb").to_string_lossy().into_owned(),
        output: dir.join("result.glb").to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn retopo_decimate(
    app: tauri::AppHandle,
    input: String,
    output: String,
    request: DecimateRequest,
) -> Result<DecimateReport, String> {
    use tauri::Emitter;

    // Geometry is compute bound and holds the thread for seconds at a time. On
    // the async runtime that would stall every other command; on a blocking
    // thread it stalls nothing.
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0f32;
        let mut progress = |fraction: f32| {
            // One event per percent, not one per collapse. A 406k mesh makes
            // hundreds of thousands of calls and the bridge is not free.
            let rounded = (fraction * 100.0).floor();
            if rounded > last {
                last = rounded;
                let _ = app.emit("retopo://progress", rounded / 100.0);
            }
        };
        decimate_guarded(
            Path::new(&input),
            Path::new(&output),
            &request,
            &mut progress,
        )
    })
    .await
    .map_err(|e| format!("tâche interrompue: {e}"))?
}
