//! Attaching this executable to Explorer, and detaching it again.
//!
//! Albedo is the only thing that knows where Albedo is, and it knows it every
//! time it starts. An installer knows it once; a portable executable moves
//! between folders and disks and would leave a registration pointing at a place
//! it no longer occupies. So the application offers to do the attaching itself,
//! and writes its own current path while doing it.
//!
//! Asked for rather than assumed. A program that writes to the registry because
//! it was launched, and leaves the entry behind when its file is deleted, has
//! taken something that was not offered. Both directions are one click, and the
//! one that undoes it is as easy to find as the one that does it.
//!
//! Everything here is HKCU, so none of it needs administrator rights.

use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/provider.rs"));

const KEY: &str = "Software\\Albedo\\Shell";
const CLSID: &str = "{A4E3C1D2-8B57-4F09-9C6E-3D0B2A5F71E4}";

#[derive(serde::Serialize)]
pub struct Integration {
    /// Whether Explorer currently has somewhere to send a 3D file.
    pub registered: bool,
    /// The provider Explorer would load, if any.
    pub provider: Option<String>,
    /// The viewer that provider would run, as recorded.
    pub renderer: Option<String>,
    /// This executable, which is what registering would record.
    pub current: String,
    /// Whether the two agree, so a stale registration can be named as such.
    pub current_is_registered: bool,
    /// Whether this build carries a provider it could install.
    pub available: bool,
}

fn current_exe() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// Where the provider lives, or would.
///
/// Beside the executable when there is one there, which is what an install
/// looks like and what the provider itself searches first. Otherwise a fixed
/// folder of our own, because a portable executable has nowhere it can be sure
/// of writing next to itself and may well be running from read only media.
fn provider_path() -> PathBuf {
    let beside = current_exe().with_file_name("albedo_thumbnails.dll");
    if beside.is_file() {
        return beside;
    }
    extracted_path()
}

fn extracted_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    base.join("Albedo").join("shell").join("albedo_thumbnails.dll")
}

fn registered_provider() -> Option<String> {
    let key = windows_registry::CURRENT_USER
        .open(format!("Software\\Classes\\CLSID\\{CLSID}\\InprocServer32"))
        .ok()?;
    let path = key.get_string("").ok()?;
    Path::new(&path).is_file().then_some(path)
}

#[tauri::command]
pub fn shell_integration() -> Integration {
    let current = current_exe().to_string_lossy().to_string();
    let provider = registered_provider();
    let renderer = windows_registry::CURRENT_USER
        .open(KEY)
        .ok()
        .and_then(|k| k.get_string("Renderer").ok());
    // Beside the provider counts as registered to this executable too: that is
    // how an install is arranged, and it is answered without any recorded path.
    let beside = provider
        .as_deref()
        .map(|p| Path::new(p).with_file_name("albedo.exe"))
        .map(|p| p.is_file() && p == current_exe())
        .unwrap_or(false);
    Integration {
        registered: provider.is_some(),
        current_is_registered: beside || renderer.as_deref() == Some(current.as_str()),
        provider,
        renderer,
        current,
        available: PROVIDER.is_some() || provider_path().is_file(),
    }
}

/// Call one of the provider's own registration entry points.
///
/// Loading it and calling in, rather than spawning regsvr32: the provider is the
/// thing that knows which extensions it serves and what else its class needs,
/// and duplicating that here would be a second list to keep in step with the
/// first. It is a plain library call, so a failure comes back as a value.
fn call_dll(path: &Path, entry: &[u8]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let module = unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())) }
        .map_err(|e| format!("chargement impossible : {e}"))?;
    let proc = unsafe { GetProcAddress(module, PCSTR(entry.as_ptr())) };
    let result = match proc {
        Some(f) => {
            let f: extern "system" fn() -> i32 = unsafe { std::mem::transmute(f) };
            let hr = f();
            if hr >= 0 {
                Ok(())
            } else {
                Err(format!("le fournisseur a repondu 0x{hr:08x}"))
            }
        }
        None => Err("point d'entree introuvable dans la DLL".to_string()),
    };
    unsafe { FreeLibrary(module) }.ok();
    result
}

#[tauri::command]
pub fn shell_integration_enable() -> Result<Integration, String> {
    let target = provider_path();
    if !target.is_file() {
        // Nothing beside us, so this build's own copy is written out
        let bytes = PROVIDER.ok_or("cette version n'embarque pas le fournisseur")?;
        let dir = target.parent().ok_or("dossier introuvable")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{dir:?} : {e}"))?;
        std::fs::write(&target, bytes).map_err(|e| format!("ecriture : {e}"))?;
    }

    call_dll(&target, b"DllRegisterServer\0")?;

    // Written last and always: a portable copy that has moved must not leave
    // Explorer calling the place it used to be.
    let key = windows_registry::CURRENT_USER
        .create(KEY)
        .map_err(|e| format!("cle : {e}"))?;
    key.set_string("Renderer", &current_exe().to_string_lossy())
        .map_err(|e| format!("valeur : {e}"))?;

    Ok(shell_integration())
}

#[tauri::command]
pub fn shell_integration_disable() -> Result<Integration, String> {
    if let Some(path) = registered_provider() {
        call_dll(Path::new(&path), b"DllUnregisterServer\0")?;
    }
    let _ = windows_registry::CURRENT_USER.remove_tree(KEY);
    // Only our own copy is removed. One sitting beside the executable belongs
    // to an installation, and deleting another program's file is not ours to do.
    let extracted = extracted_path();
    if extracted.is_file() && provider_path() == extracted {
        let _ = std::fs::remove_file(&extracted);
    }
    Ok(shell_integration())
}

/// Deliberately outside the key the integration itself uses, because removing
/// the integration removes that one whole: the record of having asked has to
/// outlive the answer, or every launch would ask again.
const MARK: &str = "Software\\Albedo";

fn already_offered() -> bool {
    windows_registry::CURRENT_USER
        .open(MARK)
        .ok()
        .and_then(|k| k.get_u32("ShellOffered").ok())
        .unwrap_or(0)
        == 1
}

fn remember_offered() {
    if let Ok(key) = windows_registry::CURRENT_USER.create(MARK) {
        let _ = key.set_u32("ShellOffered", 1);
    }
}

/// What the first launch does about Explorer, and what every launch after it
/// does not.
///
/// Nothing is asked of someone who installed a 3D viewer and expects to see 3D
/// files. On a machine that has never met Albedo the thumbnails are switched on
/// and said so; after that the question is never raised again, whatever the
/// answer turned out to be.
///
/// That last part is the whole of the design. Switching them off has to be
/// final: a program that restores at every launch what the user removed at the
/// last one is not offering a choice, it is wearing one down. So the fact of
/// having decided is recorded apart from the decision itself, and only a first
/// launch ever writes anything.
///
/// A live registration still has its path refreshed, which costs nothing and is
/// what lets a portable copy be moved without breaking.
pub fn settle_on_startup() -> Option<&'static str> {
    let state = shell_integration();

    if state.registered {
        remember_offered();
        if !state.current_is_registered && state.renderer.is_some() {
            if let Ok(key) = windows_registry::CURRENT_USER.create(KEY) {
                let _ = key.set_string("Renderer", &state.current);
            }
        }
        return None;
    }

    if already_offered() || !state.available {
        return None;
    }

    remember_offered();
    shell_integration_enable().ok().map(|_| "shell-enabled")
}
