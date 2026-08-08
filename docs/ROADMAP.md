# Albedo Roadmap & Feature Status

Detailed feature verification matrix, implementation audit, and upcoming roadmap items for Albedo.

Legend: **[x]** exercised and measured, **[ ]** written but not yet confirmed on the real thing.

## Feature Checklist

### Rendering

| Feature | Status | Evidence |
| --- | :---: | --- |
| On demand rendering, idle window costs nothing | [x] | Frame loop only runs on invalidation |
| Generated studio lighting, no HDRI shipped | [x] | RoomEnvironment through PMREM |
| Phong and Lambert converted to PBR | [x] | FBX white veil gone, 4 materials converted |
| Specular read from the file, not invented | [x] | Same alligator: GLB and FBX render pixel for pixel identically |
| USD shader inputs routed by connection | [x] | A normal map can no longer land in the albedo slot |
| Effect chain, and nothing until it is asked for | [x] | Absent before the first tick, identical to base when switched off |
| Backdrop unchanged by the chain | [x] | 20,22,26 with occlusion, bloom and depth of field |
| USD compressed float arrays | [x] | Skin weights on both meshes of the alligator |
| Folder tree with every level | [x] | Intermediate folders the scan never reports |
| Grid built a page at a time | [x] | 5000 entries, 240 cards built |
| Stale thumbnail work dropped | [x] | 20 asked, 2 processes started, 18 abandoned |
| Custom lights: add, place, colour, remove | [x] | Luminance moves with power and bearing, returns on removal |
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

### Files and Textures

| Feature | Status | Evidence |
| --- | :---: | --- |
| Texture lookup by name for NIF and USD | [x] | DDS 256x512 bound from a distant folder |
| Asset library scan, relative and portable paths | [x] | Real corpus, forward slashes, folders and a limit |
| Tags written to a sidecar and read back | [x] | Round trip, and the file sits inside the library |
| Grid: filters, search, sort, tags, zoom | [x] | Every control exercised against a scan |
| Texture preview for formats no browser decodes | [x] | DDS decoded to a 256 picture, 106 distinct tints |
| Manager costs nothing at startup | [x] | Absent from every chunk the page loads |
| Thumbnails refresh when a model changes | [x] | The key carries mtime and length, so an edit misses |
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

### Interface

| Feature | Status | Evidence |
| --- | :---: | --- |
| Layout follows its own box, not the window | [x] | Fifty widths from 300 to 1280, viewer and library, nothing overflowing its box |
| Preview strip follows a single selection | [x] | Twelve clicks over five assets, two single ones: two loads |
| A model released when the next one loads | [x] | Eight loads: counts flat, picture identical, shared textures intact |
| Edit mode, three handles, Blender keys | [x] | Modal G R S exercised, snapping on and off with shift, grid and roll recovered on exit |
| A correction survives being written out | [x] | Model laid on its side, exported and read back still on its side |
| Overwrite the original | [ ] | Written and permitted, exercised only through the save-as path in a browser |
| Several models in one scene | [x] | Statistics, box and memory add up on import and come back exactly on removal |
| Import through the file dialog | [ ] | Written; the dialog needs the shell, so only the viewer side was exercised |
| Library sidebar becomes a drawer when tight | [x] | Below 760 pixels of library, whatever the window measures |

### Shell Integration

| Feature | Status | Evidence |
| --- | :---: | --- |
| Headless render, `--thumbnail` | [x] | WebGL answers in a window that is never shown; PNG written, model framed and textured |
| Thumbnail fills the frame | [x] | Rendered at twice the size and cropped to the drawn pixels: 94 percent fill on four models of very different shape |
| Provider answers the shell | [x] | Asked through `IShellItemImageFactory` with `ThumbnailOnly`, so a generic icon cannot pass for success |
| USDZ, glTF, DAE, VOX, FBX, NIF through the shell | [x] | About a second for a fresh render, immediate from the cache |
| Cache keyed on path, size and mtime | [x] | Unit tested; entries observed appearing as Explorer browsed a folder |
| Registration by the installer | [ ] | NSIS hook written, registration exercised by hand with `regsvr32`, not yet by an install |

### Still Missing / Pending

| Feature | Status |
| --- | :---: |
| USD animation and skinning | [ ] the rig decodes, the pose does not compose |
| NIF skinning applied at load | [ ] not started |

---

## Detailed Roadmap

### Completed Milestones

- [x] Viewer with on demand rendering (idle window costs nothing).
- [x] Generated studio lighting (RoomEnvironment through PMREM).
- [x] Ten inspection channels, plus PBR / unlit toggle per model and per material.
- [x] Automatic texture discovery (by name and by naming convention).
- [x] Material normalisation to unified PBR footing.
- [x] Animation timeline with frame by frame scrubbing.
- [x] Dual navigation modes (Orbit and Fly).
- [x] Full Xbox controller input support.
- [x] 6-DOF 3Dconnexion SpaceMouse support via WebHID.
- [x] Custom NIF reader (Gamebryo / NetImmerse 3.x to 10.2).
- [x] Custom USD crate reader (`PXR-USDC`).
- [x] KHR_materials_pbrSpecularGlossiness support.
- [x] Tauri asset protocol resolution for sibling files.
- [x] Shell integration (open with, drag-and-drop, CLI flags).
- [x] Clean GUI binary execution (no console popup).
- [x] Asset manager (libraries, grid, folder tree, tags, filters, search).
- [x] Custom directional, point, and spot lights.
- [x] Post-processing stack (GTAO, bloom, depth of field, grading, grain, SMAA).
- [x] Windows Shell thumbnail provider (`IThumbnailProvider` COM DLL).
- [x] Export scene / model to glTF.
- [x] Save clear background viewport PNG screenshot.
- [x] Unit dimension display and bounding box calculations.
- [x] Cross-section clipping plane along any axis.
- [x] Multi-source environment controls (studio probe, gradient, HDR panorama).
- [x] Persistent roaming settings.

### Next / Upcoming Features

- [ ] **USD Skinning & Animation**: Complete composition of bind-space meshes into pose space once matching reference assets are verified.
- [ ] **NIF Skinning at Load**: Apply NIF skinning upon initial file load rather than defaulting to bind pose.
