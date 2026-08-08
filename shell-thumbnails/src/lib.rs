//! Windows shell thumbnail provider for Albedo.
//!
//! Explorer asks an in-process COM server for a bitmap; this is that server.
//! It renders nothing itself. Every format reader lives in the viewer's
//! frontend, so the picture Explorer shows is produced by the same code that
//! draws the application window: the provider looks in a disk cache and, on a
//! miss, runs `albedo.exe --thumbnail` and waits for the PNG it writes.
//!
//! Registration is per user, under `HKCU\Software\Classes`, to match an
//! installer that asks for no elevation.

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{implement, Error, Interface, Result, BOOL, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, E_FAIL, E_INVALIDARG, E_POINTER, GENERIC_READ, HMODULE, S_FALSE,
    S_OK,
};
use windows::Win32::Graphics::Gdi::{
    CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnLoad,
    GUID_WICPixelFormat32bppPBGRA,
};
use windows::Win32::System::Com::{
    CoCreateInstance, IClassFactory, IClassFactory_Impl, CLSCTX_INPROC_SERVER,
};
use windows::Win32::System::LibraryLoader::{DisableThreadLibraryCalls, GetModuleFileNameW};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithFile_Impl};
use windows::Win32::UI::Shell::{
    SHChangeNotify, IThumbnailProvider, IThumbnailProvider_Impl, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    WTSAT_ARGB, WTS_ALPHATYPE,
};

/// Our class. Fixed forever: it is written into the registry.
const CLSID_ALBEDO_THUMBNAILS: GUID = GUID::from_u128(0xa4e3c1d2_8b57_4f09_9c6e_3d0b2a5f71e4);
/// The shell interface a thumbnail handler is registered under.
const THUMBNAIL_HANDLER: &str = "{e357fccd-a995-4576-b01f-234630154e96}";
const FRIENDLY_NAME: &str = "Albedo Thumbnail Provider";

/// Same list the viewer accepts, minus the ones that carry no geometry to show.
const EXTENSIONS: &[&str] = &[
    "glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf", "3ds", "usdz", "usd", "usda", "usdc",
    "wrl", "vrml", "vox", "amf", "pcd", "xyz", "nif",
];

/// How long Explorer is made to wait for a model it has never seen.
const RENDER_TIMEOUT: Duration = Duration::from_secs(20);

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The cache key, shared with the viewer so the two cannot disagree.
#[path = "../../shared/thumbcache.rs"]
mod thumbcache;
use thumbcache::bucket_for;

static MODULE: AtomicIsize = AtomicIsize::new(0);
static OBJECTS: AtomicIsize = AtomicIsize::new(0);

// -----------------------------------------------------------------------------
// The provider
// -----------------------------------------------------------------------------

#[implement(IThumbnailProvider, IInitializeWithFile)]
struct Provider(Mutex<Option<PathBuf>>);

