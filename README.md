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
- Compressed float arrays. A float array whose values all happen to be whole
  numbers is stored as integers behind a one byte code, which skin weights are
  the usual case of: a vertex owned outright by one joint is a column of ones
  and zeroes. Reading the compressed flag without the type ran the integer
  decoder over real floats and failed much further down as a corrupt block.
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

## Asset manager

Press `B`, or the grid button. It opens over the viewer and closes back to it,
because Albedo is a viewer first: the manager, its stylesheet and its texture
decoders are one chunk that is fetched the first time it is asked for and never
at startup.

A library is any folder you nominate. Inside it: a grid whose thumbnails resize
from 84 to 320 pixels, a folder tree, free text search over names and tags,
filters by kind and by format, and sorting by name, date, size or format.
Models and textures both, since a texture is an asset too and half of them are
in formats no browser will show.

The pictures are the same ones Explorer shows, from the same cache. The manager
does not render its own: the two would drift, and a file would end up with two
different pictures depending on where you looked at it. Browsing a folder in
Albedo therefore warms the icons in Explorer, and the other way round.

### The preview strip

The library can give up its right edge, and the viewer draws there. Not a
second viewer, the real one: its own navigation, lighting, inspector and
render modes, in a strip whose width is yours to drag and is remembered.

The strip follows a selection of one. Selecting is not the same act as
looking: control click adds, shift takes the run between the anchor and the
card, and none of that loads anything, because building a selection is not a
request to see each thing put into it. It also remembers what it already
shows, so asking again for the asset on screen is answered by leaving it
there. Twelve clicks over five assets, two of them plain single clicks: two
loads.

### Giving memory back

Detaching is not releasing. three keeps the card's side of a geometry, a
material and a texture until it is told to let go, and dropping an object out
of the scene drops the JavaScript reference and nothing else. One file a
session and it never shows. Click through a library with the strip open and
every model looked at stays resident until the window closes.

Eight loads alternating between two models, counted through the renderer:

| | Geometries | Textures |
| --- | :---: | :---: |
| Before, after 8 loads | 8 → 15 | 5 → 20 |
| After, after 8 loads | 8 | 5 and 7, per model |

The textures in that test are 2048 square, so the leak was measured in
hundreds of megabytes over a few minutes of browsing.

What must survive is anything the scene owns rather than the model: the
environment, the backdrop, the gradient, and the UV checker, which is drawn
once and shared by every model there will ever be. Those are named explicitly,
because a release that took them would give a black environment and a blank
checker, and both would look like a different bug. Verified by rendering: the
same model gives the same picture on the third pass as on the first, 273
distinct tints either way, and the checker still draws after two other models
have come and gone.

### Portable by construction

Tags and notes live in `.albedo/library.json` inside the library, keyed by path
relative to its root:

```json
{
  "albedo": 1,
  "name": "props",
  "items": {
    "chars/hero.glb": { "tags": ["personnage", "wip"], "note": "" }
  }
}
```

Copy the folder to another disk, hand it to someone else, put it on a share:
the annotations arrive with it and still resolve, because nothing in the file
names a machine. The list of libraries is the opposite kind of thing, a set of
absolute paths that mean nothing elsewhere, so that lives in AppData with the
other settings.

The alternative was writing tags into the assets themselves. That means
rewriting binary formats in place, GLB chunk tables and NIF block streams, and
STL has nowhere to put a tag at all. A sidecar risks nothing, stays readable,
and can be diffed.

## Startup

A viewer has to be on screen before anyone has finished reading its name, so
what happens before the first frame is measured rather than assumed.

| | Before | After |
| --- | --- | --- |
| Scripts parsed at boot | 920 Ko | 656 Ko |
| Application chunk | 360 Ko | 80 Ko |
| Studio lighting pass | in the constructor | at the first model |

Two things were being paid for nothing. Eleven format readers were imported
statically, so every launch parsed all of them even to open a GLB, even to open
nothing; each is now fetched when its extension turns up. And the generated
studio environment ran a PMREM pass in the constructor, measured at 7 to 8 ms
warm and more cold with shader compilation, to light a viewport that was empty.

