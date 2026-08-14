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
| `W` | Toggle wireframe rendering |
| `Shift + R` | Level camera horizon |
| `1` to `5` | Switch inspection channels |
| `F11` | Toggle fullscreen mode |
| `Mouse wheel` | Zoom in Orbit mode / travel speed in Fly mode |
| `Shift + drag` | Swing key light position |
| `Ctrl + drag` | Adjust camera field of view (lens) |

---

## Retopo Mode

Retopo is a third mode beside the inspector and the library, opened from the same
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

### The panel

Six tabs. Méthode carries the triangle budget and the deviation ceiling, Nettoyage
the creases and the smoothing, Cartes and Atlas the bake, Matières the material
list borrowed from the inspector, and Bilan the report and the deviation scale.

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
