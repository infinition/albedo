# Albedo

A local 3D asset viewer for Windows. Open a model, look at it properly, inspect
what it is actually made of. No account, no upload, no network round trip.

Built with three.js inside a Tauri shell. The whole application is a 3.7 MB
executable and a 1.5 MB installer.

## Why

Most 3D files on a disk are opaque. The Windows shell shows a generic icon,
online viewers want an upload, and a full DCC application takes a minute to
start just to answer "what is in this file". Albedo opens in under a second,
renders the model faithfully, and tells you what its materials and textures
really contain.

It also reads formats that the usual browser stack refuses: NIF from the
NetImmerse and Gamebryo era, and the binary USD crate that sits inside almost
every USDZ package.

## Formats

Legend: **[x]** loaded from an actual file and measured, **[ ]** implemented but
not yet put in front of one. Rows whose evidence says "generated" were checked
against a file written by `tools/make-samples.mjs`, not one found in the wild:
that proves the format is read and wired, not that every exporter's quirks are
handled.

| Format | Status | Checked with |
| --- | :---: | --- |
| GLB | [x] | Several models, geometry and animation |
| glTF with external `.bin` and textures | [x] | 11 meshes, 109887 triangles, 16 textures |
| glTF `KHR_materials_pbrSpecularGlossiness` | [x] | Alligator demo, diffuse texture bound again |
| FBX | [x] | 2HDragon, 4 materials, 3 clips, 214 bones |
| OBJ with `.mtl` and texture | [x] | Textured cube |
| STL, binary | [x] | Generated tetrahedron |
| USDZ holding a binary crate | [x] | Alligator, 31049 triangles, matches its glTF twin |
| USDC, loose crate | [x] | Same model, same triangle count |
| USDA and ASCII USDZ | [x] | Textured quad |
| NIF, Gamebryo 10.1.0.0 | [x] | 4943 of 4955 files read exactly, rendered with DDS |
| NIF, NetImmerse 4.1 and 4.2 | [x] | 5058 of 5088 files read exactly |
| NIF skeleton files | [x] | 129 bones, helper and animation clip |
| PLY | [x] | Generated cube, ascii and binary little endian, vertex colours |
| DAE (Collada) | [x] | Generated cube, 12 triangles, material bound |
| 3MF | [x] | Generated cube, package with its content types and relations |
| 3DS | [x] | Generated cube, chunked binary, Z up swapped at read |
| VRML | [x] | Generated cube, IndexedFaceSet with per vertex colour |
| VOX | [x] | Generated 6 cube shell, 624 triangles from 152 voxels |
| AMF | [x] | Generated cube, plain XML form |
| PCD, XYZ point clouds | [x] | Generated sphere, 2000 points each, bounds correct |
| KF, KFA animation files | [ ] | Same reader as NIF, no separate sample found |

Formats that are deliberately refused report why: a `.blend` is an internal
Blender file, `.max`, `.ma` and `.mb` are closed formats. Export to glTF.

### NIF

NIF carries no block size table before version 20.2, so a single mis-sized
field silently corrupts everything after it. The reader was therefore measured
against a strict criterion: the file footer has to land exactly on the last
byte.

Result on the Dark Age of Camelot client, 10043 files across four versions:

| Version | Files | Read exactly |
| --- | --- | --- |
| Gamebryo 10.1.0.0 | 4955 | 4943 |
| NetImmerse 4.2.2.0 | 2644 | 2640 |
| NetImmerse 4.2.1.0 | 2194 | 2184 |
| NetImmerse 4.1.0.12 | 250 | 234 |

10001 of 10043, or 99.6 percent. All 10043 build without an exception, for a
total of 19279 meshes, 4.4 million triangles, 5108 animation clips and 264095
bones. Files that stop early still render everything read up to that point.

Node hierarchy, geometry, triangle strips, materials, DDS and TGA textures,
alpha properties, skeletons, keyframe curves and particle systems are all read.
A skeleton file with no geometry shows its bone tree instead of an empty
viewport.

### USD

three.js only reads the ASCII form of USD, and only from inside a `.usdz`
archive. That covers almost nothing in practice, because the standard tools
write the binary crate.

Albedo adds:

- A reader for the `PXR-USDC` crate: LZ4 decompression, the delta and code
  integer encoding OpenUSD uses, the six sections (tokens, strings, fields,
  field sets, paths, specs), and value handles for the types a mesh needs.
- Loose `.usd` and `.usda` files, repackaged in memory with the textures found
  beside them, since the three.js reader only accepts an archive.
