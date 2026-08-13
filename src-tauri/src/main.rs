// Prevents an extra console window on Windows in release
// No console window, ever: the app is a GUI even in debug builds
#![windows_subsystem = "windows"]

mod library;
mod retopo;
mod shell;

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

/// A headless render asked for on the command line.
///
/// `albedo.exe --thumbnail <model> --out <png> [--size 512]` loads a model in a
/// window that is never shown, renders one square image and exits. The shell
/// thumbnail provider drives this: every format reader lives in the frontend,
/// so the picture Explorer gets is made by the same code that draws the viewer,
/// not by a second renderer that would have to be kept in step.
struct ThumbJob {
    model: String,
    out: PathBuf,
    size: u32,
}

fn thumb_job() -> Option<&'static ThumbJob> {
    static JOB: OnceLock<Option<ThumbJob>> = OnceLock::new();
    JOB.get_or_init(parse_thumb_job).as_ref()
}

fn parse_thumb_job() -> Option<ThumbJob> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut model = None;
    let mut out = None;
    let mut size = 512u32;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--thumbnail" => {
                model = args.get(i + 1).cloned();
                i += 2;
            }
            "--out" => {
                out = args.get(i + 1).cloned();
                i += 2;
            }
            "--size" => {
                size = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(size);
                i += 2;
            }
            _ => i += 1,
        }
    }
    Some(ThumbJob {
        model: model?,
        out: PathBuf::from(out?),
        // Explorer asks for a size; anything outside this range is a mistake
        size: size.clamp(32, 2048),
    })
}

/// Never leave a headless process behind: a model that hangs the loader would
/// otherwise sit in memory with no window to close.
fn spawn_watchdog(seconds: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        std::process::exit(EXIT_TIMEOUT);
    });
}

const EXIT_TIMEOUT: i32 = 2;
const EXIT_FAILED: i32 = 3;

fn b64_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode the payload of a data URL. The canvas hands back base64 and pulling
/// in a crate to read forty lines of it would be its own kind of cost.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for &c in text.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = b64_value(c) else {
            if c.is_ascii_whitespace() {
                continue;
            }
            return None;
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[derive(serde::Serialize)]
struct ThumbRequest {
    path: String,
    size: u32,
}

/// What the frontend asks for on startup: a job, or nothing and a normal run.
#[tauri::command]
fn thumbnail_job() -> Option<ThumbRequest> {
    thumb_job().map(|j| ThumbRequest {
        path: j.model.clone(),
        size: j.size,
    })
}

/// Take the rendered image and stop. Writing beside the target and renaming
/// means the provider never picks up a half written file.
#[tauri::command]
fn write_thumbnail(data: String) -> Result<(), String> {
    let job = thumb_job().ok_or("aucune miniature demandée")?;
    let payload = data.rsplit_once(',').map(|(_, p)| p).unwrap_or(&data);
    let bytes = decode_base64(payload).ok_or("image illisible")?;
    if let Some(dir) = job.out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = job.out.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &job.out).map_err(|e| e.to_string())?;
    std::process::exit(0);
}

/// The model could not be read: say so through the exit code, since a headless
/// process has nowhere to print.
#[tauri::command]
fn thumbnail_failed(_message: String) {
    std::process::exit(EXIT_FAILED);
}

/// Where the viewer's own settings live.
///
/// Roaming AppData, next to what every other desktop application writes there,
/// and deliberately not beside the executable: a portable copy on a read only
/// share must still start.
fn prefs_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("Albedo").join("settings.json"))
}

/// The frontend owns the schema; this only carries the bytes.
#[tauri::command]
fn load_prefs() -> Option<String> {
    std::fs::read_to_string(prefs_path()?).ok()
}

