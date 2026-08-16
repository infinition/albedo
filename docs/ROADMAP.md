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
| Lights clickable in the viewport | [x] | A marker per light, asked before the model so one standing in front of the subject is still reachable; hidden unless its light is the one being edited |
| Volumetric fog with a position | [x] | Mean grey 45 off, 145 on, and back to 45 when the volume is moved out of frame — so it has a place |
| Colour space correction | [x] | Base colour sRGB, data maps linear |
| PBR / unlit toggle | [x] | Both buttons drive the channel state |
| Per material PBR / unlit | [x] | Alligator body unlit while its eyes stay PBR |
| Unlit keeps vertex colours | [x] | Carried through on a PLY that has them |
| Unlit keeps alpha and blending | [x] | On a model carrying both a cutout and a blend: alpha test, blending, depth write, side and texture all survive |
| Same materials whatever the container | [x] | The same alligator reports the same roughness and tint as glTF, USDZ and FBX |
| Eleven inspection channels | [x] | Rendered offscreen one by one: 9 distinct images, the two pairs that match being constants on that model |
| Point clouds counted in the statistics | [x] | 2000 points reported for PCD and XYZ, which read as an empty scene before |
| Wireframe, grid, bounding box, skeleton | [x] | Toggles verified |
| Exposure control | [x] | Wired to tone mapping. The slider lives in Effets; the mechanism stays on the renderer, because the backdrop is pre-compensated against the tone curve |

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
| Panel docked, flush with three edges | [x] | Full height, no gap, no rounded corners, one border on the viewport side. `--panel-reserve` is both its width and what the canvas gives up, so the two cannot drift apart the way they had |
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
| Library sidebar becomes a drawer when tight | [x] | Below 760 pixels of library, whatever the window measures, and it closes when you reach past it |
| The split survives the window being resized | [x] | Clamped in CSS with a floor on both sides, so it re-evaluates on every relayout instead of holding a pixel count taken once |
| Tabs keep their names while there is room | [x] | Names come off only when the row overflows, measured after layout; chevrons appear only when there is somewhere to scroll |
| Framing fills the box it is given | [x] | Five cases: a cube 57% to 94% of the height, and a wide flat plane in a narrow strip from 165% of the width, meaning off screen, to 94% |

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

### The panel docked, and the library in its own width

