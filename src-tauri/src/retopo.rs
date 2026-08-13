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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
/// Shared by the `remesh` subcommand and, later, the HTTP handler, so the doors
/// cannot drift apart.
pub fn decimate_file(
    input: &Path,
    output: &Path,
    req: &DecimateRequest,
    progress: &mut dyn FnMut(f32),
) -> Result<DecimateReport, String> {
    let started = std::time::Instant::now();

    let bytes = std::fs::read(input).map_err(|e| format!("lecture impossible: {e}"))?;
    let mesh = plancton_core::glb::load_bytes(&bytes).map_err(|e| format!("{e:#}"))?;

    let source_count = mesh.triangle_count();
    if req.target_triangles == 0 {
        return Err("aucun budget de triangles".into());
    }
    if req.target_triangles >= source_count {
        return Err(format!(
            "le budget ({}) n'est pas inférieur au maillage source ({source_count})",
            req.target_triangles
        ));
    }

    let options = plancton_remesh::DecimateOptions {
        target_triangles: req.target_triangles,
        preserve_boundary: req.preserve_boundary,
        sharp_angle_deg: req.sharp_angle_deg,
        seam_penalty: req.seam_penalty,
        ..Default::default()
    };
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

// --- the command line ------------------------------------------------------

const USAGE: &str = "\
albedo remesh <modèle.glb> --faces <N> [options]

  --faces <N>        budget de triangles (obligatoire)
  --out <fichier>    sortie, par défaut <modèle>-retopo.glb
  --angle <degrés>   angle de pli, défaut 40
  --seam <coût>      coût d'une couture d'UV, défaut 4
  --open-borders     laisser les bords ouverts se faire décimer
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
    if args.first().map(String::as_str) != Some("remesh") {
        return None;
    }
    attach_console();

    let mut input: Option<String> = None;
    let mut output: Option<String> = None;
    let mut req = DecimateRequest::default();
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

    match decimate_file(&input, &output, &req, &mut progress) {
        Ok(report) => {
            if machine {
                println!(
                    "report {}",
                    serde_json::to_string(&report).unwrap_or_default()
                );
            } else {
                println!(
                    "{} → {} triangles en {:.2} s, écart max {:.5}\nécrit : {}",
                    report.input_triangles,
                    report.output_triangles,
                    report.millis as f64 / 1000.0,
                    report.max_error,
                    output.display()
                );
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

/// Run the engine in a child copy of this executable and report what it said.
#[tauri::command]
pub async fn retopo_decimate(
    app: tauri::AppHandle,
    input: String,
    output: String,
    request: DecimateRequest,
) -> Result<DecimateReport, String> {
    use tauri::Emitter;

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
            .arg("--machine")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !request.preserve_boundary {
            cmd.arg("--open-borders");
        }
        no_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("lancement impossible: {e}"))?;

        // The report arrives on the same pipe as the progress, tagged, so there
        // is one stream to read and no second channel to keep in step.
        let mut report: Option<DecimateReport> = None;
        if let Some(out) = child.stdout.take() {
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
        if let Some(mut e) = child.stderr.take() {
            use std::io::Read;
            let _ = e.read_to_string(&mut stderr);
        }
        let status = child.wait().map_err(|e| format!("attente échouée: {e}"))?;

        match report {
            Some(r) if status.success() => Ok(r),
            _ if !stderr.trim().is_empty() => Err(stderr.trim().to_string()),
            // No message and no report means the child died rather than
            // refused: a panic, a stack overflow or an allocation failure. It
            // took the geometry down with it and left this window alone, which
            // is the entire point of running it over there.
            _ => Err("le moteur a échoué sur ce maillage".into()),
        }
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
