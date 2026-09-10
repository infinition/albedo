//! Native desktop registration; Windows keeps its COM implementation.
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(serde::Serialize)]
pub struct Integration {
    pub registered: bool,
    pub provider: Option<String>,
    pub renderer: Option<String>,
    pub current: String,
    pub current_is_registered: bool,
    pub available: bool,
    pub detail: Option<&'static str>,
}

fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}
fn marker() -> Option<PathBuf> {
    Some(crate::paths::config_dir()?.join("shell-offered"))
}
fn remember() -> Result<(), String> {
    let path = marker().ok_or("No configuration directory")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(path, b"1").map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn registration() -> Option<PathBuf> {
    Some(crate::paths::data_dir()?.join("thumbnailers/albedo.thumbnailer"))
}

#[cfg(target_os = "macos")]
fn app_bundle() -> Option<PathBuf> {
    current_exe()
        .ancestors()
        .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

#[tauri::command]
pub fn shell_integration() -> Integration {
    let current = current_exe().to_string_lossy().into_owned();
    #[cfg(target_os = "linux")]
    let (available, registered, provider, detail) = {
        let available = Path::new("/usr/bin/albedo-thumbnailer").is_file();
        let registered = registration()
            .map(|p| {
                std::fs::read_to_string(p).ok().as_deref()
                    == Some(include_str!("../../platform/linux/albedo.thumbnailer"))
            })
            .unwrap_or(false);
        (
            available,
            registered && available,
            Some("/usr/bin/albedo-thumbnailer".into()),
            (!available).then_some("shell.installLinux"),
        )
    };
    #[cfg(target_os = "macos")]
    let (available, registered, provider, detail) = {
        let path = app_bundle().map(|p| p.join("Contents/PlugIns/AlbedoThumbnail.appex"));
        let available = path.as_ref().map(|p| p.is_dir()).unwrap_or(false);
        let output = Command::new("/usr/bin/pluginkit")
            .args(["-m", "-i", "com.infinition.albedo.thumbnail"])
            .output()
            .ok();
        let registered = output
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout).lines().any(|l| {
                    l.contains("com.infinition.albedo.thumbnail")
                        && !l.trim_start().starts_with('-')
                })
            })
            .unwrap_or(false);
        (
            available,
            registered,
            path.map(|p| p.to_string_lossy().into_owned()),
            (!available).then_some("shell.installMac"),
        )
    };
    Integration {
        available,
        registered,
        provider,
        renderer: Some(current.clone()),
        current,
        current_is_registered: available && registered,
        detail,
    }
}

#[cfg(target_os = "macos")]
fn plugin_command(args: &[&str]) -> Result<(), String> {
    let out = Command::new("/usr/bin/pluginkit")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
pub fn shell_integration_enable() -> Result<Integration, String> {
    if !shell_integration().available {
        return Err("Install the native Albedo package to enable desktop thumbnails".into());
    }
    #[cfg(target_os = "linux")]
    {
        let path = registration().ok_or("No data directory")?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(
            path,
            include_bytes!("../../platform/linux/albedo.thumbnailer"),
        )
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let path = app_bundle()
            .ok_or("Run Albedo.app from Applications")?
            .join("Contents/PlugIns/AlbedoThumbnail.appex");
        plugin_command(&["-a", &path.to_string_lossy()])?;
        plugin_command(&["-e", "use", "-i", "com.infinition.albedo.thumbnail"])?;
    }
    remember()?;
    Ok(shell_integration())
}

#[tauri::command]
pub fn shell_integration_disable() -> Result<Integration, String> {
    #[cfg(target_os = "linux")]
    if let Some(path) = registration() {
        // A user may have replaced this file with another provider's settings.
        if std::fs::read_to_string(&path).ok().as_deref()
            == Some(include_str!("../../platform/linux/albedo.thumbnailer"))
        {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    plugin_command(&["-e", "ignore", "-i", "com.infinition.albedo.thumbnail"])?;
    remember()?;
    Ok(shell_integration())
}

#[tauri::command]
pub fn shell_desktop_shortcut() -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("No home directory")?;
    #[cfg(target_os = "macos")]
    {
        let desktop = home.join("Desktop");
        std::os::unix::fs::symlink(
            app_bundle().ok_or("Run Albedo.app from Applications")?,
            desktop.join("Albedo.app"),
        )
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let desktop = Command::new("xdg-user-dir")
            .arg("DESKTOP")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join("Desktop"));
        std::fs::create_dir_all(&desktop).map_err(|e| e.to_string())?;
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(current_exe);
        let escaped = executable
            .to_string_lossy()
            .replace('\\', "\\\\\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
            .replace('%', "%%")
            .replace('\n', "\\n")
            .replace('\r', "\\r");
        let path = desktop.join("Albedo.desktop");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        write!(file, "[Desktop Entry]\nType=Application\nName=Albedo\nExec=\"{escaped}\" %f\nIcon=albedo\nTerminal=false\nCategories=Graphics;3DGraphics;\n").map_err(|e| e.to_string())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn settle_on_startup() -> Option<&'static str> {
    if marker().map(|p| p.exists()).unwrap_or(true) || !shell_integration().available {
        return None;
    }
    shell_integration_enable().ok().map(|_| "shell-enabled")
}