The bundler needs help holding that line: a loader used by two lazy chunks gets
hoisted into the shared one, and a dynamic `import("three")` builds a namespace
object that defeats tree shaking and pulled 124 Ko of engine back into the boot
path. Both are pinned in `vite.config.js` and by named imports.

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

## Lighting and effects

### Lights

The environment does most of the work, and on top of it any number of lights
can be added: directional, point or spot. Each is placed by bearing, height and
distance rather than by coordinates, the way a light dome is described in
Marmoset or a three point rig is described on paper. The distance is a multiple
of the model's own radius, so a rig set up on a bolt still makes sense on a
building, and every light is re-placed against whatever model is opened next.

Selecting a light draws its helper, which is the only way to tell where a
directional light comes from without moving it and watching what changes.

### Post-processing

The chain follows what Marmoset and Sketchfab put in front of an artist,
because those are the pictures a viewer gets compared against:

| Effect | Notes |
| --- | --- |
| Ambient occlusion | GTAO, the ground truth flavour rather than the older screen space one |
| Bloom | Threshold, strength and radius |
| Depth of field | Focus given as a fraction of the subject's depth, so the slider means the same thing on any model |
| Grading | Contrast, saturation, temperature |
| Vignette, grain, chromatic aberration, sharpening | One pass, since five would each cost a full screen read |
| Antialiasing | SMAA, on the final pixels |

Two rules set the order. Occlusion, bloom and depth of field are optical and
belong in linear light, before tone mapping. Grading, vignette, grain and
sharpening are darkroom work and belong after it, on the picture as it will be
seen. Antialiasing comes last of all.

None of it is loaded until an effect is switched on, and switching everything
off returns the renderer to drawing straight to the canvas: measured identical,
pixel for pixel, to never having enabled anything.

One trap worth recording. three does not tone map the clear colour, and the
chain ends in a pass that tone maps everything, backdrop included, so enabling
an effect dropped the default background from 20,22,26 to 5,6,8. The colour fed
to the chain is pre-compensated by inverting the tone curve, so the backdrop
you picked is the backdrop you see either way.

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

Every slider states its value, to as many decimals as its own step implies: a
slider that moves in whole degrees never shows a fraction, one that moves in
thousandths never hides what it did. The readouts are attached rather than
written into the markup, because thirty seven sliders is thirty seven chances
to forget one and the next one added would start out silent.

What the keyboard changes is said out loud, once, in a pill at the top of the
view that fades on its own. Half of what the keys do happens off screen: the
grid goes, the lens narrows, the interface hides, and the only evidence is the
picture, which is what you were looking at instead of the controls. Dragging
the lens or rolling the wheel counts as one message that keeps counting, so
the field of view and the zoom read as a number rather than a queue. Zoom is a
percentage of the framing `F` gives, since a distance in world units would
mean nothing.

### Edit mode

Three handles rather than six axis buttons. `E` brings them out, then `G`, `R`
and `S` move, turn and scale, `Escape` puts them away, and holding shift while
dragging works in steps: a quarter unit, fifteen degrees, a tenth of the scale.
The keys are the ones every modelling tool uses, so the hands already know
them, and they are modal exactly as they are there: `G` is the grid and `R` is
the roll until the handles are out, and neither shortcut had to be given up.

The handles take the whole model unless exactly one surface is picked. That is
the case that can be answered without inventing anything, since attaching to a
single mesh needs no pivot and no reparenting; a material spread over several
meshes has no one transform to offer, so it falls back to the model and says
so.

The six quarter turn buttons stay, because a quarter turn by hand is never
exactly a quarter turn. They are named for what they do to the model now,
tipping it forward or laying it on its side, rather than for the axis they turn
about. Nobody looking at a model on its side is thinking in axes.

### Saving a correction

A model that arrives upside down can be stood up and written back out, as glTF,
either beside the original or over it. Overwriting is a separate button from
saving: the two are not the same risk, it names the file it is about to
destroy, and it only offers itself when the file it would replace is one Albedo
can actually write. A NIF or a USDZ leaves as glTF, and quietly putting glTF
bytes into a file named `.nif` would be worse than refusing.

The thumbnail follows on its own. The cache key carries the path, the size and
the modification time, so rewriting the file misses the old entry rather than
serving it.

