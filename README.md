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

Legend: **[x]** checked against a real file, **[ ]** implemented but not yet
put in front of one.

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
| PLY | [ ] | three.js loader, vertex colours wired |
| DAE (Collada) | [ ] | three.js loader |
| 3MF | [ ] | three.js loader |
| 3DS | [ ] | three.js loader |
| VRML | [ ] | three.js loader |
| VOX | [ ] | three.js loader |
| AMF | [ ] | three.js loader |
| PCD, XYZ point clouds | [ ] | three.js loaders |
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

The crate reader was checked against a model that also exists as glTF: same
alligator, 31049 triangles either way, matching to the triangle.

## Inspection

Ten channels, each a flat unlit view of one input: shaded, hand painted,
albedo, normal map, roughness, metalness, ambient occlusion, emissive, alpha,
geometric normals, and a UV checker.

The **PBR / Unlit** toggle sits next to the file name. Hand painted art bakes
its own lighting into the texture, so lighting it again puts a veil over it.
Unlit shows the texture as authored, with no lighting and no tone mapping,
while keeping alpha masks, blending and vertex colours.

Textures that a model references but does not embed are looked for around it.
Formats that name their maps, NIF and USD, are asked by name; the others are
matched against the naming conventions the industry actually uses.

## Navigation

Two modes share one camera.

- **Orbit** for inspecting an object.
- **Fly** for walking through a scene. Layout agnostic: physical key codes are
  read, so ZQSD and WASD are the same keys.

### Keyboard

| Key | Action |
| --- | --- |
| `O` / `V` | Orbit / fly |
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

## Building

```bash
npm install
npm run dev          # frontend only, in a browser
npm run tauri dev    # the real shell
npm run tauri build  # release build and NSIS installer
```

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
| Unlit keeps alpha, blending and vertex colours | [ ] | Written, not compared side by side on a masked asset |
| Ten inspection channels | [ ] | Switching verified; per channel output not compared |
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

### Still missing

| Feature | Status |
| --- | :---: |
| Windows shell thumbnails in Explorer | [ ] not started |
| Asset manager, grid, tree, tags | [ ] not started |
| USD animation and skinning | [ ] not started |
| NIF skinning applied at load | [ ] not started |

## Roadmap

### Done

- [x] Viewer with on demand rendering, so an idle window costs nothing
- [x] Generated studio lighting, no HDRI to ship and no licence to track
- [x] Ten inspection channels and a PBR / unlit toggle
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

### Next

- [ ] **Windows shell thumbnails.** Seeing the model in Explorer instead of a
      generic icon. This needs a COM registered `IThumbnailProvider` DLL, a
      headless render path and a disk cache. It is a separate component, not a
      flag to turn on.
- [ ] **Asset manager.** Grid of thumbnails, folder tree, tags and search over
      a library.
- [ ] USD animation and skinning. Geometry, transforms and materials are read;
      time samples and blend shapes are not.
- [ ] NIF skinning applied at load, rather than showing the bind pose.
- [ ] Measurement tools: dimensions, cross sections.
- [ ] Export to glTF, so anything readable becomes portable.

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
```