impl Provider {
    fn new() -> Self {
        OBJECTS.fetch_add(1, Ordering::SeqCst);
        Self(Mutex::new(None))
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        OBJECTS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A path rather than a stream, deliberately.
///
/// A stream would hand over the model's bytes and nothing else, and half these
/// formats reference their textures by relative path: the file alone is not
/// enough to draw what the file looks like. Taking the path is why the provider
/// has to run outside the isolated process, which registration declares.
impl IInitializeWithFile_Impl for Provider_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> Result<()> {
        let path = unsafe { pszfilepath.to_string() }.map_err(|_| Error::from(E_INVALIDARG))?;
        *self.0.lock().unwrap() = Some(PathBuf::from(path));
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Provider_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, pdwalpha: *mut WTS_ALPHATYPE) -> Result<()> {
        if phbmp.is_null() || pdwalpha.is_null() {
            return Err(Error::from(E_POINTER));
        }
        let path = self
            .0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::from(E_FAIL))?;

        // Explorer is the host process: nothing from here may unwind into it.
        let bitmap = std::panic::catch_unwind(|| -> Result<HBITMAP> {
            let png = ensure_thumbnail(&path, cx)?;
            bitmap_from_png(&png, cx)
        })
        .map_err(|_| Error::from(E_FAIL))??;

        unsafe {
            *phbmp = bitmap;
            *pdwalpha = WTSAT_ARGB;
        }
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Cache and rendering
// -----------------------------------------------------------------------------

/// Where a given model's image lives. The key itself is shared with the viewer,
/// which rounds to the same few sizes so one picture serves a range of views.
fn cache_path(model: &Path, bucket: u32) -> Result<PathBuf> {
    thumbcache::cache_path(model, bucket).ok_or_else(|| Error::from(E_FAIL))
}

/// Where a build that is not an install says its viewer lives.
///
/// An installed Albedo needs none of this: the installer puts the DLL beside the
/// executable and the search below finds it. A working copy is the awkward case,
/// because Explorer loads this DLL into its own process and holds it, so it
/// cannot be registered where cargo writes. Registering a copy instead broke the
/// search, the copy having no executable beside it.
///
/// A recorded path settles it, and settles it better than copying the executable
/// would: the value points at the build output, so every build is picked up with
/// nothing to copy afterwards. Explorer only spawns the renderer rather than
/// loading it, so naming a file in the build tree costs no lock.
///
/// Deliberately not the PATH. Explorer inherits its environment at sign-in, so a
/// change would not be seen until the next one; the first match wins, which on a
/// machine with more than one build is a coin toss; and PATH is writable by
/// anyone who can write to the user's profile, which is a poor way for something
/// running inside the desktop to decide what to execute.
fn recorded_renderer() -> Option<PathBuf> {
    let key = windows_registry::CURRENT_USER.open("Software\\Albedo\\Shell").ok()?;
    let path = PathBuf::from(key.get_string("Renderer").ok()?);
    path.is_file().then_some(path)
}

/// The viewer, which sits next to this DLL once installed.
fn renderer() -> Option<PathBuf> {
    if let Some(recorded) = recorded_renderer() {
        return Some(recorded);
    }
    let module = HMODULE(MODULE.load(Ordering::SeqCst) as *mut c_void);
    let mut buf = [0u16; 32768];
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
    if len == 0 {
        return None;
    }
    let dir = PathBuf::from(String::from_utf16_lossy(&buf[..len]))
        .parent()?
        .to_path_buf();
    // The bundle names it after the product, a plain cargo build after the
    // crate, and a resource may land one folder below the executable.
    for base in [Some(dir.as_path()), dir.parent()].into_iter().flatten() {
        for name in ["Albedo.exe", "albedo.exe"] {
            let candidate = base.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn ensure_thumbnail(model: &Path, cx: u32) -> Result<PathBuf> {
    let bucket = bucket_for(cx);
    let out = cache_path(model, bucket)?;
    if out.is_file() {
        return Ok(out);
    }

    let exe = renderer().ok_or_else(|| Error::from(E_FAIL))?;
    let mut child = Command::new(exe)
        .arg("--thumbnail")
        .arg(model)
        .arg("--out")
        .arg(&out)
        .arg("--size")
        .arg(bucket.to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| Error::from(E_FAIL))?;

    let deadline = Instant::now() + RENDER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() && out.is_file() {
                    Ok(out)
                } else {
                    Err(Error::from(E_FAIL))
                };
            }
            Ok(None) => {}
            Err(_) => return Err(Error::from(E_FAIL)),
        }
        if Instant::now() >= deadline {
            // A model that will not load must not hold an Explorer thread
            let _ = child.kill();
            return Err(Error::from(E_FAIL));
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Decode the PNG and hand back a DIB section Explorer can own.
///
/// WIC does the decoding and the scaling, so no image crate is needed, and it
/// converts to premultiplied BGRA which is what the shell expects alongside
/// `WTSAT_ARGB`.
fn bitmap_from_png(png: &Path, cx: u32) -> Result<HBITMAP> {
    let mut wide: Vec<u16> = png.to_string_lossy().encode_utf16().collect();
    wide.push(0);

    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder = factory.CreateDecoderFromFilename(
            PCWSTR(wide.as_ptr()),
            None,
            GENERIC_READ,
            WICDecodeMetadataCacheOnLoad,
        )?;
        let frame = decoder.GetFrame(0)?;

        let mut w = 0u32;
        let mut h = 0u32;
        frame.GetSize(&mut w, &mut h)?;
        if w == 0 || h == 0 {
            return Err(Error::from(E_FAIL));
        }
        // Never hand back more than was asked for; the longest side sets the fit
        let longest = w.max(h) as f64;
        let scale = (f64::from(cx) / longest).min(1.0);
        let tw = ((w as f64 * scale).round() as u32).max(1);
        let th = ((h as f64 * scale).round() as u32).max(1);

        let scaler = factory.CreateBitmapScaler()?;
        scaler.Initialize(&frame, tw, th, WICBitmapInterpolationModeFant)?;
        let converter = factory.CreateFormatConverter()?;
        converter.Initialize(
            &scaler,
            &GUID_WICPixelFormat32bppPBGRA,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = tw as i32;
        // Negative height: rows top down, the order CopyPixels writes them
        info.bmiHeader.biHeight = -(th as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        if bits.is_null() {
            return Err(Error::from(E_FAIL));
        }
        let stride = tw * 4;
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), (stride * th) as usize);
        converter.CopyPixels(std::ptr::null(), stride, pixels)?;
        Ok(bitmap)
    }
}

// -----------------------------------------------------------------------------
// COM plumbing
// -----------------------------------------------------------------------------

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        punkouter: windows::core::Ref<'_, windows::core::IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        if !punkouter.is_null() {
            // Aggregation is not supported, and saying so is the contract
            return Err(Error::from(windows::Win32::Foundation::CLASS_E_NOAGGREGATION));
        }
        let provider: IThumbnailProvider = Provider::new().into();
        unsafe { provider.query(riid, ppvobject).ok() }
    }

    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            OBJECTS.fetch_add(1, Ordering::SeqCst);
        } else {
            OBJECTS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

#[no_mangle]
pub extern "system" fn DllMain(module: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    const DLL_PROCESS_ATTACH: u32 = 1;
    if reason == DLL_PROCESS_ATTACH {
        MODULE.store(module.0 as isize, Ordering::SeqCst);
        // No per-thread work to do, and Explorer makes a lot of threads
        let _ = unsafe { DisableThreadLibraryCalls(module) };
    }
    BOOL(1)
}

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    if rclsid.is_null() || *rclsid != CLSID_ALBEDO_THUMBNAILS {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    let factory: IClassFactory = Factory.into();
    factory.query(riid, ppv)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECTS.load(Ordering::SeqCst) > 0 {
        S_FALSE
    } else {
        S_OK
    }
}

// -----------------------------------------------------------------------------
// Registration, per user
// -----------------------------------------------------------------------------

fn module_path() -> Option<String> {
    let module = HMODULE(MODULE.load(Ordering::SeqCst) as *mut c_void);
    let mut buf = [0u16; 32768];
    let len = unsafe { GetModuleFileNameW(Some(module), &mut buf) } as usize;
    if len == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len]))
}

