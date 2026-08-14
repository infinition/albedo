# Albedo Navigation & Input Reference

Comprehensive user input guide covering keyboard shortcuts, gamepad controls, SpaceMouse 3D navigation, and interactive edit mode handles.

## Camera Navigation Modes

Albedo shares one camera between two distinct navigation modes:

- **Orbit Mode**: Rotates around a pivot point to inspect an object.
- **Fly Mode**: Free camera for walking through scenes. Hold left-click to look around (cursor hides automatically). `Escape` returns to Orbit mode, pointing the pivot at the current focal point. Key bindings are physical (layout agnostic): WASD and ZQSD use identical physical keys.

> Note: Pointer capture is deliberately avoided to prevent browser banner notifications that interrupt the viewport experience.

---

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `O` / `V` | Switch to Orbit / Fly mode |
| `Escape` | Exit fly mode or dismiss transform handles |
| `Shift + G` | Toggle viewport grid |
| `T` | Toggle turntable rotation |
| `F` | Frame model in viewport |
| `Space` | Play/pause animation, or ascend in Fly mode |
| `Tab` | Open/close Inspector drawer |
| `H` | Hide/show all UI overlays |
| `U` | Toggle PBR / Unlit render mode |
| `W` | Toggle the wireframe overlay |
| `Ctrl + T` / `Ctrl + W` | New tab / close tab |
| `Shift + R` | Level camera horizon |
| `1` to `5` | Switch inspection channels |
| `F11` | Toggle fullscreen mode |
| `Mouse wheel` | Zoom in Orbit mode / travel speed in Fly mode |
| `Shift + drag` | Swing key light position |
| `Ctrl + drag` | Adjust camera field of view (lens) |

---

## Tabs

One tab per open model, in the top left where the file name used to sit alone.
Opening a model no longer replaces the one you were working on: it takes a tab
of its own, and opening a file that is already open brings its tab forward
rather than loading a second copy.

| Control | What it does |
| --- | --- |
| Click a tab | Switch to it. Instant: nothing is loaded, the scene is put back |
| `+` or `Ctrl+T` | A new empty tab, to compose a scene out of several files |
| The cross, middle click, or `Ctrl+W` | Close. A modified tab asks first |
| A dot instead of the cross | This tab has changes an export would keep |
| An italic name | A preview: the next model looked at takes its place |
| Double click a preview | Keep it. The gesture for "this one, actually" |

**One tab is a preview**, and it is what makes browsing possible at all. Selecting
models in the library reuses that single tab rather than opening one per
curiosity, so clicking through two hundred assets costs one tab and you can still
orbit and zoom each of them properly, in the real viewer.

It stops being a preview the moment looking becomes working: any change that
would survive an export, opening the retopology mode on it, asking for the file
explicitly rather than selecting it, or double clicking the tab. From then on it
is a tab like any other and the next model previewed opens beside it.

With the library open, entering Retopo widens the preview strip once, because
460 pixels is the right size for picking a model and the wrong size for judging a
retopology. It is a nudge and not a rule: the split stays draggable afterwards,
and reopening the mode on a strip that is already wide enough leaves it alone.

**Every tab stays in memory.** That is what makes switching instant and what lets
an unsaved edit survive a trip to another tab and back. It also means five tabs
on heavy models are five models resident, which is the deliberate trade: the
alternative was reloading on every switch, which would have had to serialise
unsaved work to avoid throwing away the thing tabs exist to protect.

**An empty tab is a real state**, not a placeholder. Import adds to whatever is
in the scene, so a tab with nothing in it is where you start when what you want
is several files put together. The first object imported becomes the scene and
gives the tab its name.

What belongs to a tab: its objects, its camera, its channel state, its pose
history, its selection, its path, and its retopology results. What is shared by
all of them: the lights, the grid, the stand, the environment, the exposure and
the wireframe. The rule is whether it would still be true of the file after an
export.

**Only real changes count as modified.** A pose, a replaced texture, a material
preset, an imported object. Hiding a material, unplugging a map or changing
channel are ways of looking, and counting them would give a confirmation that
fires when you toggle the grid, and that is one people learn to dismiss
without reading.

---

## The panel

There is one panel, on the right edge, with one row of tabs, and every mode
shares it. A mode does not own a surface: it decides which tab opens first, which
action bar shows underneath, and whether the comparison curtain is live. Nothing
else.

| Tab | What it holds |
| --- | --- |
| Scène | The tree: meshes, their materials, each material's maps. Select and hide at every level |
| Vue | The eleven channels, wireframe, grid, bounding box, skeleton, exposure, cross section |
| Matière | The selected material: its maps, its four numbers, its presets, replace and restore |
| Retopo | Method, cleanup, maps, atlas and report. Present only while the mode is open |
| Caméra, Décor, Effets, Photo | Unchanged |
| Objet | Edit handles, parts, pivot, orientation, devices, Windows integration |

