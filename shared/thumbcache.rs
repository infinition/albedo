//! The thumbnail cache, shared by the viewer and by the shell provider.
//!
//! Both read and write the same folder, so they have to agree on the key down
//! to the byte: a manager that computed it differently would render pictures
//! Explorer never finds, and re-render everything Explorer had already done.
//! Included by both crates with `#[path]` rather than copied, because a cache
//! key duplicated in two files is a cache key that eventually disagrees.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Bumped whenever the viewer draws differently.
///
/// The cache is keyed on the file, which is right until the renderer itself
/// changes: correcting how USD states roughness, or how bright an environment
/// lights a model, leaves every stored image showing the old answer with no
/// reason to expire. Raising this number retires them all at once.
pub const RENDER_EPOCH: u32 = 2;

/// Explorer asks for arbitrary widths; rounding to three sizes keeps the cache
/// small and lets one picture serve a whole range of views.
pub fn bucket_for(cx: u32) -> u32 {
    match cx {
        0..=256 => 256,
        257..=512 => 512,
        _ => 1024,
    }
}

/// FNV-1a. Not a security hash: it names a cache entry.
pub fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Where every rendered picture lives.
pub fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("Albedo").join("thumbnails"))
}

/// Where a given model's picture lives.
///
/// The key carries the path, the modification time, the length and the render
/// epoch, so an edited model simply misses the cache instead of showing
/// yesterday's picture.
pub fn cache_path(model: &Path, bucket: u32) -> Option<PathBuf> {
    let meta = std::fs::metadata(model).ok()?;
    // Nanoseconds, not seconds: someone iterating on a model saves it several
    // times a minute, and two saves inside the same second that happen to weigh
    // the same would have shared a key and served the older picture back.
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

    let mut key = model.to_string_lossy().to_lowercase().into_bytes();
    key.extend_from_slice(&stamp.to_le_bytes());
    key.extend_from_slice(&meta.len().to_le_bytes());
    key.extend_from_slice(&RENDER_EPOCH.to_le_bytes());

    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{:016x}-{}.png", hash64(&key), bucket)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model being worked on has to show its progress, not its history.
    #[test]
    fn an_edited_model_lands_on_another_key() {
        let dir = std::env::temp_dir().join(format!("albedo-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("piece.glb");

        std::fs::write(&model, b"first").unwrap();
        let before = cache_path(&model, 256).unwrap();

        // Same length on purpose: only the moment of writing differs, which is
        // the case a second-resolution stamp used to miss.
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&model, b"third").unwrap();
        let after = cache_path(&model, 256).unwrap();

        assert_ne!(before, after, "une edition doit changer la cle du cache");

        std::fs::write(&model, b"a much longer body than before").unwrap();
        assert_ne!(after, cache_path(&model, 256).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sizes_round_to_three_buckets() {
        assert_eq!(bucket_for(16), 256);
        assert_eq!(bucket_for(257), 512);
        assert_eq!(bucket_for(4096), 1024);
    }
}

/// Drop pictures nothing can reach any more.
///
/// Every edit to a model leaves its previous picture behind under a key nobody
/// will ask for again. Without this the folder only ever grows.
pub fn prune(max_age_days: u64, budget: usize) -> usize {
    let Some(dir) = cache_dir() else { return 0 };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_days * 86_400));
    let Some(cutoff) = cutoff else { return 0 };

    let mut removed = 0;
    for entry in entries.flatten().take(budget) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        // Access time would be the right signal, but Windows does not update it
        // by default; the last write is the next best thing.
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}