#[tauri::command]
fn save_prefs(data: String) -> Result<(), String> {
    let path = prefs_path().ok_or("aucun dossier de configuration")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Written beside the target then renamed, so a crash mid-save cannot leave
    // a half written file that the next launch would refuse to read.
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

const MODEL_EXTS: &[&str] = &[
    "glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf", "3ds", "usdz",
    "wrl", "vrml", "vox", "amf", "pcd", "xyz", "nif", "kf", "kfa",
];

/// Path handed over by the shell ("Open with…"), if any.
///
/// Any existing file is passed through rather than filtered against the list
/// above. The frontend is what actually knows the readable formats, and
/// keeping a second list here only produced files that opened when dropped on
/// the window but not when opened from the shell. An unreadable file now gets
/// a real error message instead of silence.
fn cli_model_path() -> Option<String> {
    std::env::args().skip(1).find_map(|arg| {
        if arg.starts_with('-') {
            return None;
        }
        let p = PathBuf::from(&arg);
        if p.is_file() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    })
}

#[tauri::command]
fn startup_file() -> Option<String> {
    // A thumbnail run carries its model behind a flag, and the viewer must not
    // treat it as a file to open in a window nobody will see.
    if thumb_job().is_some() {
        return None;
    }
    cli_model_path()
}

/// Formats the viewer accepts, so the frontend and the shell stay in sync.
#[tauri::command]
fn supported_extensions() -> Vec<String> {
    MODEL_EXTS.iter().map(|s| s.to_string()).collect()
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds"];

/// Folders artists actually drop their maps into, next to or under the model.
const TEXTURE_DIRS: &[&str] = &[
    "textures", "texture", "tex", "maps", "map", "materials", "material",
    "images", "img", "source", "textures_unscrambled",
];

#[derive(serde::Serialize)]
struct TexEntry {
    name: String,
    path: String,
}

fn collect_images(dir: &std::path::Path, out: &mut Vec<TexEntry>, limit: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        out.push(TexEntry {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
        });
    }
}

/// Images sitting next to a model: same folder, usual sub-folders, and the
/// sibling texture folder one level up.
#[tauri::command]
fn scan_textures(model_path: String) -> Vec<TexEntry> {
    let mut out = Vec::new();
    let model = std::path::PathBuf::from(&model_path);
    let Some(dir) = model.parent() else {
        return out;
    };

    collect_images(dir, &mut out, 400);
    for name in TEXTURE_DIRS {
        collect_images(&dir.join(name), &mut out, 400);
    }
    if let Some(parent) = dir.parent() {
        for name in TEXTURE_DIRS {
            collect_images(&parent.join(name), &mut out, 400);
        }
    }
    out
}

/// Look for specific texture file names around a model.
///
/// Formats that name their maps (NIF is the one that matters here) point at a
/// shared folder that can sit well away from the model: a game keeps every skin
/// in one place while the meshes live in per-part directories. Walking up a few
/// levels and searching those subtrees finds them, and since the wanted names
/// are known the search stops as soon as they are all accounted for.
#[tauri::command]
fn find_textures(model_path: String, names: Vec<String>) -> Vec<TexEntry> {
    use std::collections::HashMap;

    let mut wanted: HashMap<String, Option<String>> = names
        .iter()
        .map(|n| (n.to_lowercase(), None))
        .collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    // Names are also matched without their extension: a mesh may ask for a .dds
    // while the loose file on disk is the original .tga.
    let stems: HashMap<String, String> = wanted
        .keys()
        .map(|n| (n.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| n.clone()), n.clone()))
        .collect();

    let model = std::path::PathBuf::from(&model_path);
    let Some(start) = model.parent() else {
        return Vec::new();
    };

    // Budget rather than depth alone: one bad ancestor should not walk a disk.
    let mut budget = 40_000usize;
    let mut roots: Vec<std::path::PathBuf> = vec![start.to_path_buf()];
    let mut up = start;
    for _ in 0..3 {
        match up.parent() {
            Some(p) => {
                roots.push(p.to_path_buf());
                up = p;
            }
            None => break,
        }
    }

    let mut missing = wanted.len();
    for root in roots {
        if missing == 0 || budget == 0 {
            break;
        }
        let mut stack = vec![(root, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if missing == 0 || budget == 0 || depth > 4 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if budget == 0 {
                    break;
                }
                budget -= 1;
                let path = entry.path();
                if path.is_dir() {
                    stack.push((path, depth + 1));
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let lower = file_name.to_lowercase();
                let key = if wanted.contains_key(&lower) {
                    Some(lower.clone())
                } else {
                    lower
                        .rsplit_once('.')
                        .and_then(|(s, _)| stems.get(s))
                        .cloned()
                };
                let Some(key) = key else { continue };
                if let Some(slot) = wanted.get_mut(&key) {
                    if slot.is_none() {
                        *slot = Some(path.to_string_lossy().to_string());
                        missing -= 1;
                    }
                }
            }
        }
    }

    wanted
        .into_iter()
        .filter_map(|(name, path)| {
            path.map(|path| TexEntry {
                name: std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or(name),
                path,
            })
        })
        .collect()
}

fn main() {
    let headless = thumb_job().is_some();
    if headless {
        // Generous: a first run pays for the webview starting up, and a heavy
        // model still has to be read from a cold disk.
        spawn_watchdog(45);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            library::library_roots,
            library::library_add,
            library::library_remove,
            library::library_rename,
            library::library_scan,
            library::library_meta_read,
            library::library_meta_write,
            library::thumbnails_lookup,
            library::thumbnail_save,
            library::thumbnail_render,
            library::thumbnails_prune,
            retopo::retopo_workdir,
            retopo::retopo_decimate,
            startup_file,
            supported_extensions,
            scan_textures,
            find_textures,
            thumbnail_job,
            write_thumbnail,
            thumbnail_failed,
            load_prefs,
            save_prefs,
            shell::shell_integration,
            shell::shell_integration_enable,
            shell::shell_integration_disable
        ])
        .setup(move |app| {
            // The window is declared hidden so a thumbnail render never flashes
            // on screen; a normal run shows it as soon as the shell is up.
            if !headless {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
                // A portable copy that has been moved would otherwise leave
                // Explorer calling the folder it used to sit in. Silent, and a
                // no-op unless the integration is on and the path has gone stale.
                //
                // On a thread of its own, because this is a viewer: it is opened
                // by double clicking a file and has to be on screen before anyone
                // has finished reading its name. Two registry reads and a couple
                // of file checks are unlikely to be felt, but nothing that can be
                // done later has any business being done before the first frame,
                // and Explorer will not ask for a thumbnail in the meantime.
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    if shell::settle_on_startup().is_some() {
                        // Said out loud, because something was written on the
                        // user's behalf and they are entitled to know which.
                        let _ = app.emit("shell-enabled", ());
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Albedo");
}