The tabs are permanent because they are attached to what is being looked at
rather than to what you are doing to it: the list of materials in a model is the
same list whether you are inspecting it or decimating it, so it does not deserve
two answers in two navigations.

**One selection, read by everything.** Clicking a surface in the viewport, a row
in the tree, or a name in the Matière pane all write the same thing, and the
Retopo scope control reads it. Ctrl-click adds to it. Clicking the only selected
thing again clears it.

**Hiding is not selecting**, and the two are deliberately kept apart: hiding says
what is *drawn*, which is what lets the scope control offer "everything", "what
is visible" and "what is selected" as three different answers. Both are edited in
the same tree, so they can no longer drift.

## Retopo Mode

Retopo is a mode beside the inspector and the library, opened from the same
cluster of buttons at the top right. It is chrome *around* the viewport rather
than a screen in front of it: the model stays visible and interactive throughout,
because you cannot judge a retopology without looking at it.

**No new keyboard shortcuts.** `Ctrl+Z`, `W`, `F`, `Space`, `Escape` and the
digits already mean something everywhere else in the application, and making one
of them mean a second thing while a panel happens to be open is the modal
surprise that makes a tool feel unpredictable. Everything below is a button, and
every button has a tooltip.

### The bar

One strip, under the top left cluster, in four groups.

| Group | What it does |
| --- | --- |
| Counters | Source, result, reduction and quad share of the last run |
| Display | Shaded, painted, base colour, normals, UV checker, **atlas charts**, **deviation** |
| Edges | None, dark, light; plus flat shading and x-ray |
| Compare | Source, result, both, **curtain**, **ghost** |
| Camera | Frame |

The two data views are *overrides* drawn over whatever channel is underneath, not
a twelfth renderer, and each switches its icon off when the run it needs data
from has not happened. Charts need a bake; deviation comes with every run.

**Curtain** puts the source left of a draggable line and the result right of it,
in one camera and one set of pixels. **Ghost** draws the result solid with the
source translucent over it, which is the view that answers "did the low poly sink
inside the original surface".

### The pane

One pane in the shared panel, in sections: Bilan, Méthode, Nettoyage, Cartes,
Atlas. Méthode carries the triangle budget, the deviation ceiling and the scope;
Nettoyage the creases and the smoothing; Cartes and Atlas the bake.

**Bilan is first and it is absent until there is something in it.** This was one
long column once and that was wrong twice over: you had to scroll past the whole
bake to reach the result, and an error written at the bottom of it was invisible,
so a run that failed looked exactly like a button that did nothing. A report
brings its own section forward, and the pane with it.

The material list and the view controls are not here. They are the Matière and
Vue tabs, which are the same tabs the inspector uses, because they were never
questions about retopology in the first place.

### The action bar

Undo and redo walk the history of results. The **Projeter** switch decides whether
a run bakes, and it sits next to the button whose cost it changes. **Cuire** bakes
again without touching the geometry, which is what makes iterating on a bad map
cost seconds instead of a minute. While a run is going, the run button *is* the
cancel button.

---

## Device Controls

### Xbox Controller (XInput)

- **Left Stick**: Move (Fly) or Pan (Orbit)
- **Right Stick**: Look (Fly) or Orbit camera
- **Triggers**: Dolly camera in/out
- **Bumpers**: Ascend / descend
- **Y**: Frame model
- **B**: Switch navigation mode (Orbit/Fly)
- **A**: Play/pause animation
- **D-Pad**: Cycle inspection channels
- **R3**: Level horizon
- **Deadzone**: Radial deadzone ensures straight diagonal movement

### 3Dconnexion SpaceMouse (WebHID)

Direct WebHID integration with zero driver requirements:
- All 6 degrees of freedom (Translation X/Y/Z, Pitch, Yaw, Roll) supported in Orbit and Fly modes.
- Hardware buttons mapped to Frame model, Switch Mode, and Level Horizon.
- Independent per-axis inversion toggles, deadzone settings, and translation/rotation sensitivity scaling in the Inspector.

---

## Edit Mode & Object Transformations

Press `G` (Translate), `R` (Rotate), or `S` (Scale) to display transform handles:

- **Interactive Handles**: Act directly on the scene object. Hold `Shift` while dragging to snap (0.25 units, 15 degrees, 0.1 scale increments).
- **Origin Centering**: When handles attach, object geometry is centered on the pivot so rotations turn in place without swinging across an offset origin. Bounding box coordinates remain preserved.
- **Transform Fields**: Exact numeric readouts for Position, Rotation (degrees), and Scale with real-time feedback during dragging.
- **Undo / Redo Stack**: `Ctrl + Z` and `Ctrl + Shift + Z` navigate a pose history stack (restores exact position/rotation/scale vectors).
- **Multi-surface Handling**: Single mesh selections transform independently; multi-mesh materials fall back gracefully to model-level transforms.
- **Quarter-Turn Preset Buttons**: Quick 90-degree re-orientation buttons (lay on side, tip forward, etc.).
