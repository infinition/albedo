# Albedo Architecture & Technical Reference

Deep technical dive into Albedo's architecture, memory management, startup optimizations, inspection system, lighting pipeline, and Windows Explorer shell integration.

## Startup Performance Optimization

Albedo is designed to initialize in under 1 second. Measured startup performance metrics:

| Metric | Cold / Unoptimized | Optimized |
| --- | --- | --- |
| Scripts parsed at boot | 920 KB | 656 KB |
| Application bundle chunk | 360 KB | 80 KB |
| Studio lighting pass | Executed in constructor | Deferred to first model load |

### Optimization Strategies

1. **Lazy Format Readers**: Format loaders are imported dynamically on-demand when a file with a matching extension is opened.
2. **PMREM Pass Deferral**: Studio environment PMREM calculations (7-8 ms warm cost) are deferred until the first model is loaded into the viewport.
3. **Vite Chunk Pinning**: Shared dependencies and dynamic `import("three")` namespace calls are explicitly pinned in `vite.config.js` to enforce strict tree-shaking.

---

## Asset Manager & Memory Disposal

The Asset Manager (`B` or grid button) is packaged as a lazy-loaded chunk that is only fetched upon first interaction.

### Preview Strip & Memory Leak Prevention

When browsing models in the preview strip, three.js retains WebGL buffers (geometries, materials, textures) unless explicitly disposed:

| Scenario | Geometries | Textures | Memory Cost |
| --- | :---: | :---: | --- |
| Without explicit disposal (8 loads) | 8 → 15 | 5 → 20 | 100s of MB leaked |
| With Albedo memory disposal (8 loads) | 8 | 5 & 7 per model | Constant memory footprint |

System resources (environment map, backdrop gradient, shared UV checker texture) are explicitly preserved across model switches to avoid black environment bugs.

### Portable Asset Annotations

Tags and notes are stored in a sidecar file (`.albedo/library.json`) inside each library folder using relative paths:

```json
{
  "albedo": 1,
  "name": "props",
  "items": {
    "chars/hero.glb": { "tags": ["personnage", "wip"], "note": "" }
  }
}
```

This ensures annotations remain portable across drives, shares, and machines without modifying binary 3D assets.

---

## Inspection System & Material Contradictions

Albedo features 11 flat unlit inspection channels: Shaded, Hand-painted, Albedo, Normal Map, Roughness, Metalness, Ambient Occlusion, Emissive, Alpha, Geometric Normals, and UV Checker.

Each channel tile carries the colour of the thing it shows — normals violet, UV
cyan, emissive the colour of light — on the preview's frame, so a tile means
something before its picture exists.

**Previews are drawn on hover, one at a time.** All thirteen used to be rendered
on every load: each swaps a stand-in material onto every mesh in the scene,
renders the model offscreen, and swaps back. Thirteen material passes and
thirteen renders before the first frame of a file somebody may only have wanted
to look at. One is drawn at load — the channel in force — and the rest when
looked at, once, without disturbing the channel on screen.

### Material Contradiction Reporting

The inspector automatically detects invalid material declarations directly from material parameters:

1. **Transparency without Alpha Source**: Blending flag enabled, but opacity is 1.0 with no alpha texture.
2. **Zero Opacity**: Opacity parameter is 0, making the material completely invisible.
3. **All-Zero Vertex Colours**: Detects zero-filled vertex colour attributes that would multiply glTF base color to pure black, bypassing the attribute while flagging the file defect.

---

## Windows Explorer Shell Integration (`IThumbnailProvider`)

Albedo provides native Windows Explorer thumbnail previews for **all supported 3D formats** (GLB, glTF, FBX, OBJ, STL, NIF, USD, PLY, DAE, 3DS, VOX, AMF, PCD/XYZ) via three components:

1. **COM DLL (`albedo_thumbnails.dll`)**: Implements `IThumbnailProvider` (registered under `HKCU`, requiring no elevated admin permissions).
2. **Headless Viewer Mode (`albedo.exe --thumbnail <model> --out <png>`)**: Offscreen WebGL render process that frames the model, generates a square PNG thumbnail, and terminates.
3. **Disk Cache (`%LOCALAPPDATA%\Albedo\thumbnails`)**: Keyed on file path, file size, modification timestamp, and render epoch.

