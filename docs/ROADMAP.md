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
| One toolbar, shared by every mode | [x] | Retopo opened and closed: the bar keeps its four groups, gains Scène and the counters, and hands them back. 23 buttons clicked in sequence, no error |
| Couleur says the same thing in both modes | [x] | One plate of icons, one set of names. `unlit` and "Handpainted" were the same channel under two names and are now one entry |
| Gizmo reachable over the model | [x] | Three relays into `setEditMode`; the pane's four buttons, the bar's three and the G R S keys all repaint together |
| Retopo stays a lazy chunk after the merge | [x] | 7 chunks and 720,060 bytes at startup, 16 bytes more than before the merge. The mode's own chunk went from 38,001 to 36,133 bytes |
| The view bar tucks itself away | [x] | Fifteen seconds of quiet, five seconds to leave, an eighth of a second to come back. Measured with the transition cut, see the pitfall below |
| Full screen hides every overlay | [ ] | Written and checked in the preview; the Tauri window call itself is not exercised |
| Panel flush with the right edge | [x] | 8 pixels from the window edge at 1280, with and without the library |
| Canvas stops at the library, not under it | [x] | Stage left edge lands exactly on the library's right edge at a 800 pixel split |
| Scrubber clear of the Retopo action bar | [x] | Lifted by the bar's own measured height, so it survives the bar wrapping |
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
| The whole interface batch, in the compiled application | [ ] `npx tauri build --no-bundle` green, `albedo.exe` built and started; the walk of the four groups, both modes, the library split and full screen is in progress |
| Shell initialisation behind a top level `await` | [ ] `src/main.js` awaited two shell round trips at module scope. Both now live behind a deferred `shellReady`: every listener attaches at once, and `prefs`, the drag-and-drop, the thumbnail job and the startup file each wait on that promise alone. `wireHud` reads the shell handle through a getter at click time. Builds green, nothing measured in the compiled app yet |

### Faults Found and Fixed This Round

Recorded because each was invisible in a different way, and the way it was
invisible is the reusable part.

| Fault | How it hid |
| --- | --- |
| Every button in the application dead | `applyChannel` reached for `#mode-pbr`, deleted from the markup several commits earlier. Reading a property of null at module scope stops the module: nothing below that line was ever attached. Clicking every button in the page reports nothing, because a button with no listener throws nothing. One red line in the console, on the first load |
| Flat shading did nothing | Two identical listeners on one button. The first turned it on and wrote the pressed state, the second read what the first had just written and turned it back off. No error, no visible change |
| A dead band down the right edge | `#inspector` is a child of `#stage`, so shrinking the stage to stop the canvas at the panel moved the panel left by the same amount |
| The canvas drawn behind the library | Same cause, other axis: the preview strip is width plus a right anchor, and the panel moved the anchor without narrowing the width |
| The Scène comparison buttons in the bar did nothing | The group lives in a detached `held` div until the mode opens and moves to the shared bar as the same nodes. The listener loop queried `host` (`#retopo`), which never contains them, so no listener ever attached. A button with no listener throws nothing, and the active highlight would have had to re-find the buttons in the bar at click time either way |
| "Fil de fer seul" vanished on every channel but the one it was clicked on | The button wrote `material.wireframe` on the materials then current. A channel change handed out fresh stand-ins with the property at its default, so the lines reappeared only when the original surfaced again. The state now lives in the overlay as a uniform, where the channel system cannot lose it, and it takes the same light or dark colour as the overlay |
| The before/after curtain sat right of the slider | The shader cuts at a fraction across the canvas; the line was positioned at a fraction of its own box, `#retopo`, which spans the whole app. The moment the library took half the screen, the canvas stopped at it and the two fractions stopped meaning the same thing. The line is now placed in pixels, translated from the canvas box into its own |

### Measurement Pitfalls, Verified

- **CSS transitions do not advance in the automation panel.** It composes no
  frames, so an animated property keeps its starting value indefinitely.
  `getComputedStyle` on `transform` or `opacity` right after a class change
  reports the old value for ever, and a working drawer was reverted on that
  reading. Measure something that does not animate, such as `pointer-events`, or
  set `transition: none` before reading.
- **A browser preview proves nothing about the shell paths.** `tauri` is null
  there, so every `if (tauri)` block is skipped.
- **`onOpenChange` swallows its errors.** A change to it stopped `#retopo`
  mounting with nothing in the console. Check `document.getElementById("retopo")`
  after opening the mode.

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
- [x] One toolbar over the viewport, shared by every mode, that Retopo adds
      groups to instead of replacing. Colour, layers, gizmo and camera in one
      place, in one visual language, whichever mode is open.
- [x] Chrome that gets out of the way: a bar that tucks itself after fifteen
      seconds, and a full screen that hides every overlay with a corner to come
      back through.

### Next / Upcoming Features

- [ ] **Exercise the interface batch in the compiled application.** Everything
      since the toolbar merge was verified against the dev server. `npx tauri
      build --no-bundle` is green and `albedo.exe` starts; the walk of the four
      groups, both modes, the library split and full screen is the last step.
- [ ] **Confirm the deferred startup in the compiled application.** The shell
      calls of `src/main.js` no longer gate the module: `shellReady` carries the
      two round trips, and `prefs`, the post chain and the light rig restore off
      that same promise. The walk of `albedo.exe` is the confirmation that
      settings still land and the window is never inert.
- [ ] **USD Skinning & Animation**: Complete composition of bind-space meshes into pose space once matching reference assets are verified.
- [ ] **NIF Skinning at Load**: Apply NIF skinning upon initial file load rather than defaulting to bind pose.
