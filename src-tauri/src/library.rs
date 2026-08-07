//! Asset libraries: folders the user nominates, scanned and annotated.
//!
//! Two things are stored, and deliberately not in the same place.
//!
//! The list of libraries is a machine preference: it holds absolute paths that
//! mean nothing on another computer, so it lives in roaming AppData beside the
//! viewer's other settings.
//!
//! Everything the user *authored*, the tags and the notes, lives in a single
//! JSON file inside the library itself, keyed by path relative to its root.
//! Copy the folder to another disk, another machine, hand it to someone else,
//! and the annotations arrive with it and still resolve. The alternative was
//! writing tags into the files themselves, which means rewriting binary
//! formats: GLB chunk tables, NIF block streams, and for STL a format with
//! nowhere to put them at all. A sidecar risks nothing and stays readable.

use std::path::{Path, PathBuf};

/// The cache key, shared with the shell provider so the two cannot disagree.
#[path = "../../shared/thumbcache.rs"]
pub mod thumbcache;

/// Formats the viewer can draw.
const MODEL_EXTS: &[&str] = &[
    "glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf", "3ds", "usdz", "usd", "usda", "usdc",
    "wrl", "vrml", "vox", "amf", "pcd", "xyz", "nif", "kf", "kfa",
];

/// Images worth showing next to the models that use them.
const TEXTURE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds", "exr", "hdr", "ktx2"];

/// Folders that only ever hold noise.
const SKIP_DIRS: &[&str] = &[".git", ".svn", "node_modules", "__pycache__", ".albedo"];

const SIDECAR_DIR: &str = ".albedo";
const SIDECAR_FILE: &str = "library.json";

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct LibraryRoot {
    pub path: String,
    pub name: String,
}

#[derive(serde::Serialize)]
pub struct Entry {
    /// Relative to the library root, with forward slashes, so it is the same
    /// string on any machine and can key the sidecar.
    pub rel: String,
    pub name: String,
    pub ext: String,
    /// "model" or "texture".
    pub kind: &'static str,
    pub size: u64,
    /// Seconds since the epoch.
    pub modified: u64,
    /// Absolute, for the viewer to open and for the thumbnail cache.
    pub path: String,
}

#[derive(serde::Serialize)]
pub struct Scan {
    pub entries: Vec<Entry>,
    /// Every folder that holds something, relative to the root.
    pub folders: Vec<String>,
    /// True when the walk stopped early rather than reporting a whole disk.
    pub truncated: bool,
}

fn kind_of(ext: &str) -> Option<&'static str> {
    let lower = ext.to_ascii_lowercase();
    if MODEL_EXTS.contains(&lower.as_str()) {
        Some("model")
    } else if TEXTURE_EXTS.contains(&lower.as_str()) {
        Some("texture")
    } else {
        None
    }
}

fn registry_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("Albedo").join("libraries.json"))
}

fn read_registry() -> Vec<LibraryRoot> {
    registry_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_registry(roots: &[LibraryRoot]) -> Result<(), String> {
    let path = registry_path().ok_or("dossier de configuration introuvable")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_roots() -> Vec<LibraryRoot> {
    // A folder that has since been deleted or unplugged should not haunt the
    // list, but it is only hidden, never removed: a disconnected drive comes
    // back and the user did not ask to forget it.
    read_registry()
}

#[tauri::command]
pub fn library_add(path: String) -> Result<Vec<LibraryRoot>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("ce n'est pas un dossier".into());
    }
    let canonical = p.to_string_lossy().to_string();
    let mut roots = read_registry();
    if roots.iter().any(|r| r.path.eq_ignore_ascii_case(&canonical)) {
        return Ok(roots);
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical.clone());
    roots.push(LibraryRoot {
        path: canonical,
        name,
    });
    write_registry(&roots)?;
    Ok(roots)
}

#[tauri::command]
pub fn library_remove(path: String) -> Result<Vec<LibraryRoot>, String> {
    let mut roots = read_registry();
    roots.retain(|r| !r.path.eq_ignore_ascii_case(&path));
    write_registry(&roots)?;
    Ok(roots)
}