- Non PNG textures transcoded, because the archive reader only picks up PNG.
- Both `UsdPreviewSurface` workflows. Half the packages in circulation state
  `glossiness` rather than `roughness`, and reading only the latter left every
  such surface at the default: a rough hide came out with a sheen of reflected
  environment the file never asked for. The same alligator now reports the same
  roughness whether it arrives as glTF, USDZ or FBX.

The crate reader was checked against a model that also exists as glTF: same
alligator, 31049 triangles either way, matching to the triangle.

USD texture coordinates start at the bottom left of the image, which is the
orientation three uses by default. Forcing the glTF convention instead, top left
origin, turns every USD texture upside down; the crate path did that until the
model was looked at closely rather than counted.

## Inspection

Eleven channels, each a flat unlit view of one input: shaded, hand painted,
albedo, normal map, roughness, metalness, ambient occlusion, emissive, alpha,
geometric normals, and a UV checker.

The **PBR / Unlit** toggle sits next to the file name. Hand painted art bakes
its own lighting into the texture, so lighting it again puts a veil over it.
Unlit shows the texture as authored, with no lighting and no tone mapping,
while keeping alpha masks, blending and vertex colours.

A model is rarely all one thing, so the inspector lists its materials and each
one has the same switch. Painted skin can be shown flat while the eyes it
carries stay genuinely shiny. The toggle next to the file name sets the default
for everything and clears the individual choices.

### When a material contradicts itself

Exported files often declare something they cannot deliver, and the result looks
like a broken viewer rather than a broken file. Three contradictions are named
in the material list, each detected from the material alone, so no format and no
file name is involved:

- **Transparency with no source of alpha.** Blending is declared while the alpha
  can never vary: no alpha map, no texture, full opacity. The mask was lost on
  export and the surface draws solid. Nothing can rebuild it, so it is reported
  and can be hidden.
- **Nothing to draw.** Opacity is zero, so the material is invisible. Deliberate
  on helper geometry, otherwise a setting written into the wrong field; the
  usual case is refractive glass, whose opacity is not a coverage.
- **Vertex colours that are entirely zero.** glTF multiplies them into the base
  colour, so a fully textured mesh comes out black. Here the reading is certain,
  since zero can only annihilate, and the attribute is ignored rather than
  obeyed. The material is still flagged: the file remains defective.

Textures that a model references but does not embed are looked for around it.
Formats that name their maps, NIF and USD, are asked by name; the others are
matched against the naming conventions the industry actually uses.

## Thumbnails in Explorer

Albedo registers a shell thumbnail provider, so a folder of models shows the
models instead of a row of generic icons, including for formats Windows has
never heard of.

Three things do the work:

- A COM DLL, `albedo_thumbnails.dll`, implementing `IThumbnailProvider`. It
  renders nothing itself.
- A headless mode of the viewer, `albedo.exe --thumbnail <model> --out <png>`,
  which loads a model in a window that is never shown, renders one square image
  and exits.
- A disk cache under `%LOCALAPPDATA%\Albedo\thumbnails`, keyed on the path, the
  size, the modification time and a render epoch, so an edited model misses the
  cache instead of showing yesterday's picture, and so does every stored image
  when the viewer itself starts drawing differently.

Every format reader lives in the frontend, so the alternative would have been a
second renderer in the DLL, kept in step with the first. Delegating means the
picture Explorer shows is made by the code that draws the application window.
Windows caches thumbnails itself, so the provider is asked once per file and
size; a fresh render measured about a second, a cached one is immediate.

The provider takes the file's path rather than a stream, because half these
formats reference their textures by relative path and the model's bytes alone
are not enough to draw what the model looks like. That is why registration
declares `DisableProcessIsolation`, and why a render that hangs is killed after
twenty seconds and every entry point catches its own panics: the handler runs
inside the host process and must never take it down.

The installer also gives the 3D file types their own icon, a cut out mark rather
than the application's, so a file does not look like a copy of the program. It
only takes effect for extensions the installer owns: an extension associated by
hand through "Open with" keeps the icon Windows chose for it.

Registration is per user, under `HKCU`, so the installer needs no elevation. To
remove it by hand:

```bash
regsvr32 /u "%LOCALAPPDATA%\Programs\Albedo\albedo_thumbnails.dll"
```

## Navigation

Two modes share one camera.

- **Orbit** for inspecting an object.
- **Fly** for walking through a scene, a free camera rather than a rig turning
  around a point. Hold the left button to look, as every DCC application does;
  the cursor hides while you do. `Escape` returns to orbit, aiming the pivot at
  whatever the camera was looking at instead of swinging around wherever the
  flight started. Layout agnostic: physical key codes are read, so ZQSD and
  WASD are the same keys.

  Capturing the pointer would be smoother still, and it is deliberately not
  done: a webview answers a capture with a banner telling the user to press
  Escape, and no page can dismiss it. A permanent notice across a viewer whose
  chrome is otherwise out of the way costs more than the capture is worth.