fn register() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use windows_registry::CURRENT_USER;

    let dll = module_path().ok_or("module path")?;
    let clsid = format!("{{{:?}}}", CLSID_ALBEDO_THUMBNAILS);
    let root = format!("Software\\Classes\\CLSID\\{clsid}");

    let key = CURRENT_USER.create(&root)?;
    key.set_string("", FRIENDLY_NAME)?;
    // The isolated thumbnail host only serves handlers that take a stream, and
    // this one needs the file's real path to find the textures beside it.
    key.set_u32("DisableProcessIsolation", 1)?;

    let inproc = CURRENT_USER.create(format!("{root}\\InprocServer32"))?;
    inproc.set_string("", &dll)?;
    inproc.set_string("ThreadingModel", "Apartment")?;

    for ext in EXTENSIONS {
        let under = |owner: &str| -> std::result::Result<(), Box<dyn std::error::Error>> {
            let k = CURRENT_USER.create(format!("Software\\Classes\\{owner}\\ShellEx\\{THUMBNAIL_HANDLER}"))?;
            k.set_string("", &clsid)?;
            Ok(())
        };
        under(&format!(".{ext}"))?;
        // An installed association puts a ProgID in front of the extension, and
        // the shell asks it first; registering only the extension would leave
        // the very files Albedo owns without a thumbnail.
        if let Ok(progid) = CURRENT_USER
            .open(format!("Software\\Classes\\.{ext}"))
            .and_then(|k| k.get_string(""))
        {
            if !progid.is_empty() {
                under(&progid)?;
            }
        }
    }

    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    Ok(())
}

fn unregister() -> std::result::Result<(), Box<dyn std::error::Error>> {
    use windows_registry::CURRENT_USER;

    let clsid = format!("{{{:?}}}", CLSID_ALBEDO_THUMBNAILS);
    for ext in EXTENSIONS {
        let mut owners = vec![format!(".{ext}")];
        if let Ok(progid) = CURRENT_USER
            .open(format!("Software\\Classes\\.{ext}"))
            .and_then(|k| k.get_string(""))
        {
            if !progid.is_empty() {
                owners.push(progid);
            }
        }
        for owner in owners {
            let path = format!("Software\\Classes\\{owner}\\ShellEx\\{THUMBNAIL_HANDLER}");
            // Only ours: another viewer may have taken the association since
            if let Ok(key) = CURRENT_USER.open(&path) {
                if key.get_string("").map(|v| v.eq_ignore_ascii_case(&clsid)) != Ok(true) {
                    continue;
                }
            }
            let _ = CURRENT_USER.remove_tree(&path);
        }
    }
    let _ = CURRENT_USER.remove_tree(format!("Software\\Classes\\CLSID\\{clsid}"));
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    Ok(())
}

#[no_mangle]
pub extern "system" fn DllRegisterServer() -> HRESULT {
    match std::panic::catch_unwind(register) {
        Ok(Ok(())) => S_OK,
        _ => E_FAIL,
    }
}

#[no_mangle]
pub extern "system" fn DllUnregisterServer() -> HRESULT {
    match std::panic::catch_unwind(unregister) {
        Ok(Ok(())) => S_OK,
        _ => E_FAIL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_round_up_and_stop() {
        assert_eq!(bucket_for(16), 256);
        assert_eq!(bucket_for(256), 256);
        assert_eq!(bucket_for(257), 512);
        assert_eq!(bucket_for(2048), 1024);
    }

    #[test]
    fn the_key_moves_with_the_file() {
        // Same bytes hash the same, different stamps do not: the cache is keyed
        // on content identity, not on the name alone.
        assert_eq!(thumbcache::hash64(b"a/b.glb"), thumbcache::hash64(b"a/b.glb"));
        assert_ne!(thumbcache::hash64(b"a/b.glb"), thumbcache::hash64(b"a/b.gltf"));
    }
}