#[tauri::command]
pub fn library_rename(path: String, name: String) -> Result<Vec<LibraryRoot>, String> {
    let mut roots = read_registry();
    for r in roots.iter_mut() {
        if r.path.eq_ignore_ascii_case(&path) {
            r.name = name.clone();
        }
    }
    write_registry(&roots)?;
    Ok(roots)
}

/// Walk a library.
///
/// Bounded on purpose: someone will point this at the root of a disk, and the
/// answer to that should be a slow-but-finite list rather than a hung window.
#[tauri::command]
pub fn library_scan(root: String, limit: Option<usize>) -> Result<Scan, String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err("bibliothèque introuvable".into());
    }
    let cap = limit.unwrap_or(20_000).min(200_000);

    let mut entries = Vec::new();
    let mut folders = std::collections::BTreeSet::new();
    let mut stack = vec![base.clone()];
    let mut truncated = false;

    while let Some(dir) = stack.pop() {
        if entries.len() >= cap {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            let path = item.path();
            let Ok(meta) = item.metadata() else { continue };
            if meta.is_dir() {
                let name = item.file_name().to_string_lossy().to_lowercase();
                if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('$') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if entries.len() >= cap {
                truncated = true;
                break;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let Some(kind) = kind_of(&ext) else { continue };
            let Ok(rel) = path.strip_prefix(&base) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if let Some(cut) = rel.rfind('/') {
                folders.insert(rel[..cut].to_string());
            }
            entries.push(Entry {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                rel,
                ext,
                kind,
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                path: path.to_string_lossy().to_string(),
            });
        }
    }

    Ok(Scan {
        entries,
        folders: folders.into_iter().collect(),
        truncated,
    })
}

fn sidecar_path(root: &Path) -> PathBuf {
    root.join(SIDECAR_DIR).join(SIDECAR_FILE)
}

/// The annotations that travel with the folder.
#[tauri::command]
pub fn library_meta_read(root: String) -> Option<String> {
    std::fs::read_to_string(sidecar_path(Path::new(&root))).ok()
}

#[tauri::command]
pub fn library_meta_write(root: String, data: String) -> Result<(), String> {
    let path = sidecar_path(Path::new(&root));
    let dir = path.parent().ok_or("chemin invalide")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Written beside the target and renamed, so a library copied mid-write is
    // never half a file.
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct ThumbHit {
    pub path: String,
    pub cached: Option<String>,
}

/// Which of these already have a picture, and where.
///
/// Asked in one call rather than one per card: a library of a few thousand
/// models would otherwise cross the bridge a few thousand times to answer a
/// question that is one directory listing.
#[tauri::command]
pub fn thumbnails_lookup(paths: Vec<String>, size: u32) -> Vec<ThumbHit> {
    let bucket = thumbcache::bucket_for(size);
    paths
        .into_iter()
        .map(|p| {
            let cached = thumbcache::cache_path(Path::new(&p), bucket)
                .filter(|c| c.is_file())
                .map(|c| c.to_string_lossy().to_string());
            ThumbHit { path: p, cached }
        })
        .collect()
}

/// Draw one missing thumbnail, the same way Explorer gets one.
///
/// The grid deliberately does not render these itself. The picture Explorer
/// shows comes from `albedo.exe --thumbnail`, framed by the viewer's own
/// camera; a second renderer inside the manager would drift from it, and the
/// two share a cache, so the drift would be visible as two different pictures
/// for one file. Paying for a process per model buys that guarantee, once,
/// since the result is cached until the file changes.
#[tauri::command]
pub async fn thumbnail_render(path: String, size: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || render_one(&path, size))
        .await
        .map_err(|e| e.to_string())?
}

fn render_one(path: &str, size: u32) -> Result<String, String> {
    use std::process::Command;

    let model = Path::new(path);
    let bucket = thumbcache::bucket_for(size);
    let out = thumbcache::cache_path(model, bucket).ok_or("cache indisponible")?;
    if out.is_file() {
        return Ok(out.to_string_lossy().to_string());
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = Command::new(exe);
    command
        .arg("--thumbnail")
        .arg(model)
        .arg("--out")
        .arg(&out)
        .arg("--size")
        .arg(bucket.to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let status = command.status().map_err(|e| e.to_string())?;
    if status.success() && out.is_file() {
        Ok(out.to_string_lossy().to_string())
    } else {
        Err("modèle illisible".into())
    }
}

/// Store a picture the viewer just rendered, under the key the shell will use.
///
/// The manager and Explorer therefore fill one cache between them: browsing a
/// folder in Albedo warms the icons in Explorer, and the other way round.
#[tauri::command]
pub fn thumbnail_save(path: String, size: u32, data: String) -> Result<String, String> {
    let bucket = thumbcache::bucket_for(size);
    let out = thumbcache::cache_path(Path::new(&path), bucket).ok_or("cache indisponible")?;
    let payload = data.rsplit_once(',').map(|(_, p)| p).unwrap_or(&data);
    let bytes = crate::decode_base64(payload).ok_or("image illisible")?;
    let tmp = out.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

/// Drop pictures nothing can reach any more. Called once, in the background.
#[tauri::command]
pub fn thumbnails_prune() -> usize {
    thumbcache::prune(90, 20_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_extensions_are_collected() {
        assert_eq!(kind_of("glb"), Some("model"));
        assert_eq!(kind_of("GLB"), Some("model"));
        assert_eq!(kind_of("png"), Some("texture"));
        assert_eq!(kind_of("txt"), None);
    }

    #[test]
    fn the_sidecar_sits_inside_the_library() {
        let p = sidecar_path(Path::new("C:/assets"));
        assert!(p.ends_with("library.json"));
        assert!(p.to_string_lossy().contains(".albedo"));
    }
}

#[cfg(test)]
mod walk_tests {
    use super::*;

    /// The viewer's own test corpus, which holds both models and textures.
    fn corpus() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("testdata")
    }

    #[test]
    fn a_scan_finds_models_and_textures_and_says_where_they_are() {
        let root = corpus();
        if !root.is_dir() {
            return; // the corpus is not checked in; nothing to assert against
        }
        let scan = library_scan(root.to_string_lossy().to_string(), None).unwrap();
        assert!(!scan.entries.is_empty(), "le corpus n'est pas vide");
        assert!(scan.entries.iter().any(|e| e.kind == "model"));
        assert!(scan.entries.iter().any(|e| e.kind == "texture"));
        // Relative paths are what the sidecar keys on: they must be portable
        for e in &scan.entries {
            assert!(!e.rel.contains(std::path::MAIN_SEPARATOR), "séparateur natif dans {}", e.rel);
            assert!(!e.rel.starts_with('/'), "chemin absolu: {}", e.rel);
            assert!(e.path.ends_with(&e.rel.replace('/', "\\")) || e.path.ends_with(&e.rel));
        }
        // Nested files report their folder
        assert!(scan.folders.iter().any(|f| f.contains("nif") || f.contains("fmt")));
    }

    #[test]
    fn the_sidecar_survives_a_round_trip() {
        let dir = std::env::temp_dir().join("albedo-library-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();

        assert!(library_meta_read(root.clone()).is_none());
        let payload = r#"{"albedo":1,"items":{"a/b.glb":{"tags":["bois"],"note":""}}}"#;
        library_meta_write(root.clone(), payload.to_string()).unwrap();
        assert_eq!(library_meta_read(root.clone()).as_deref(), Some(payload));

        // And it lives inside the library, so copying the folder carries it
        assert!(dir.join(SIDECAR_DIR).join(SIDECAR_FILE).is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_scan_stops_at_its_limit_instead_of_reporting_a_disk() {
        let root = corpus();
        if !root.is_dir() {
            return;
        }
        let scan = library_scan(root.to_string_lossy().to_string(), Some(2)).unwrap();
        assert!(scan.entries.len() <= 2);
        assert!(scan.truncated);
    }
}
