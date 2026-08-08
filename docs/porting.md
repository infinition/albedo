# Porting Albedo beyond Windows

Written while everything here is still Windows only, because the shape of the
problem is clearest before anyone has started. Nothing in this file is a plan
with dates; it is a map of what moves, what does not, and where the real work
is.

## What is already portable

Almost all of it, and not by accident.

Every format reader lives in the frontend, in JavaScript, on top of three.js.
The NIF reader, the USD crate reader, the specular-glossiness conversion, the
texture discovery, the material normalisation, the inspection channels, the
post-processing, the navigation, the asset manager: none of that knows which
operating system it is running on.

The Rust side is thinner than it looks. Library scanning, texture search beside
a model, preference storage and the thumbnail cache are `std::fs` and paths.
They need their directories chosen differently and nothing else.

Most importantly, **the thumbnail renderer is already a command line**:

```
albedo --thumbnail <model> --out <png> --size 512
```

That is the whole of how Explorer gets a picture today. It is also, as it
happens, exactly the interface Linux thumbnailers expect. The hard part of
cross-platform thumbnailing was solved by accident, by refusing to write a
second renderer for the shell.

## What is Windows and will not survive

One file: `src-tauri/src/shell.rs`, and the crate it registers,
`shell-thumbnails/`. Both are COM.

- `IThumbnailProvider` and `IInitializeWithFile`, implemented for the shell
- registration under `HKCU\Software\Classes\CLSID\{...}` and twenty
  `ShellEx` entries, one per extension
- `LoadLibraryW` / `GetProcAddress` to call the provider's own registration
- `%LOCALAPPDATA%` for the extracted provider and the renderer copy

Also Windows-shaped, though less deeply: the NSIS installer and its hooks, the
`.ico` file association icon, and `#![windows_subsystem = "windows"]`.

## The one change to make first

`shell.rs` is declared and called unconditionally in `main.rs`. On any other
target the crate will not compile at all. Two `#[cfg(windows)]` gates fix it:
one on `mod shell;`, one on the startup call and the three commands. Doing this
before the first port attempt turns "nothing builds" into "the shell integration
is absent", which is a much better place to start from.

## Linux

The easiest of the three, and it needs no new code beyond a text file.

The desktop reads `~/.local/share/thumbnailers/*.thumbnailer`, which is an INI
file naming a MIME type and a command:

```ini
[Thumbnailer Entry]
TryExec=albedo
Exec=albedo --thumbnail %i --out %o --size %s
MimeType=model/gltf-binary;model/gltf+json;model/stl;model/obj;
```

`%i %o %s` are the input, the output and the size, which is the interface
Albedo already speaks. The work is therefore: write the file, install it,
declare MIME types for the formats the shared database does not know (glTF and
STL are there, NIF and VOX are not, which means an XML file in
`~/.local/share/mime/packages`), and call `update-mime-database`.

Two things to know before starting. GNOME runs thumbnailers inside a sandbox
with no network and a restricted filesystem, so a renderer that reads textures
from beside the model may find nothing; test with textures in a sibling folder
early. And the WebKitGTK webview Tauri uses on Linux is not the same engine as
WebView2, so the renderer itself needs checking on real files rather than
assumed to behave.

## macOS

The most work, and the only one with a cost attached.

Quick Look is the mechanism, through a **Quick Look Thumbnail Extension**: an
app extension bundled inside `Albedo.app`, declaring the file types it handles
in its `Info.plist`, implementing `QLThumbnailProvider` in Swift or
Objective-C. It cannot be a loose file the way a Linux thumbnailer can, and it
cannot be registered after the fact the way an HKCU key can. It ships inside the
application or it does not exist.

The extension would do what the DLL does: check the cache, and on a miss run
the main executable with `--thumbnail`. Running a sibling binary from inside an
app extension is subject to the sandbox, so this needs verifying before the
design is committed to.

Then there is signing. An unsigned app extension is not loaded by Quick Look at
all, and an unsigned `.app` downloaded from the internet is refused by
Gatekeeper rather than merely warned about, which is stricter than SmartScreen
on Windows. A paid Apple Developer account is not optional here; it is the
entry ticket.

Everything else on macOS is ordinary Tauri: the app bundle, the file
associations in `Info.plist`, and `~/Library/Application Support` in place of
AppData.

## What the abstraction should look like

Not an abstraction yet. Three platforms with three genuinely different
mechanisms do not share an interface worth writing before two of them exist;
inventing one now would be inventing it against a single example.

What is worth keeping is the boundary that already exists: the renderer is a
command line, and the cache is a folder of PNGs keyed on path, size and
modification time. Both are in `shared/thumbcache.rs`, which only needs its
directory chosen per platform. Anything a port adds should sit on that same
line rather than reaching into the viewer.

## Summary

| | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Mechanism | COM `IThumbnailProvider` | `.thumbnailer` file | Quick Look extension |
| Registration | HKCU, by the app itself | a file in the home directory | inside the bundle only |
| New code | done | almost none | a Swift extension |
| Signing needed | no, a warning | no | yes, or nothing loads |
| Portable single file | yes | yes | no, a bundle |
