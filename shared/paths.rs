//! Platform directories, also used by the standalone thumbnail provider.
use std::path::PathBuf;

fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

pub fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        absolute_env("APPDATA").map(|p| p.join("Albedo"))
    }
    #[cfg(target_os = "macos")]
    {
        absolute_env("HOME").map(|p| p.join("Library/Application Support/Albedo"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        absolute_env("XDG_CONFIG_HOME")
            .or_else(|| absolute_env("HOME").map(|p| p.join(".config")))
            .map(|p| p.join("albedo"))
    }
}

pub fn cache_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        absolute_env("LOCALAPPDATA").map(|p| p.join("Albedo"))
    }
    #[cfg(target_os = "macos")]
    {
        absolute_env("HOME").map(|p| p.join("Library/Caches/Albedo"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        absolute_env("XDG_CACHE_HOME")
            .or_else(|| absolute_env("HOME").map(|p| p.join(".cache")))
            .map(|p| p.join("albedo"))
    }
}

#[cfg(target_os = "linux")]
pub fn data_dir() -> Option<PathBuf> {
    absolute_env("XDG_DATA_HOME").or_else(|| absolute_env("HOME").map(|p| p.join(".local/share")))
}