| Was | Is |
| --- | --- |
| The panel floated 8px off three edges with rounded corners, and the reservation was 28px wider than the panel: a band of cut model with nothing drawn in it, plus a strip of window background above, below and to the right | Flush to three edges, full height, one border on the side that has a viewport facing it, and `--panel-reserve` equal to the width so the canvas stops exactly where the panel starts |
| The narrow-window width came from `@container stage`, which can only set the panel's own width: `--panel-reserve` is read by `#stage`, the container itself, so the panel shrank and the space kept for it did not | A `@media` on the window, which is the right thing to ask: how much room there is for a sidebar is not a question about the box the sidebar is in |
| Framing used the bounding *sphere* against the vertical opening alone. A sphere around a standing figure is as wide as the figure is tall, and the horizontal opening was never asked at all | The eight corners in the camera's basis, and the distance each opening needs for its own extent. Measured over five cases: a cube goes from 57% to 94% of the height, and a wide flat plane in a narrow strip from **165% of the width, meaning off screen**, to 94% |
| Opening the library over a loaded model replaced it with a folder listing | It comes up beside it at 30%, unless a width was already dragged, which is an answer the user already gave |
| The sidebar drawer stayed open until its own button was found again | It closes when you reach past it, like every other drawer |
| `.segment` wraps by default, which is right in the panel and wrong in a toolbar: "Textures" dropped under the search field on its own and the bar grew a line for it. Below the last breakpoint the group was hidden outright | One line, and the labels give way to icons when the bar tightens rather than the buttons giving way to nothing |
| `--peek` is a pixel width, written once when the divider is dragged and read for ever after. Narrowing the window did not narrow the strip: the stage kept its 1500px and the library was handed the remainder, down to 80px of crushed toolbar and then nothing | A `clamp` with a floor on both sides, which re-evaluates on every relayout and cannot fall out of step with the value the drag writes. The drag uses the same two floors, since a divider that goes where the stylesheet then pulls it back from is a divider arguing with the cursor |
| Dragging the divider all the way over clamps at 220px, and that clamp was **saved and restored in every session after**. The strip came back as a 220px slot whatever the window, for ever, from one careless drag | A saved width is kept while it leaves the viewer a usable share, which a 40% library is well inside. Below that the 70/30 default answers instead: the edge of a drag is not a preference |
| From an empty viewer the library owns the window, and clicking a card opened the strip without saying how wide, so it took whatever the last session had left: a sliver at the right edge with the model loading behind the folder list | Sized at the same moment `show` sizes it, and a preview already on screen is refitted, since opening the strip over it leaves the camera fitted to a window that has become a column. Only a preview: a document being worked on has a camera someone put where they wanted it |
| The grid asked for `minmax(var(--card), 1fr)`, and `minmax` treats its first argument as a hard floor. A card size larger than the column, which is what the zoom slider produces as soon as the library is narrow, made a track wider than the box holding it | `minmax(min(var(--card), 100%), 1fr)`. The floor gives way when there is less room than that, instead of the grid overflowing sideways with a horizontal scrollbar under a list that scrolls vertically |
| Any tab carrying a snapshot and not holding focus lost its name, room or no room. In a wide window with two files that threw away the one thing a tab exists to carry, and a picture tells two variants of one model apart about as well as no label does | Measured rather than assumed: everything is drawn with its name and the names only come off if the row does not fit. Two chevrons appear when there is somewhere to scroll, outside the rail rather than over it, since floating them on top would cover the first and last tab, the two they exist to reach |

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
- **`requestAnimationFrame` is the wrong clock in an on-demand renderer.** The
  focus indicator was first written as a rAF loop that read the viewer and
  repainted a readout. Two faults in one: the loop spins through frames that draw
  nothing, and rAF stops being called at all in a background tab — where the loop
  was also what removed the indicator, so it would have stayed on screen for
  ever. Anything that has to follow the picture should be *pushed* by whatever
  draws it.
- **A backtick in a GLSL comment ends the template literal.** `fog.js` failed to
  parse with an error pointing at a comment line, which reads as a mangled file
  rather than as a string that closed early. Shaders written as template literals
  cannot quote identifiers the way the rest of the codebase does.
- **A pixel width written once is not a layout.** `--peek` was set by the drag
  handle and never confronted with the window again, so every later resize of
  the window was a resize of one half only. Anything a user drags has to be
  clamped where it is *read*, not only where it is written, or the value outlives
  the conditions it was chosen under. The same fault, in a second form, is a
  clamped drag value being saved: the edge of a drag is not a preference.
- **`minmax` and `flex-wrap` both fail loudly in one direction and silently in
  the other.** A `minmax` floor wider than its container overflows rather than
  shrinking, and `.segment`'s wrap is right in a panel and wrong in a toolbar.
  Neither throws, neither logs, and both look like the box is broken rather than
  the rule. Check them at the narrow end of every box they live in, not only at
  the window's narrow end.

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
- [x] The engine vendored into this repository. The retopo crates live under
      `src-tauri/crates/` as `retopo-core`, `retopo-remesh` and `retopo-bake`,
      with their manifests frozen: no external checkout has to exist at a fixed
      path any more, and the GitHub release workflow can actually build.
- [x] Shell initialisation off the critical path. The two round trips that used
      to gate `src/main.js` live behind a deferred `shellReady`; every listener
      attaches at once, and `prefs`, the post chain and the light rig wait on
      that promise alone.
- [x] "Fil de fer seul" as a mode of the overlay. One wire system, one colour:
      it survives every channel, follows the light or dark choice, and W cuts
      and restores it in the armed style.
- [x] Keyboard shortcuts that follow the printed letter. The layout is read
      from the first press of W or A, and on AZERTY Ctrl+Z undoes instead of
      closing the document.
- [x] Flat shading and a clay look in the Colour group. One toggle for smooth
      or faceted, and a clay button that cycles lit gray, unlit gray, back.