This also fixed a quiet defect in the existing export, which wrote out the
object and not the group holding it: every orientation correction was dropped
on the way out. Measured on a model 1.598 tall, laid on its side so that
dimension moves to Z, written and read back: through the group it is still on
its side, through the object it stands up again.

Right click gives no web menu. Reload, print, save image and inspect are offers
about a web page, and half of them are ways to lose what is on screen. The
canvas never showed one, since the orbit controls refuse the event to keep the
right drag for the camera, which is why it only ever appeared over the library
and the inspector. Text fields keep theirs: cut, copy and paste on a search box
is what every native window does, and nothing else on screen is editable.

### Narrow is a property of the box, not of the window

Every breakpoint asks the box it belongs to how wide that box is, through
container queries, rather than asking the window. The two stopped being the
same thing the day the library learned to hand the viewer a strip of its right
edge. A four hundred pixel strip in a wide window would otherwise lay out its
inspector, its scrubber and its overlays as though it still had the whole
screen, and the library squeezed into the half left over would keep the
posture of a wide one.

So the viewer lays its inspector over the model below 720 pixels of stage
whatever the window measures, and the library turns its sidebar into a drawer
below 760 pixels of library. Swept across fifty widths from 300 to 1280 with
the strip taking the difference: nothing wider than the box holding it at any
of them, and the close button reachable at every width. Two things had to give
for that last part, a toolbar that asked for more room than it was given and a
`1fr` track that refuses to shrink below its contents.

A container cannot be styled by its own query, only its descendants can, which
shows in two places: the library's grid moved one element inward, and the
stage hands its spacing down to the two overlays that read it rather than
setting it on itself.

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

### Files and textures

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
| Library sidebar becomes a drawer when tight | [x] | Below 760 pixels of library, whatever the window measures |

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
| USD animation and skinning | [ ] the rig decodes, the pose does not compose |
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
- [x] Asset manager: libraries, grid, folder tree, tags, filters, search
- [x] Custom lights: directional, point and spot, placed on a dome
- [x] Post-processing: occlusion, bloom, depth of field, grading, grain, SMAA
- [x] Windows shell thumbnails, rendered by the viewer itself and cached on disk
- [x] Export to glTF, so anything readable becomes portable
- [x] Save the view as a PNG, clear background, no overlays
- [x] Dimensions, so a file that arrived in the wrong unit says so
- [x] Cross section along any axis, for looking inside a closed shape
- [x] Environment: studio probe, editable gradient or HDR panorama, with what
      lights the model kept separate from what sits behind it
- [x] Settings that outlive the window, in roaming AppData

### Next

- [ ] USD skinning and animation. The rig is read: joints, bind and rest
      transforms, per vertex indices and weights all decode. What is missing is
      the composition that puts a bind-space mesh into its pose. Four
      arrangements were tried against the same asset exported as glTF and none
      matched, which may mean the two exports are simply not the same pose
      rather than that one of them is wrong; it needs an asset whose two forms
      are known to agree before anything is applied.
- [ ] NIF skinning applied at load, rather than showing the bind pose.

## Layout

```
src/
  main.js              application wiring
  prefs.js             settings that outlive the window
  ui/controls.js       overlays, inspector, timeline
  library/
    index.js           asset manager, loaded on first use
    thumbs.js          pictures, shared with the Explorer cache
    library.css        its own stylesheet, in the same lazy chunk
  viewer/
    viewer.js          scene host, on demand rendering
    loaders.js         format dispatch
    channels.js        inspection channels
    materials.js       PBR normalisation
    textures.js        texture discovery by convention
    navigation.js      orbit, fly, gamepad, SpaceMouse
    post.js            occlusion, bloom, depth of field, grading, grain
    release.js         giving the card back what a model held
    specgloss.js       KHR_materials_pbrSpecularGlossiness
    usd.js             USD packages and loose layers
    usdc/              binary crate reader
    nif/               NetImmerse and Gamebryo reader
src-tauri/             Rust shell, file association, texture search
shell-thumbnails/      IThumbnailProvider DLL, cache, registration
tools/
  make-samples.mjs     writes one sample per format the checklist covers
```