### Keyboard

Mode keys stay clear of the movement ones, so nothing collides with ZQSD or
WASD on either layout.

| Key | Action |
| --- | --- |
| `O` / `V` | Orbit / fly |
| `Escape` | Back to orbit |
| `G` | Grid |
| `T` | Turntable |
| `F` | Frame the model |
| `Space` | Play or pause, or rise in fly mode |
| `Tab` | Inspector |
| `H` | Hide every overlay |
| `U` | PBR or unlit |
| `W` | Wireframe |
| `R` | Level the horizon |
| `1` to `5` | Inspection channels |
| `F11` | Fullscreen |
| Mouse wheel | Zoom in orbit, travel speed in fly |
| Shift + drag | Swing the key light |
| Ctrl + drag | Open or close the lens |

### Devices

**Xbox controller.** Left stick moves or pans, right stick looks or orbits,
triggers dolly, bumpers rise and fall. Y frames, B switches mode, A plays, the
d-pad cycles channels, R3 levels the horizon. Radial dead zone, so diagonals
stay straight.

**3Dconnexion SpaceMouse** over WebHID, no driver. All six axes in both modes,
roll included: it tilts the horizon in orbit and rolls the camera in fly.
Buttons frame, switch mode and level the horizon. Vendors disagree on which way
each axis points, so every axis has its own inversion toggle in the inspector,
along with separate translation and rotation sensitivity.

## Interface

The model is the interface. Nothing is docked, so the render surface is always
the whole window. The overlays float, stay translucent, and get out of the way:
file name and render mode top left, inspector and fullscreen top right,
navigation bottom left, statistics bottom right, and a timeline at the bottom
centre that only appears when there is an animation to scrub.

The inspector is five panes behind five icons, one on screen at a time: render,
matter, camera, decor, scene. It grew to eight stacked sections and reaching the
stand meant scrolling past the camera. Which pane was open is remembered.

## Building

```bash
npm install
npm run dev          # frontend only, in a browser
npm run tauri dev    # the real shell
npm run tauri build  # release build and NSIS installer
```

`tauri build` also builds the thumbnail provider and puts it beside the
executable, since the installer registers it there.

The installer registers file associations, so "Open with" works for every
supported format.

## Feature checklist

Same legend: **[x]** exercised and measured, **[ ]** written but not yet
confirmed on the real thing.

### Rendering

| Feature | Status | Evidence |
| --- | :---: | --- |
| On demand rendering, idle window costs nothing | [x] | Frame loop only runs on invalidation |
| Generated studio lighting, no HDRI shipped | [x] | RoomEnvironment through PMREM |
| Phong and Lambert converted to PBR | [x] | FBX white veil gone, 4 materials converted |
| Colour space correction | [x] | Base colour sRGB, data maps linear |
| PBR / unlit toggle | [x] | Both buttons drive the channel state |
| Per material PBR / unlit | [x] | Alligator body unlit while its eyes stay PBR |
| Unlit keeps vertex colours | [x] | Carried through on a PLY that has them |
| Unlit keeps alpha and blending | [x] | On a model carrying both a cutout and a blend: alpha test, blending, depth write, side and texture all survive |
| Same materials whatever the container | [x] | The same alligator reports the same roughness and tint as glTF, USDZ and FBX |
| Eleven inspection channels | [x] | Rendered offscreen one by one: 9 distinct images, the two pairs that match being constants on that model |
| Point clouds counted in the statistics | [x] | 2000 points reported for PCD and XYZ, which read as an empty scene before |
| Wireframe, grid, bounding box, skeleton | [x] | Toggles verified |
| Exposure control | [x] | Wired to tone mapping |

### Files and textures

| Feature | Status | Evidence |
| --- | :---: | --- |
| Texture lookup by name for NIF and USD | [x] | DDS 256x512 bound from a distant folder |
| Texture discovery by naming convention | [ ] | Written earlier, not re-measured this round |
| Sibling files under the Tauri asset protocol | [x] | URL rewriting checked on six cases |
| Drag and drop into the window | [x] | Confirmed in use |
| Open with, from the shell | [ ] | Cause found and fixed, needs the new installer to confirm |
| No console window at startup | [x] | PE subsystem reads 2, GUI, in the release binary |
| File associations registered by the installer | [ ] | Declared in the bundle, not yet installed |

### Animation