- [x] Before/after comparison that lines up. The curtain is placed in pixels
      over the canvas, not in a fraction of an overlay that no longer matches
      it, and a hold button or the X key peek at the source in the same look as
      the result.
- [x] French and English, one button away. The i18n module, the language
      toggle in the tab bar, and the toolbar, the panel and the whole inspector
      read their strings from the dictionaries.
- [x] The Retopo mode in both languages too. Its markup, its report, the run
      button, the scope sentences and every progress line: 137 keys, audited
      both ways. They ship in the mode's own chunk rather than in the startup
      dictionaries, which is what keeps a thumbnail job from parsing them.

- [x] One list for the whole scene. `src/ui/outliner.js` replaces the two that
      disagreed — the mesh tree in one tab and the lights, stand and backdrops in
      another — with Fonds, Lumières, Atmosphère, Socles and Modèle in a single
      list pinned above the tabs. Eye, rename on double-click and delete on every
      row; mesh previews textured and lit by the scene's own probe.
- [x] A naming convention that survives being used. Blender-style numbering on
      copy and import, a retopology result named after its *source mesh*, the
      link carried both ways, propagation that stops the moment a name is typed
      by hand, and a re-run that replaces only what descends from the meshes it
      covers.
- [x] Retopology one mesh at a time, with the selection as the default scope and
      one low poly per high poly. History and rebake carry N results.
- [x] Lights that behave like objects: a clickable marker, the transform
      handles, and markers hidden by default so a viewer stays a viewer.
- [x] Volumetric fog with a place in the scene — its own row in the list, its own
      handle in the viewport, and a ray-marched pass reading a depth render of
      its own.
- [x] Depth of field shown while it is set: the focal plane, the sharp band and
      the numbers, from the pass's own arithmetic.
- [x] Settings that belong to the scene rather than to the application. Effects,
      stand, backdrop and lights travel with the document; the preferences are
      what a session starts from.
- [x] Channel previews drawn on hover instead of thirteen offscreen renders per
      load, each tile in the colour of the thing it shows.
- [x] Panels that are read at a glance: effects as cards with a switch on the
      title line, toggles as chips, sections that fold, and the Objet pane down
      from 1095 to 738 pixels.

### Faults Found and Fixed, Scene-List Round

| Fault | How it hid |
| --- | --- |
| `selection.delete` did not exist | The tree called it to drop a mesh it had just removed. `selection` is an object literal and the method was never written, so deleting a mesh from the list threw a TypeError — on a path nothing else took, in a list that repainted itself afterwards anyway |
| `applyPrefs` abandoned everything after line 40 | `#fov-value` was nested *inside* a `data-i18n` span. `applyStaticIn` writes `textContent` on every such element, which deletes its children, so the readout was gone before the preferences were read and `applyPrefs` threw on it. Everything below that line — wireframe colour, stand, saved lights, slider readouts — silently stopped being restored, and the throw surfaced only as "Uncaught (in promise)" with no frame anyone read |
| A selected light swept away on every repaint | `prune` was handed the ids the tree knows about, which are meshes and materials. Judged against that list a light is "no longer in the scene" and was dropped instantly — the row never even flickered lit |
| Picking a light missed by however far it had just moved | Rendering is on demand, and it is the frame that flushes matrix updates. A click arriving before the next frame raycast against the previous frame's position. Dragging the elevation slider and immediately clicking the marker — which is exactly how one places a light — missed silently |
| Three calls in `restoreViewState` acting on `undefined` | `setKeyLight`, `setKeyLightPower` and `setKeyLightColour` read three fields `captureViewState` never wrote, and `applyLights` rebuilt every light on the very next line. Even when they did something, they did it to an object about to be replaced |
| Every pane with a slider scrolled sideways by two pixels | A range input carries a default margin on top of its own box, so `width: 100%` came out two pixels over. Enough for a scrollbar to appear and the column to twitch; not enough to see why |
| The panorama was forgotten, not freed | Leaving an image for the studio never released `panoramaSource` — the decoded texture stayed in memory the whole time — but coming back still went through the file picker, a disk read and a decode, which made a round trip to compare look destructive |

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