### Forced Registry Associations & Shell Settings

File associations and thumbnail handler registrations can be re-registered or forced into the Windows Registry (`HKCU`) at any time:
- **Application Settings UI**: A single-click button in the settings panel triggers shell re-registration for all 3D file extensions without requiring administrator elevation.
- **Registry Keys**: Registers default file icons under `HKCU\Software\Classes\Modele3D\DefaultIcon` and shell renderer paths under `HKCU\Software\Albedo\Shell`.
- **PowerShell Script**: Developers can force registration manually via `tools\install-thumbnail-provider.ps1`.

---

## One List for the Whole Scene

`src/ui/outliner.js` holds every object the scene contains, in one place, above
the tab bar rather than behind one of the tabs.

There used to be two lists. One held the meshes, their materials and each
material's maps; another, in a tab of its own, held the lights, the stand and the
backdrop. So "what is in this scene" had two answers in two places, and pointing
at a thing depended on guessing which of the two it had been filed under. A light
has a position, can be hidden, renamed, deleted and clicked on — all of which is
true of a mesh. Filing them apart was a statement about how the viewer is built,
not about what the user is looking at.

| Group | Holds | Row actions |
| --- | --- | --- |
| Fonds | Studio, gradient, image — the one in force is marked | Select, switch to, show/hide the backdrop |
| Lumières | Every light, iconed in its own colour | Select, rename, hide, delete |
| Atmosphère | The fog volume | Select (takes the handles), switch on/off |
| Socles | The stand | Select, rename, hide, remove |
| Modèle | Meshes → materials → maps | Select, rename, hide, delete, swap a texture |

The panel is three bands: the list pinned to the top at 30% with its own
scrollbar, the tab bar, then the panes with theirs. The list is what you
navigate *from*, so it is never scrolled off to reach a slider.

`src/selection.js` is the single selection for all of it. Meshes and materials
are keyed by three.js uuid; everything else gets a prefixed synthetic id
(`light:3`, `bg:studio`, `fog:main`). The prefix is what lets `prune` tell them
apart: the tree repaints on every eye click and hands `prune` the ids it knows
about, which are the model's — judged against that list a selected light would
be "no longer in the scene" and swept away on every repaint.

Mesh previews are drawn with their own materials under the scene's probe, and
cached against geometry *and* material — so a texture that finishes loading after
the first paint produces a new key and a redrawn, textured preview.

---

## Naming and the High/Low Poly Link

`src/naming.js` owns three things.

1. **Uniqueness**, counted the way Blender counts: `Head`, `Head.001`. Applied on
   load (a file may name two meshes the same), on import and on alt-drag copy.
2. **The link**, both ways, in `userData`. A retopology result is named after the
   *mesh* it came from, not after the file: on a three-mesh scene a run
   restricted to one of them used to produce something claiming the whole
   document.
3. **Derived names.** `Head_LP` is called that *because* its source is called
   `Head`, so renaming the source renames it — but only while nobody has typed
   over it. The first manual rename ends the derivation. A rename that overwrites
   a name somebody chose is worse than no propagation at all.

A re-run replaces the low polys made *from the meshes it covers*, found by the
link. This was a boolean on the object, so every result answered to it and
retopologising the hands threw away the head's low poly. Ownership is not the
question a re-run asks; descent is.

---

## Retopology, One Mesh at a Time

A run exported the whole scene into one file, decimated that, and brought back
one object. On a one-mesh scene those are the same thing; on a nine-mesh scene
the result was a merged blob with no relationship to any of the nine — so it
could not be named after its source, replaced without replacing all of them, or
baked against the mesh it came from.

The engine still sees one mesh per call, which is what it is good at. The loop is
in the interface. The budget is a percentage, the one form that survives being
split: each mesh keeps the same share of its own detail, so a bolt and a hull
both come out at forty percent rather than the hull eating a scene-wide
allowance.

The default scope is **Sélection**, which already means "what is chosen, and
everything when nothing is". History and rebake carry N results; cancelling stops
the run without undoing the meshes already produced; the progress bar spans the
whole run rather than each call.

---

## Lighting, Fog & Post-Processing

### Dynamic Light Rig

Custom directional, point, and spot lights are specified by bearing, height, and
distance scaled to a multiple of the model's bounding sphere radius.