| Feature | Status | Evidence |
| --- | :---: | --- |
| Playback and pause | [x] | Clock advances, bones move |
| Frame by frame scrubbing | [x] | 214 bones, distinct and reproducible pose at each position |
| Timeline hidden when there is nothing to play | [x] | Including clips of zero length |
| Clip picker when a file holds several | [x] | Three clips on the FBX |

### Navigation

| Feature | Status | Evidence |
| --- | :---: | --- |
| Orbit and fly, layout agnostic keys | [x] | Both modes exercised |
| Xbox controller, sticks and triggers | [x] | Simulated pad, both modes |
| Xbox controller, buttons and dead zone | [x] | One action per press, radial dead zone |
| SpaceMouse HID decoding | [x] | Synthetic reports, split and packed, buttons, dead zone |
| SpaceMouse, six axes onto the camera | [x] | Each axis gives a distinct response in both modes |
| SpaceMouse on real hardware | [ ] | No device available. Axis directions may need the inversion toggles |
| Fullscreen | [ ] | Wired to the Tauri window, not exercised |

### Shell integration

| Feature | Status | Evidence |
| --- | :---: | --- |
| Headless render, `--thumbnail` | [x] | WebGL answers in a window that is never shown; PNG written, model framed and textured |
| Thumbnail fills the frame | [x] | Rendered at twice the size and cropped to the drawn pixels: 94 percent fill on four models of very different shape |
| Provider answers the shell | [x] | Asked through `IShellItemImageFactory` with `ThumbnailOnly`, so a generic icon cannot pass for success |
| USDZ, glTF, DAE, VOX, FBX, NIF through the shell | [x] | About a second for a fresh render, immediate from the cache |
| Cache keyed on path, size and mtime | [x] | Unit tested; entries observed appearing as Explorer browsed a folder |
| Registration by the installer | [ ] | NSIS hook written, registration exercised by hand with `regsvr32`, not yet by an install |

### Still missing

| Feature | Status |
| --- | :---: |
| Asset manager, grid, tree, tags | [ ] not started |
| USD animation and skinning | [ ] not started |
| NIF skinning applied at load | [ ] not started |

## Roadmap

### Done

- [x] Viewer with on demand rendering, so an idle window costs nothing
- [x] Generated studio lighting, no HDRI to ship and no licence to track
- [x] Ten inspection channels, plus a PBR / unlit toggle per model and per material
- [x] Automatic texture discovery, by name and by convention
- [x] Material normalisation, so every format lands on the same PBR footing
- [x] Animation timeline with frame by frame scrubbing
- [x] Orbit and fly navigation
- [x] Xbox controller, all inputs mapped
- [x] SpaceMouse, six axes, both modes, tunable
- [x] NIF reader written from scratch, measured on 10043 files
- [x] USD crate reader written from scratch, checked against a glTF twin
- [x] Specular glossiness materials, which three.js no longer reads
- [x] Sibling file resolution under the Tauri asset protocol
- [x] Shell integration: open with, drag and drop, command line
- [x] No console window, GUI subsystem in every build
- [x] Windows shell thumbnails, rendered by the viewer itself and cached on disk
- [x] Export to glTF, so anything readable becomes portable
- [x] Dimensions, so a file that arrived in the wrong unit says so
- [x] Environment: studio probe, editable gradient or HDR panorama, with what
      lights the model kept separate from what sits behind it
- [x] Settings that outlive the window, in roaming AppData

### Next

- [ ] **Asset manager.** Grid of thumbnails, folder tree, tags and search over
      a library. The thumbnails it would show already exist.
- [ ] Custom lights, with the gizmo the stand already uses.
- [ ] Cross sections, alongside the dimensions already shown.
- [ ] USD animation and skinning. Geometry, transforms and materials are read;
      time samples and blend shapes are not.
- [ ] NIF skinning applied at load, rather than showing the bind pose.

## Layout

```
src/
  main.js              application wiring
  ui/controls.js       overlays, inspector, timeline
  viewer/
    viewer.js          scene host, on demand rendering
    loaders.js         format dispatch
    channels.js        inspection channels
    materials.js       PBR normalisation
    textures.js        texture discovery by convention
    navigation.js      orbit, fly, gamepad, SpaceMouse
    specgloss.js       KHR_materials_pbrSpecularGlossiness
    usd.js             USD packages and loose layers
    usdc/              binary crate reader
    nif/               NetImmerse and Gamebryo reader
src-tauri/             Rust shell, file association, texture search
shell-thumbnails/      IThumbnailProvider DLL, cache, registration
tools/
  make-samples.mjs     writes one sample per format the checklist covers
```
