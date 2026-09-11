# Desktop platforms

The source now selects native backends and Tauri packaging for Windows, macOS
and Linux. `release.yml` builds all three, runs Rust/JavaScript regressions and
actual PNG rendering checks, then publishes only if every build succeeds.
Pull requests and manual runs produce downloadable artifacts without a release.

## Installation

| System | Package | File-manager thumbnails |
| --- | --- | --- |
| Windows x64 | Portable EXE/ZIP or NSIS installer | Embedded COM provider; enabled on first ordinary launch, removable in Object settings |
| macOS 12+ Intel / Apple Silicon | Universal `Albedo.app` in DMG | `Contents/PlugIns/AlbedoThumbnail.appex`, registered with Quick Look; serves only the formats macOS itself has no type for (see below) |
| Linux x64 | `.deb` / `.rpm` | WebKitGTK/Python helper installed in `/usr`; registration in the user's thumbnailers directory on first ordinary launch |
| Linux x64 | AppImage | Viewer and library thumbnails; install a native package for desktop thumbnails |

On macOS, move the complete application into Applications before launching it.
Enable the Albedo thumbnail extension in System Settings if macOS requires it.

Quick Look hands a file to Apple's own SceneKit thumbnail extension whenever its
type conforms to `public.3d-content`, and system extensions take precedence over
third-party ones. macOS declares such types for `glb`, `gltf`, `fbx`, `obj`,
`stl`, `ply`, `dae` and `usd*`, so Finder never asks Albedo for those: what
SceneKit can read (USDZ, OBJ, STL, DAE) gets Apple's rendering, and what it
cannot (GLB, glTF, FBX) gets a generic icon. Albedo's own types (`3mf`, `3ds`,
`vox`, `amf`, `pcd`, `xyz`, `nif`, `kf`, `kfa`, `wrl`, `vrml`) are declared
without that conformance on purpose; they are the ones the extension renders.
The default workflow uses ad-hoc signatures, not Apple notarization. Public
Developer ID distribution requires the maintainer's signing credentials and
notarization setup; this change does not create or install credentials. Local
builds can supply `APPLE_SIGNING_IDENTITY`; the extension and containing app must
use the same identity. Keep the extension inside the app when distributing it.

Linux native packages install WebKitGTK 4.1, Python GI, Xvfb, xauth and Mesa.
The helper uses a private virtual display and software GL, including on Wayland
desktops. It does not need a visible Albedo window. Nautilus/Thunar and recent
KIO versions consume `.thumbnailer` registrations; enable previews in the file
manager and allow its model-size limit. Older KDE versions need a newer KIO.
The AppImage mount is not a stable executable location inside file-manager
sandboxes, so desktop registration deliberately requires the native package.

## Shared rendering and permissions

`src/viewer/thumbnail.js` is the renderer used by Explorer's application process,
Quick Look's WKWebView and Linux's WebKitGTK host. It shares the regular viewer's
format readers, material normalization, lighting, texture matching and snapshot
code. Draco and Basis/KTX2 decoder assets ship locally; no CDN is required.
The small `thumbnail.html` entry has no editor IPC and permits no remote requests.

Native thumbnail hosts serve only their packaged assets and the requested
model's directory, with canonical-path checks against traversal. The operating
system's sandbox remains authoritative: Quick Look and GNOME may grant only the
selected file. A GLB/USDZ with embedded resources works within that grant;
external `.gltf` buffers or texture libraries may be inaccessible. In the full
application, ordinary file access and sibling resolution remain available.
The same supported-format list does not override those OS permissions or ensure
identical pixels across GPU/WebKit versions.

All hosts have bounded render deadlines. Linux also terminates the process group
after 50 seconds. A failed load reports failure instead of leaving a process or
publishing a partial PNG. Existing cached thumbnails are invalidated by render
epoch 4.

## Building

Install Node.js, stable Rust and the native Tauri prerequisites for the host.
Windows additionally needs the MSVC toolchain and WebView2. macOS needs Xcode
command-line tools. Linux build dependencies are listed explicitly in the workflow.

```sh
npm ci
npm run tauri build
```

For a universal Mac build, also install both Rust targets, then use:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
APPLE_SIGNING_IDENTITY=- npm run tauri build -- --target universal-apple-darwin
```

`build:all` builds the frontend before the native thumbnail provider. Windows
embeds the COM DLL; macOS compiles the Swift extension using the installed SDK;
Linux packages the WebKit host. Platform-specific `tauri.*.conf.json` files keep
Windows resources out of Unix packages. Metadata is generated from the common
file-association extensions by `scripts/platform-metadata.mjs`.

Preferences and libraries use AppData on Windows, Application Support on macOS,
and `XDG_CONFIG_HOME` (or `~/.config`) on Linux. Thumbnail caches use the matching
platform cache directory. Unix cache keys retain filename case. macOS receives
Finder document-open events and supports Command shortcuts.

## Validation status

Locally verified on Windows: 138 Rust tests, 4 JavaScript tests, 3 native metadata
and path tests, production Tauri compilation, and real 256px PNG generation for
GLB, external-buffer glTF (including spaces in paths), and OBJ. The committed CI
also checks macOS universal architectures, signatures, CLI rendering and Quick
Look rendering, and Linux native-helper/CLI rendering.

Verified on macOS 26 (Apple Silicon): the Quick Look extension built by
`platform/macos/build.py` renders a 3MF through `QLThumbnailGenerator` (the path
Finder uses; `qlmanage -t` does not reach modern extensions, which is why the
smoke test compiles `platform/macos/qlthumb.swift` instead). The Linux native
job has **not been executed from this workspace**. Its results, and interactive
Finder/Nautilus/Dolphin behavior, remain validation work on those operating
systems. The workflow must pass before
a release can be published; source/configuration checks alone are not evidence
that a native extension loads successfully.

## Implementation references

- [Tauri platform configuration](https://v2.tauri.app/reference/config/)
- [Tauri macOS bundle files](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Apple thumbnail extensions](https://developer.apple.com/documentation/quicklookthumbnailing/providing-thumbnails-of-your-custom-file-types)
- [WebKitGTK custom URI schemes](https://webkitgtk.org/reference/webkit2gtk/stable/method.WebContext.register_uri_scheme.html)
- [KIO thumbnailer support, by its implementer](https://akselmo.dev/posts/kio-thumbnailer-support/)