Each light carries a **marker** — a tinted sprite standing where the light
stands — because a light has no geometry for a ray to hit. `pickLight` is asked
before `pick` and wins outright: a key light usually sits between the camera and
the subject, and whoever loses that tie is the one you can never click.

Markers are **off by default**. Albedo is a viewer first, and four bright discs
over every model opened merely to be looked at is the tool getting in front of
the thing. Only the light being edited shows its marker; a switch in Affichage
shows them all for when a rig is actually being arranged. They are excluded from
`photo()`, `snapshot()` and therefore from Explorer thumbnails — drawn without
depth testing, one would print a bright disc over the subject in every folder.

### Volumetric Fog

`src/viewer/fog.js` integrates along the view ray: for every pixel it marches
from the camera to the surface the depth buffer reports, samples density at each
step, and accumulates in Beer–Lambert. Density falls off from a centre that can
be dragged and again with height, which is what makes fog read as fog rather than
as a grey wash.

`scene.fog` was not an option: it is a distance curve applied in every material,
with a colour and a density and *everywhere*. What an artist wants is a bank of
mist sitting in one part of the frame — a thing with a place.

Depth comes from a render of the pass's own, with an override material. The
composer's targets ping-pong between two buffers and are multisampled, so a depth
texture attached to one of them is the frame just drawn about half the time and
the one before it the rest.

The anchor is a real object in the scene: it takes the transform handles, it has
a row in the outliner, and its marker is clickable in the viewport.

### Post-Processing Pass Execution Order

To maintain physically accurate light transport, post-processing passes are
strictly ordered:

1. **Linear Optical Passes** (before tone mapping): GTAO, Volumetric Fog, Bloom,
   Depth of Field. Fog sits after occlusion — otherwise the creases it darkens
   are darkened through the mist standing in front of them — and before bloom, so
   a lit bank of fog blooms like anything else bright.
2. **Darkroom / Grading Passes** (after tone mapping): Contrast, Saturation,
   Temperature, Vignette, Grain, Chromatic Aberration, Sharpening.
3. **Final Pass**: SMAA (Subpixel Morphological Antialiasing).

Background clear colors are pre-compensated by inverting the tone curve to
prevent backdrop darkening when post-processing is active. **This is why exposure
is not a pass**: the control lives in the Effets panel beside bloom and
sharpening, where it belongs conceptually, but the mechanism stays
`toneMappingExposure` on the renderer. A chain that took over the exposure would
darken every backdrop by whatever the dial said.

### Depth of Field, Shown While It Is Set

Three rings in the viewport — the focal plane and the two ends of the sharp band
— plus a numeric readout, while any DOF slider is moving. It is the one effect
whose main control is invisible while you set it: "focus 0.42" names a plane
somewhere in the scene, and the only way to find out where was to let go and look
at what came out blurred.

The band comes from the shader's own arithmetic and the values are the ones just
handed to the pass; an indicator that recomputes the formula on its own is an
indicator that can be wrong. It is **pushed by the pass, not polled by a frame
loop**: rendering is on demand, and `requestAnimationFrame` stops firing in a
background tab — where the loop was also what took the indicator away.

---

## Settings Belong to the Scene

Look settings are per document, captured on park and restored on switch:
channel, wireframe, grid, bounds, skeleton, marker visibility, exposure,
environment and its framing, background brightness, lights, the stand and its
placement, and the whole effects stack.

The effects stack used to be one global set shared by every tab, so grading a
photograph in one left the next model graded. Opening a second model beside the
first now starts from the defaults — its own lights, its own backdrop, its own
effects — because inheriting a rig somebody built for another asset is inheriting
decisions that were never about this one.

The preferences still exist and still matter: they are what a *session* starts
from. What they stopped being is what every scene shares. Defaults for the
effects stack are read out of the markup, once, before anything can write to it.

---

## Multi-File Scenes & Responsive Container Queries

- **Scene Import**: Additional 3D models can be imported alongside existing models, positioned independently, and exported together as a single glTF scene.
- **Center of Rotation**: Pivot point can be toggled between bounding box center and vertex position average.
- **Container Queries**: UI overlays and drawers use CSS Container Queries (`cqw` / `cqh`) based on the stage container width rather than window dimensions, ensuring responsive layouts when the library preview strip is open.
