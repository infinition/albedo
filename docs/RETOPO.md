# Retopo: bringing the plancton engine into Albedo

How the retopology and baking engine becomes a third mode in Albedo, beside the
inspector and the library. What Albedo already provides for free, what has to be
rebuilt, and what must not be broken on the way.

Legend: **[x]** done and measured, **[~]** in progress, **[ ]** planned.

---

## What this is

[plancton](https://github.com/infinition/plancton) is a retopology and texture
baking tool: quadric error decimation, isotropic remeshing, hole filling,
tangential relax with reprojection, quad pairing, a UV atlas and a cage
projection that bakes five PBR maps from a high poly onto a low one. It is pure
Rust, no CUDA, no Python, no C++, and it is built on Tauri 2 exactly like Albedo.

It arrives here as a mode, not as a merge.

**plancton stays its own repository.** It keeps its name, its CLI, its HTTP
server and the Blender bridge that server exists for. What changes is that its
three library crates become a dependency Albedo consumes, and its desktop shell
`plancton-bureau` stops being built, because Albedo *is* the shell now. That is
the only casualty and it is the redundant part.

Inside Albedo the name disappears. There is no plancton mode, no plancton menu,
no plancton branding. There is a **Retopo** mode, and it does retopology and
baking, in the same French register as Bibliothèque and Inspecteur beside it.

### Why "Retopo" and not "Remesh" or "Retopo & Bake"

Every button in that cluster carries one French noun as its tooltip. A two word
English label would be the only one of its kind, which is exactly the sort of
small inconsistency that makes an interface feel assembled rather than designed.

Baking is not in the name because baking is a consequence here, not a peer
activity: you bake *because* you decimated, to carry the detail you just threw
away onto the mesh that remains. It is a block inside the panel, next to the
button whose cost it changes, which is where plancton eventually put it too
after trying it as its own tab twice.

"Remesh" was the other candidate and it is narrower than the truth: remeshing is
one of the three methods in there, next to decimation and quad pairing.

---

## Why this fits, in one paragraph

Both applications are Tauri 2 with a Rust backend and edition 2021. Albedo
already exports the loaded scene to GLB through `GLTFExporter`
([main.js:934](../src/main.js)), which is the bridge the engine needs to be fed.
Albedo already raycasts the model, already lists materials with their map slots,
already replaces a texture in a slot and already restores the original. Those
are not adjacent features, they are literally the next chantier on plancton's
roadmap, already written and already debugged here.

---

## What Albedo already provides

plancton's next milestone was "Materials: a tab, and selection in the viewport",
eleven items. Six of them exist in Albedo today, including the two most
expensive.

| plancton wanted | Albedo has | Where |
| --- | :---: | --- |
| A materials tab, one row per material | [x] | The Scène tree, and the Matière pane for the one selected |
| Every texture slot listed one at a time | [x] | `MAP_SLOTS`, ten slots, not five |
| The source of each texture, named | [x] | `texture.name` |
| Import an external texture into a slot | [x] | `replaceMap()` in `src/viewer/materials.js` |
| Restore the original | [x] | `channels.restoreMaterial(uuid)` |
| Click a material in the viewport to select it | [x] | `pick(x, y)` in `src/viewer/viewer.js` |
| Ctrl-click to add to the selection | [ ] | trivial on top of `pick()` |
| Triangle count per material | [x] | two passes, see below |
| Isolate and hide per material | [x] | already existed, now load bearing |
| Decimate and bake a selection only | [~] | whole meshes yes, groups no |

These are not sketches. `replaceMap` does the part that costs an afternoon: the
incoming texture inherits `flipY`, wrapping, repeat, offset, centre and rotation
from the one it replaces, because those belong to the model's UVs and not to the
image. It handles TGA. It sets the colour space per slot from `DATA_SLOTS`, so a
normal map does not land in sRGB. `pick` already filters hidden meshes, helpers,
the stand, and objects whose *ancestor* is hidden.

plancton's roadmap proposed solving picking with a GPU pass writing the material
index into a framebuffer and reading one pixel back. That approach is now
unnecessary. A CPU raycast against three.js is simpler and already works.

### The gain nobody planned for

plancton reads glTF and GLB, and nothing else. Albedo reads NIF, USD, USDZ, FBX,
PLY, STL, OBJ, PCD and more. The moment the engine is fed from Albedo's scene
graph rather than from a file, **retopology works on every format Albedo can
open**. Retopologising a Bethesda NIF is not a feature anyone scheduled. It falls
out of the integration for free.

---

## What has to be rebuilt

Three of plancton's display modes do not survive the trip through GLB into
three.js. This is the real cost of the integration and it should not be
discovered late.

- **Quad topology.** [x] glTF has no quads. The mask travels beside the GLB as
  one `u32` per triangle and the shader honours it: bit `k` means the edge from
  corner `k` to `k+1` is real, and the cleared bit on a paired triangle is the
  diagonal. Done as a barycentric overlay rather than a line list, so it draws
  over the shaded surface in one pass with no second geometry.
- **The bake cage as a shell.** [x] Pushed along its own normals in the vertex
  shader, translucent, live under the slider.
- **The deviation heatmap.** [x] Per vertex distance from the source, through the
  BVH. The engine had been writing it beside every result from the start and
  nothing was reading it. Measured on the test model: 5,254 vertices, worst
  0.004327, mean 0.000620, 99 % of them moved at all.

**All three are done.** The cost of the integration, named at the top of this
document before any of it was written, has been paid in full.

Everything else in plancton's viewer is either already in Albedo and better
(eleven unlit inspection channels against one unlit mode) or is a three.js
one-liner (x-ray). The wireframe turned out not to be a one-liner: three.js's own
`material.wireframe` *replaces* the surface with lines, which throws away the
shading you opened the wireframe to judge. The overlay had to be written.

The compute ports at one to one. `plancton-core`, `plancton-remesh` and
`plancton-bake` are libraries with no interface in them at all.

---

## The startup contract

This is the constraint that outranks every feature in this document.

`albedo.exe` is not launched once. It is also the Windows shell thumbnail
provider: `shell-thumbnails` runs `albedo.exe --thumbnail` **one process per
file**. Open a folder of two hundred models for the first time and Windows spawns
two hundred of them. And Albedo's own architecture document commits to
initialising in under one second, with lazy format readers, a deferred PMREM
pass and pinned Vite chunks defending that number.

So, three rules, none of them negotiable:

1. **Nothing about Retopo initialises at boot.** `src-tauri/src/main.rs` already
   branches on `thumb_job()`. Every engine construction goes behind "this is not
   a thumbnail render", and behind first use even then.
2. **The mode is a lazy chunk, its stylesheet included.** The Asset Manager is
   the precedent: fetched on first interaction, not parsed at startup.
   `vite.config.js` pins chunk boundaries specifically so a loader used by two
   lazy chunks does not get hoisted back into the startup bundle. Retopo gets the
   same treatment, and the pin has to be checked, not assumed.
3. **The icon is always there, the mode does not exist until clicked.** No
   engine, no worker, no DOM and no allocation until it is opened for the first
   time in a session.

### Measured, so the size argument is settled

| Binary | Size | Profile |
| --- | ---: | --- |
| `albedo.exe` today | 4.4 MB | `opt-level="s"`, fat LTO, `codegen-units=1`, stripped |
| `plancton-bureau.exe` | 13.2 MB | `opt-level=3`, thin LTO, `codegen-units=4`, not stripped |
| plancton CLI, its own profile | 5.57 MB | as above |
| **plancton CLI, rebuilt at Albedo's profile** | **3.78 MB** | Albedo's exactly |

The 13.2 MB figure is misleading and should not be quoted: it is mostly profile
and Tauri and embedded web assets, all of which Albedo already pays for. The
honest number is the last row, and it is a ceiling rather than the cost, because
it still contains `plancton-server` with axum and tower-http, the CLI's argument
parsing, `tracing-subscriber`, and a Rust runtime Albedo already links.

### The real number, and how it got there

The estimate above was 2 to 3 MB. Measured on this machine, every build at
Albedo's release profile:

| Build | Bytes | Cost |
| --- | ---: | ---: |
| `albedo.exe`, before | 3,947,008 | |
| decimation in process, `panic = "abort"` dropped | 8,893,440 | +4,946,432 |
| decimation in process, `abort` kept | 4,720,128 | +773,120 |
| **engine and baker in a child process, `abort` kept** | **4,982,272** | **+1,035,264** |

The last row is what shipped, and the third is why. Dropping `abort` so a
`catch_unwind` could fire cost 4.17 MB on its own, five times the engine's whole
weight, because unwinding tables land on the entire binary rather than on the
engine alone. Running the engine in a child process keeps `abort`, gives a
stronger guard than `catch_unwind` ever was, and pays about one megabyte for the
decimator *and* the baker together.

That last point is worth stating plainly: the final binary is smaller than the
one that only had decimation, because the architecture changed underneath it.

**Every row above is a `cargo build --release`, which does not embed the
frontend.** That is fine for comparing them to each other, and it is how the
engine's cost was isolated, but none of those numbers is a shipped binary. The
real one, built with `npx tauri build`, carries `dist/` inside it:

| Shipped build | Bytes |
| --- | ---: |
| before, the executable found on disk | 4,428,800 |
| after the engine and the baker landed | 5,472,256 |
| after the whole viewer chantier | 5,482,496 |
| **after the panel became shared** | **5,494,784** |
| cost | +1,065,984 |

The same one megabyte, which is the useful confirmation: the delta measured
between two dev builds survives into the real ones.

Splitting one panel into nine permanent tabs, moving the tree and the material
numbers, and adding a central selection cost **12,288 bytes** on the shipped
executable, of which the tree's own chunk is 8,248 bytes of JavaScript and 2,696
of CSS that a session never opening the Scène tab does not fetch at all.

The row before it is worth its own sentence. The shader wireframe, the cage, the
comparison curtain, the ghost, undo and redo, two engine parameters, the borrowed
materials list and the scope control together cost **10,240 bytes**. Almost all
of that work is JavaScript and GLSL strings living in a chunk that was already
being shipped, which is the argument for putting the viewer's intelligence in the
front end rather than in Rust, restated as a number.

An earlier draft of this document called that 4,428,800 byte executable stale and
said the fresh 3,947,008 baseline showed the README's "3.7 MB" claim was
accurate. Both halves were wrong. It was not stale, it was the *production*
build, and the dev build is smaller only because it has no interface inside it.
The README's number was already optimistic before any of this, and now has to
say about five and a half.

Two things the first estimate had no way to see, and they pull in opposite
directions:

1. **The engine is built at `opt-level = 3`, not `"s"`.** Deliberate, and the
   whole point of the per package override, but it means the engine's code is
   optimised for speed inside a binary otherwise optimised for size.
2. **`panic = "abort"` is worth more than the engine.** Not a cost of the engine
   at all: a cost its presence would have imposed on Albedo's own code and on
   every dependency it already had. Measuring it is what turned the architecture
   around.

---

## The build traps

Two settings where Albedo and plancton want opposite things. Both are cheap to
fix and expensive to discover late.

- **`panic = "abort"`.** Albedo sets it. The engine runs jobs inside
  `spawn_blocking`, where a panic fails that job and the application carries on.
  Under `abort` the same panic kills Albedo, and it kills it during a thumbnail
  render too, which means a single malformed mesh in a folder can take out the
  Explorer preview for the whole folder.

  **A `catch_unwind` boundary does not fix this**, and an earlier draft of this
  document said it did. `catch_unwind` catches an unwind; under `panic = "abort"`
  there is no unwind to catch, the process is gone before any handler runs.
  `panic` is also one of the few profile keys Cargo refuses in a per package
  override, so it cannot be relaxed for the engine alone.

  So the choice is binary: keep `abort` and accept that one malformed mesh kills
  the application, or drop it from the release profile and pay for the unwinding
  tables. Given that the same executable renders Explorer thumbnails one process
  per file, dropping `abort` is the answer. The size it costs is measured below
  rather than guessed.
- **`opt-level = "s"`.** Albedo compiles for size, which is right for a viewer.
  plancton's own manifest carries a comment saying retopology is compute bound
  and the extra codegen time is repaid on every remesh. Merged, the decimator and
  the BVH inherit `"s"` and get quietly slower with nothing reporting it. Fix:

  ```toml
  [profile.release.package.plancton-core]
  opt-level = 3
  [profile.release.package.plancton-remesh]
  opt-level = 3
  [profile.release.package.plancton-bake]
  opt-level = 3
  ```

- **Build time.** plancton's tree alone took 1 min 53 s at `lto = true` and
  `codegen-units = 1`. Added to Albedo's, expect the release build to roughly
  double. This costs the developer, not the user, but it is worth knowing before
  it surprises someone.

---

## Architecture: where the seam goes

```
Retopo pane (lazy chunk)
      |  parameters, and the current scene
      v
GLTFExporter  ->  bytes  ->  Tauri command (spawn_blocking + catch_unwind)
                                    |
                                    v
                    plancton-core / -remesh / -bake
                                    |
                       GLB + quad mask + deviation + maps
                                    v
              Albedo's three.js scene, as a second model
```

Decisions taken:

- **Three front doors, one set of handlers.** The tab is not the only way in.
  The engine arrives with a CLI and an HTTP API that already work, and both are
  kept.

  | Door | How | Default |
  | --- | --- | :---: |
  | The Retopo tab | Tauri commands, progress on the event bus | on |
  | `albedo.exe remesh <file> --faces N --bake --uv-size N` | headless, same path as `--thumbnail` | on |
  | `POST /api/v1/...` for Blender, Maya, Houdini | `plancton-server`'s axum router | **off** |

  The API is opt-in behind an explicit flag. Albedo's pitch is no account, no
  upload, no network round trip, and that stays true of every default: no port
  is opened unless someone asks for one on the command line. What the flag buys
  is that the Blender add-on works against Albedo, and against a build that can
  read NIF and USD, which the plancton binary never could.

  `plancton-bureau/src/main.rs` shows how the tab side works without a socket: it
  pushes progress over Tauri events off the same broadcast channel the websocket
  used, so the worker code never had to learn about Tauri. Same handlers, same
  tests, three doors.
- **Fed from the scene, not from the file.** Going through `GLTFExporter` is what
  makes NIF and USD work. The alternative, re-reading the original bytes in Rust,
  is faster but only ever supports glTF.
- **The result is a second model in the scene, not a replacement.** Albedo is an
  inspector, and the whole point of a retopology is comparing it to what it came
  from. Source and result both live in the scene graph, with an A/B toggle.

---

## Phases

> **`cargo build --release` does not produce a usable application.** It produces
> an executable that opens a window and shows `ERR_CONNECTION_REFUSED` against
> `localhost:5183`, because it bypasses the Tauri CLI: `tauri-build` then emits
> `cargo:rustc-cfg=dev` and the webview loads `devUrl` rather than the bundled
> `frontendDist`. The line is in the build log and easy to read past. Use
> `npx tauri build --no-bundle`, which runs `beforeBuildCommand` and compiles in
> production mode. `cargo build --release` is still the right thing for
> measuring the binary or exercising the `remesh` and `bake` subcommands, which
> never touch a webview.
>
> **The build cache does not survive moving the project.**
> Albedo was built at `C:\Users\infinition\Desktop\Albedo` and now lives at
> `C:\DEV\coding\Github\Albedo`. `cargo build --release` fails with exit 101 and
> `failed to read plugin permissions: ...\Desktop\Albedo\...\app_hide.toml`,
> because every build script `output` file in `target/` recorded the old
> absolute path. `cargo clean -p tauri` does **not** fix it: the stale path is in
> the plugin build scripts and in the application's own, not only in tauri's.
> Only a full `cargo clean --release` does. Worth knowing before mistaking it for
> something the integration broke.

### Phase 1: the seam [x]
- [ ] Add `plancton-core`, `plancton-remesh`, `plancton-bake` and
      `plancton-server` as dependencies.

      **A path dependency, for now, and it must not ship that way.** The clean
      answer is a git dependency on the plancton repository, but that repository
      has never been pushed: its remote is configured and there is not a single
      remote tracking ref, so a git dependency cannot resolve today. Until
      plancton is published, the path is relative and five levels deep, which
      works on one machine and breaks on every other. Switching it is a one line
      change and it belongs in phase 7, before any release.
- [x] Per package `opt-level = 3` overrides for `plancton-core` and
      `plancton-remesh`, in release and in dev, and `panic = "abort"` removed
      from the release profile so the `catch_unwind` boundary in
      `src/retopo.rs` can actually fire.
- [x] Two Tauri commands. `retopo_workdir` hands back the two paths a run uses,
      chosen by Rust so the webview needs no path API and the capability set
      does not grow. `retopo_decimate` does the work on a blocking thread and
      reports progress on the event bus, one event per percent rather than one
      per collapse.
- [x] **Files, not IPC payloads.** The frontend writes its exported GLB to the
      path Rust chose and reads the result back through the loader that already
      exists. A 960k triangle model would otherwise cross the bridge twice as a
      JSON array of numbers.
- [x] Measure the binary before and after, and write the numbers into this file.
      Done above, and the estimate they replaced was wrong by a factor of two.
- [x] **Cold start measured**, at last. The contract had been asserted in this
      document since before a line of the mode was written and nobody had ever
      checked it.

      *In the page*, from a cold load: **8 chunks, 197,603 bytes**, DOM
      interactive at **21 ms**, DOMContentLoaded at **94 ms**. Retopo's chunk is
      12,344 bytes and it arrives **only when the mode is opened**, which is the
      whole claim. The shared view toolbar added since did not drag it forward.

      *As the shell sees it*, one process per file over a folder of eleven
      models: **10,464 ms total, 951 ms each**, eleven thumbnails written.

      That last number holds the promise and does not have room to spare. It is
      also almost entirely process launch and WebView2 startup rather than
      anything this code does, so the lever on it is not in the frontend. Worth
      remeasuring after anything that lands in the startup bundle.
- [x] Its own icon in the top right cluster, beside Bibliothèque and Inspecteur.
- [x] The mode's module and stylesheet are a lazy chunk, fetched on first open.
      **Verified, not assumed**: 4,898 bytes of JavaScript and 2,277 of CSS in
      chunks of their own, zero occurrences in the 115,982 byte startup bundle,
      and the network log shows the chunk requested when the button was clicked
      rather than at load.
- [x] A head-up display and an action bar, both taken from plancton's
      arrangement: the numbers you glance at after every run without opening
      anything, and the things you actually do kept visible whatever the panel is
      scrolled to.
- [x] The panel does **not** inherit the 4 pixel horizontal overflow the
      inspector panes have. A range in a flex column is given the width it has
      rather than asked for its own.
- [x] Budget as a percentage of the source, resolved to an exact triangle count
      next to the slider, plus the three guards that decide what survives:
      open borders, crease angle, seam cost.
- [x] Progress on the Tauri event bus.
- [x] Result lands in the scene beside the source through `importPart`, which
      gives it the same loader and the same material corrections a plain open
      would.
- [x] The run reports its refusals, not only its triangle count. A run with a
      large refusal count and a barely moved count is a guard firing on every
      candidate, and it looks exactly like a run with nothing left to collapse
      unless both numbers are on screen.
- [x] Method choice between Décimer and Reconstruire, each saying in a sentence
      what it is for rather than what it does.
- [x] **plancton's toolbar**, adapted to what Albedo can already do: five of its
      eleven channels, wireframe, an A/B between source, result and both, and
      frame. It drives the same channel state the inspector does, so the two
      cannot disagree about what is on screen. Everything about looking at the
      model is reached for constantly while judging a result, and a control you
      must open a panel for is a control you stop using.
- [x] **Cancellation**, which the child process made almost free: the whole
      implementation is killing the child. In process it would have meant
      threading a flag through every inner loop of an engine that does not know
      this application exists. The operating system does it instead, at once, and
      reclaims the run's memory on the way out. The run button doubles as the
      cancel button rather than a second button being inert for all but the
      twenty seconds a run lasts, and a cancel is reported as a cancel rather
      than painted red as a failure.

> **The bug that made every icon in that toolbar dead**, worth writing down
> because it looks exactly like a missing handler. The `pointer-events: auto`
> rule named `.rt-hud` and not `.rt-top`, so the whole strip inherited
> `pointer-events: none` from the host. The tell was that the bake switch worked
> and nothing else did: a `<label>` toggles its checkbox natively, with no
> JavaScript involved, so it was the only control that never needed a click to
> reach a listener.
>
> The first fix made it worse by granting events to the whole column, which is
> full width with `max-content` children: an invisible rectangle across the top
> of the viewport, eating clicks meant for the model. Only the boxes that are
> actually painted take events back.

> The inspector panes overflow horizontally by 4 pixels, Caméra, Rendu and Effets alike,
> for the same reason: a full width `input[type=range]`. Left alone on purpose.
> Matching the other seven panes matters more than winning 4 pixels in one of
> them.

### Phase 3: reading the result [~]
- [x] **The two things glTF cannot hold now travel beside it.** `<output>.quads`
      is one `u32` per triangle, the edge mask whose cleared bit is a quad's
      diagonal. `<output>.dev` is one `f32` per vertex, the distance back to the
      source through its BVH. Both written by the engine, both cross-checked
      against the counts they describe: 34,400 bytes for 8,600 triangles and
      21,376 for 5,344 vertices, exactly four bytes each.
- [x] Statistics in a head-up display: source, result, reduction, quad coverage.
- [x] **A line material that honours the quad mask**, so the pairing is visible
      rather than a number in a report. glTF has no quads, so the result really
      is a triangle soup and the generic wireframe draws it as one, every quad
      crossed out by its own diagonal. Bit `k` of the mask means the edge from
      corner `k` to corner `k+1` is real; the cleared bit on a paired triangle is
      the diagonal. Verified against a real run before drawing anything: 5,410
      triangles carry two bits, which is 2,705 quads over 63 % of the surface,
      the two numbers the engine reported on its own. 20,390 edges instead of
      25,800.
- [x] **Undo and redo over results.** A twenty second computation you cannot take
      back is a computation you stop experimenting with, which is the opposite of
      what a panel full of sliders is for. The history holds *paths*, not meshes:
      `removePart` disposes the geometry and textures it removes, and it is right
      to, so keeping every result resident to make redo cheap would mean holding
      a dozen copies of a model in memory to avoid re-reading a file still
      sitting in the work directory. A new run truncates anything ahead of the
      cursor rather than leaving a redo that jumps to an unrelated result.
- [ ] Do the same for a result with no pairing, where the wire toggle still falls
      back to Albedo's generic wireframe. It is the right fallback, but the two
      paths look different for a reason no one will remember.
- [x] **The bake cage drawn**, translucent and live under its own slider. The
      push happens in the vertex shader: rebuilding positions on the CPU per
      pixel of drag is a full buffer upload in the one interaction where a stall
      is least forgivable. It follows the vertex normal, the same direction the
      baker fires its rays, because a shell offset any other way draws a lie; it
      never writes depth, because a translucent shell that occludes hides the
      thing it exists to be compared against; and it is not raycastable, because
      picking a material through a diagram is not picking a material.
- [ ] Deviation heatmap as a channel, next to the eleven that exist. Still the
      largest of the three rebuilds: it needs per vertex distance out of the
      engine and an attribute to carry it, where the other two needed neither.

### Phase 4: clean up and rebuild [x]
- [x] Hole filling, tangential relax with reprojection, isotropic remeshing and
      quad pairing, each an optional stage with its own reported numbers, in the
      order plancton settled on: close holes first, reduce, then relax, then
      pair.
- [x] Crease angle exposed separately for decimation and for relax, with the
      reason written next to it in the panel. Sharing them once made relax pin
      eighty six percent of the vertices and silently do nothing.
- [x] The aspect ratio reported is the **mean**, never the worst. The worst
      triangle sits on a crease, which relaxation pins on purpose, so it barely
      moves even when the mesh improved throughout.

> **Measured end to end**, tombstones at 237,646 triangles, through the child
> process, holes and relax and pairing all on:
>
> ```
> 237646 → 8600 triangles en 4.35 s, déviation max 0.00430
> trous : 1 comblés, 0 laissés ouverts
> rapport d'aspect moyen : 3.460 → 2.197
> quads : 2705 (63 % de la surface)
> ```
>
> The result reloads through the engine's own reader, so the GLB it writes is
> one this application can open again.

### Phase 5: baking [~]
- [x] UV atlas, cage projection, the five maps: base colour with alpha, metallic
      roughness, tangent space normal, emissive, ambient occlusion. The result
      leaves as a textured low poly rather than a bare one plus loose PNGs.
- [x] Every knob exposed: atlas size, cage out and in, island gutter, edge bleed,
      island angle, occlusion rays and reach, and which maps to make.
- [x] Options gated by a switch stay on screen, dimmed and inert. Hiding them
      made the tool look like it could not do the thing at all.
- [x] The run button says what it will do, because the method segment is at the
      top of a scrolling panel and the button is at the bottom of the window:
      Décimer, Reconstruire, Décimer et projeter, Reconstruire et projeter.
- [x] A progress bar on the action bar, not in the panel, because a panel
      scrolls and a progress bar you have to scroll to find is not one. The
      wording follows the fraction, so it says "projection des textures" once
      the engine has moved on to that stage.
- [x] A miss rate above fifteen percent says so in words rather than leaving it
      in a number. A miss is a ray that fell back to the nearest surface point
      instead of finding the high poly; a lot of them means the cage is too
      tight for this pair of meshes.
- [x] **The cage drawn**, translucent and live under its own slider. Pushed along
      the vertex normal in the vertex shader, because rebuilding positions on the
      CPU per pixel of drag is a full buffer upload in the one interaction where
      a stall is least forgivable. It never writes depth, and it is not
      raycastable.
- [ ] Baked maps surfaced in the Matières slots, so the existing restore works
      on them.

> **Verified against plancton itself, on the identical invocation.**
> `--faces 8600 --bake --uv-size 4096` on the tombstones:
>
> | | charts | utilisation | hits | misses |
> | --- | ---: | ---: | ---: | ---: |
> | Albedo | 103 | 83 % | 5,714,289 | 2,885,321 |
> | plancton | 103 | 83 % | 5,714,289 | 2,885,321 |
>
> Identical. The seam is faithful, which is the only thing this test was for.
>
> Getting there caught a real bug of my own: `island_angle_deg` had been set to
> 66 while the code comment claimed the defaults mirrored plancton's. The engine
> default is 50, and at 66 the same model came out with 85 charts instead of 103.
> Every default in `RemeshRequest` is worth checking against the engine's own
> rather than guessed, because a value that merely feels right makes results from
> the two front doors incomparable.
>
> The high miss rate on that model is plancton's own behaviour and not something
> the integration introduced. It is already written down in its known weaknesses:
> chart count grows badly on models made of many thin parts, and the miss rate
> rises with it.

### Phase 6: per material work [~]
- [x] **`maxError` and `relaxStrength`**, both of which the engine had all along
      and neither of which was exposed. `maxError` is the second stop condition
      and the one that matters when the goal is a quality rather than a budget:
      measured on the test model, a cap of 0.001 refuses to go below 7,392
      triangles where the budget asked for 4,000, and lands at 0.00433 deviation
      instead of 0.00616. `relaxStrength` is not the pass count wearing a second
      hat: at four passes, 0.1 brings the mean aspect ratio to 2.444 and 0.9 to
      2.125.

  > Both hung the engine on the first attempt, and the cause is worth keeping.
  > Every arm of the argument parser advances the index by two; the two new arms
  > advanced it by nothing, so the loop span forever on the same flag. No output,
  > no progress line, no crash, and it looked exactly like a slow model. A parser
  > that loops is the failure mode with the fewest symptoms.

- [x] **Triangle count per material.** In the inspector it is a curiosity; here
      it is the number that says where a budget will actually go and which
      material is worth hiding before a restricted run. Counted in **two
      passes**: a material carried by several meshes only has its full count once
      every mesh has been seen, so counting while building rows in one traverse
      undercounts everything but the last mesh to use it.
- [x] **Isolate and hide per material**, which already existed and is now load
      bearing: it is what the "Visible" scope reads.
- [~] **Decimate restricted to the selection.** Two scopes, answering two
      different questions from the Scène tab. "Visible" is subtractive: hide what
      you want left alone. "Sélection" is additive: pick what you want touched.
      Both end in the same place, a set of meshes marked not-visible for the
      length of the export.

  > **Two traps in it, both found by reading rather than running.** Hiding swaps
  > a material for one that writes neither colour nor depth, which is right for
  > looking and invisible to an exporter: the geometry is still there and still
  > gets written. So those meshes are marked not-visible for the duration of the
  > export and put back after. And the wrapper has to *await* the export rather
  > than return its promise, because a `finally` around a returned promise runs
  > before that promise settles, so the meshes would come back visible while the
  > exporter was still walking the scene and the filter would silently do
  > nothing.

- [ ] **Per group, not just per mesh.** A mesh carrying four materials with one
      hidden cannot be half exported without splitting its geometry, so scope is
      all-or-nothing per mesh today. Splitting geometry to honour a display
      toggle is a much bigger promise than that control currently makes.
- [ ] Merge a restricted result back into one mesh. Today the untouched parts and
      the decimated ones are two objects in one scene, which exports as one file
      but is not the same thing as a merged mesh.
- [x] Ctrl-click to add to the selection. It came free with there being one
      selection: `src/selection.js` takes the modifier, and the tree, the
      material list and the viewport pick all go through it.

---

## After the panel: four defects and a tab strip

Reported after the refactor landed, and all of them found to be broader than the
report.

### One wireframe, working everywhere [x]

There were two. Albedo's set `material.wireframe`, which *replaces* the surface
with lines and therefore throws away the shading you opened a wireframe to judge.
Retopo's drew them over it, in the shader. Two controls in two places for one
idea, and both could be on at once, in which case the crude one won by destroying
the surface the other was painting.

Only the overlay survives, and `wire.js` moved from `src/retopo/` to
`src/viewer/`: it is a capability of the viewer, not of a mode. One switch in the
Vue pane, the `W` key, and a bar button that is now a mirror.

Three defects found by measuring the compiled shaders rather than reading them:

- **`ChannelView` hands out a stand-in material per channel and nobody patched
  them.** The wireframe vanished without a word on ten channels out of eleven.
  That is the "it does not work on retopologised meshes" report: the stand-in is
  there the moment you look at anything but the physical render. The class that
  decides which material a mesh draws with is now the class that dresses it.
- **`vChart`, `vDev` and `vRtNormal` were declared in both stages and assigned in
  neither.** The atlas view, the deviation heatmap and the x-ray were each
  painting a plausible picture out of an unwritten register.
- **The injection anchored on `#include <dithering_fragment>`**, which does not
  exist in `MeshNormalMaterial`. It targets the end of `main` now, which is the
  same place in the shaders that have the include and a place that exists in the
  ones that do not.

Two more found by clicking: the bar opened without reflecting the current state,
and two quick toggles crossed because switching on awaits a module while
switching off is an assignment. A sequence counter makes the last ask win rather
than the fastest.

And `prepareWire` now leaves an already prepared geometry alone when the call
carries no data: switching the wireframe on used to wipe the quad mask a run had
just written.

### One result, not a pile [x]

A second run stacked a second low poly on the first, so the scene held three
objects while claiming two and every counter above lied. A bake alone did the
same, though it does not touch the geometry: two identical meshes differing only
in their textures. The bake replaces, and it *rewrites* its history entry rather
than pushing one, because undo walks geometries and a bake is not a step in that
walk.

The export to the engine also saw the previous result, so decimating twice fed it
the source *and* the low poly made from it. Invisible on the glTF fast path,
which reads the file on disk, and therefore invisible on the formats that get
tested most.

The result now carries a mark on its object rather than being "the last part",
which broke the moment anything was imported between two runs.

### Tabs, and a preview tab [x]

Clicking a model in the library replaced the scene without a word. Now there is
one tab per open model, all resident, and switching is a detach and an attach
rather than a load, so an unsaved edit survives a trip to another tab and back.

### What a tab shows [x]

**An eye marks a preview.** The italic name said it already, but italics are a
difference you only notice once you know to look for one, and the whole point of
the preview tab is that you are not thinking about tabs while you click through a
folder. The glyph is Albedo's own, the same one the texture rows use for "this is
shown". Paler than the name beside it, because it is a state and not a control,
and full strength on the active tab, the one place the distinction changes what
your next click does.

**A snapshot stands in for the name on inactive tabs.** A truncated file name is
the worst of both worlds: it takes the room a name needs and delivers none of
what a name is for. Half an asset library begins with the same twenty characters,
so the strip ends up reading `A_10-meter_secti…` four times over.

The picture is taken from the live canvas rather than rendered afresh, so a tab
shows *what you were looking at* when you left it: your angle, your channel, your
framing. A synthetic three quarter view would be prettier and would lie about
which tab is which the moment you turn a model around.

The name stays on the active tab, and that is a deliberate half measure. Icons
everywhere would save more and cost too much: two variants of one model are
indistinguishable as pictures, which is exactly the case where several tabs are
open. Measured at **190 pixels with the name against 26 without**, so seven
inactive tabs now fit where one named tab did.

> Two things without which it does not work. The canvas is read in the same
> synchronous block as the render: without `preserveDrawingBuffer` the browser
> may discard the buffer at the next paint, and asking for it permanently would
> tax every frame of every session to serve a forty pixel square taken three
> times an hour. And the name is *hidden* rather than absent, so a tab keeps its
> width when it becomes active and the strip does not jump under the cursor.

One of them is a **preview**: selecting cards in the library reuses that single
tab instead of opening one per curiosity, and it stops being a preview the moment
looking becomes working. Opening the retopology mode is one of those moments.

Retopo's history follows its document: it holds paths to files produced from one
particular model, so carrying it across a tab switch would offer an undo that
swaps in a low poly of something else.

Two defects the tabs revealed, both about memory:

- Two models referencing the same image share one texture object, so closing a
  tab or loading over one would free a texture a parked tab was sitting on, and
  that tab came back with a black surface. The viewer asks the host what the
  other documents still hold, at every release.
- `clear()` could not be reused for parking: it *releases*, which is right for a
  model being thrown away and ruinous for one being put aside.

### The split that would not move [x]

With the library and Retopo open together the divider was frozen at half.
`body.peeking.retopo-open { --peek: 50% }` in the stylesheet beat the inline value
the drag handle writes on the root element, because a rule on `body` outranks an
inherited value for everything inside it. The widening is a one time nudge from
the module now, through the same property the handle writes, and only when the
strip is too narrow to work in.

---

### Phase 7: paying the rent [ ]
- [ ] Export the result. GLB exists; OBJ is worth adding for one concrete reason,
      it stores quads natively and glTF cannot.
- [x] Rewrite the README size claim. It said 3.7 MB, the shipped binary was
      already 4.43 MB before any of this, and it is 5.47 MB now.
- [x] `docs/FORMATS.md` and `docs/CONTROLS.md` updated for the mode, its
      companion files and, now, the shared panel that replaced its own.

---

## One panel, shared

The interface was scattered and it was reported several times. This is what was
wrong, what was done, and what was deliberately not done.

### The diagnosis

Three navigations for one model: the inspector's icon strip, Retopo's seven tabs,
and the icon bar over the viewport. They overlapped in part. Retopo *borrowed*
Albedo's panes into its own tabs, which produced a tab strip inside a tab strip
wherever the two met.

The cause underneath: **panel visibility was attached to modes** rather than to
what is being looked at. But "which materials are in this model" does not change
according to whether you are inspecting or decimating, so it should never have
had two answers in two places.

There were also three competing notions of selection: `selectedMaterial` in
`main.js`, `hiddenMaterials` in `channels.js`, and `picked` in `retopo/index.js`.

### What was done [x]

- [x] **One right panel, one tab row, always in the same place.** No mode owns a
      surface. The tabs are Scène, Vue, Matière, Retopo, Caméra, Décor, Effets,
      Photo, Objet.
- [x] **The tabs are permanent, not modal.** The mesh → material → map tree left
      Retopo for the Scène tab. The material's four numbers left Retopo's own tab
      for Matière, next to the maps they affect. The view controls were always
      Albedo's; Retopo stopped borrowing them and reads the same state instead.
- [x] **The borrowing machinery is gone**, along with `borrow`, `giveBack` and the
      `div.pane[data-pane="render"]` selector that had its own trap written next
      to it.
- [x] **Retopo's seven tabs became one pane in sections**, with Bilan first and
      hidden until it has something to say.
- [x] **A mode now changes exactly three things**: which tab opens first, which
      action bar shows at the bottom, and whether the comparison curtain is live.
- [x] **`src/selection.js`**, one set read by the tree, the material pane, the
      viewport pick and the scope control. Ctrl-click adds, which closes the
      "Ctrl-click to add to the selection" item from phase 6 as a side effect of
      there being one selection to add to.
- [x] **Retopo and the inspector stopped closing each other**, because there is
      now nothing for them to fight over.

The old `Scène` pane, which held the edit handles, the pivot, the orientation and
the devices, is now `Objet`. The name was needed for the thing that actually
shows the scene.

### Refused, with the reason

- **Folding `hiddenMaterials` into the selection.** It looks like a third
  selection and it is not: it says what is *drawn*. That is exactly what lets the
  scope control offer "everything", "what is visible" and "what is selected" as
  three different answers, and merging them would collapse two of the three:
  hiding a surface would select it, and selecting one would hide the rest. The
  two states stay apart. What they now share is one tree that edits both, so they
  can no longer drift by being changed in two places that never look at each
  other. This is the same argument that already rejected "a second selection for
  per material scope", pointed the other way.
- **Loading the tree at startup.** It would have been simpler than a lazy module
  for something the Scène tab needs on its first click. It draws a render per row
  through the renderer, and this executable is also the Explorer thumbnail
  provider, one process per file. Measured after the change: zero occurrences of
  the tree or the mode in the 113,318 byte startup bundle, the tree in a chunk of
  8,248 bytes of JavaScript and 2,696 of CSS, the mode in 43,274 and 9,472.
- **Keeping Retopo's tab in the bar while the mode is shut.** A tab that opens a
  pane full of controls driving a mode that is not running is a tab that lies. It
  appears with the mode and goes with it, and the panel falls back to the
  remembered pane rather than to nothing.

### What the two checks caught, again

- **A rename that fired on the wrong side.** `scene` used to name the editing
  pane and now names the tree, so a migration table mapped it to `object`. Put
  inside `showPane` rather than beside the preference it was for, it silently
  redirected every *live* call: the Scène tab did nothing at all when clicked, no
  error, no console line. Found by clicking it.
- **A class name that already existed.** The new tree used `.tree`, which
  `style.css` had held since long before for the monospace text outline in the
  Objet pane: `white-space: pre` and a monospace font over the whole thing. Found
  by reading the stylesheet the page actually served rather than the one on disk.
- **Transitions never advance in the automation panel.** The panel does not
  compose images, so `#inspector`'s 0.22 second slide stays pinned at its start
  value for ever and every geometry reading is of a panel that appears to be off
  screen. Measuring after disabling transitions is what turned a phantom layout
  bug into a correct measurement: panel at x 942, right edge 1266 in a 1280 pixel
  window, and zero overlap against the top bar, the action bar and the mode
  buttons.

---

## Preserved from plancton's roadmap

Everything below is plancton's own planning, kept here so the integration does
not amputate it. plancton's `ROADMAP.md` remains the authority in its own
repository; this is what these items mean once the engine lives in Albedo.

### The engine that arrives, already built

- Half-edge style mesh with per corner attributes and a weld layer, so topology
  never sees the duplicates a UV seam creates.
- SAH BVH: ray casting and closest point.
- glTF 2.0 and GLB import with `KHR_mesh_quantization` and `KHR_texture_transform`
  decoded by hand, because the `gltf` crate's typed iterators reinterpret an
  accessor whatever it declares and hand back plausible garbage.
- Quadric error decimation, Garland-Heckbert, with the three guards that matter:
  link condition, flip test, crease and seam constraint planes. Scale invariant.
- Relax with reprojection, hole filling, isotropic remeshing, quad pairing.
  Measured on a 406k pug: 7,256 triangles in 1.2 seconds, 86 percent quad
  coverage.
- UV atlas, cage projection, five maps, deterministic occlusion sampling so two
  bakes of the same model agree exactly.

### Still ahead, in plancton's order

1. **Real-time polygroups.** Shape Diameter Function plus dihedral concavity into
   an agglomerative merge tree, computed once. The slider is a cut through the
   tree, so recolouring costs nothing. Isolate, merge, hide, export one mesh or
   one material per group. In Albedo this wants to be a channel next to the
   eleven, not a mode of its own.
2. **Field-aligned quad remeshing.** Rust port of Instant Field-Aligned Meshes,
   BSD 3-Clause. Multiresolution hierarchy, 4-RoSy orientation field with hard
   constraints on creases, 4-PoSy position field, extraction, reprojection. The
   orientation field is cached so changing density does not recompute it.
3. **Painted guides and manual edge selection.** Draw curves the quad flow must
   follow, the way ZRemesher curves do. This is the single feature separating an
   automatic retopology from a usable one: the loops you want around an eye, a
   mouth or a knee are not creases, and no angle threshold will ever find them.
   Pays twice, as a hard constraint for the decimator now and for the orientation
   field at item 2.
4. **The Blender add-on.** A View3D sidebar panel that exports the selection,
   posts it, polls and imports the result. It is a thin HTTP client over an API
   that already exists and is already tested, so it is the smallest item on this
   list by a wide margin. It works against Albedo once the server flag is on, and
   against a build that reads NIF and USD, which the plancton binary never could.
5. **Symmetry.** Principal plane by PCA, refined by ICP, then symmetric
   remeshing, plus a forced axis selector.

### Answers kept so they are not re-litigated

- **Painting a zone to re-bake only that zone.** Half of it is easy and worth
  doing early: the bake is already per texel and independent, so masking which
  texels to recompute and merging over the previous map is a small change that
  turns iterating on a bad patch from a minute into a second. The other half,
  local *retopology* with a stitched border, waits for the field-aligned
  remesher, because it needs a remesher that can be told to respect a fixed
  boundary. So: a re-bake brush soon, a re-topologise brush much later.
- **A brush for polygon density.** Yes, and it fits what exists. Density is a
  scalar per vertex and both paths already have somewhere to multiply it in: the
  target edge length in isotropic remeshing, the collapse cost in the decimator.
  It is the same picking and painting machinery the guide curves need, so the two
  should be built together. This is what turns "eight thousand triangles" into
  "eight thousand triangles, most of them on the face".
- **Per vertex cage rather than one distance.** Same machinery again, and the
  cage display is the half you cannot skip. Right after the density brush.
- **The maps beyond the core five.** Clearcoat, sheen, transmission, volume,
  specular, iridescence and anisotropy are not baked, and the reason is upstream:
  they are not read on import either, so there is nothing to bake from. Adding
  one means a slot, a reader, a writer, a sampler and a shader term. Order:
  transmission and volume first because glass and liquid are common and their
  absence looks most wrong, then clearcoat, then specular. Note that Albedo reads
  more of these than plancton does, so the reader half may already be here.
- **UDIM.** Worth it, not yet. It matters when one model needs more than a single
  4K map, which means film work or a hero asset. Every stage would have to learn
  about tiles: packer, rasteriser, dilation, export, viewer. Large surface,
  narrow audience. Revisit when the atlas is good enough that its resolution is
  the limit.
- **OBJ export.** Worth adding for one concrete reason: it stores quads natively
  and glTF cannot. FBX is proprietary and its clean readers are licence problems.
  USD is a large dependency, though Albedo already carries a USD reader, which
  changes that calculation and should be revisited.

### Known weaknesses, inherited as they are

- **The atlas is not artist quality.** Chart growth plus plane projection then
  fragment absorption. A satchel at 12k triangles gives roughly 240 charts where
  a person would author a dozen. It bakes correctly, but the seam count is high.
- **Chart count grows badly on models made of many thin parts.** That same
  satchel with straps, buckles and rope gives 2,767 charts at 20k triangles. A
  chart should be able to wrap around a strap rather than stopping at every angle
  change.
- **Tangents are not MikkTSpace.** Averaged per vertex from the atlas
  coordinates, so a normal map baked here has a faint shading error against a
  Blender render on strongly stretched triangles.
- **No streaming.** Meshes are held whole in memory, twice over while a job runs.
  Fine at a million triangles, not at ten. This matters more inside Albedo than
  it did in plancton, because Albedo may already be holding a large scene.

### Lessons that each cost a debugging session

- **A migration belongs beside the thing it migrates, not in the middle of the
  road.** A table mapping old pane names to new ones sat inside `showPane`, where
  it caught every live call as well as the saved preference it was written for.
  `scene` had been renamed to `object`, so the new Scène tab silently opened
  Objet and clicking it did nothing at all: no error, no console line, the tab
  simply inert. It now runs once, on the preference, at the one place a stale
  name can actually arrive.
- **A new class name is a claim that no one else took it.** The scene tree used
  `.tree`, which `style.css` had held for years for the monospace text outline:
  `white-space: pre` and a monospace font, applied to the whole new tree. Reading
  the stylesheet the page *serves* rather than the file on disk is what found it.
- **Nothing animated can be measured in the automation panel.** It does not
  compose images, so a CSS transition never advances: `#inspector`'s slide stayed
  pinned at its starting transform for ever, and every geometry reading said the
  panel was off screen. Half an hour went into a layout bug that did not exist.
  Disable transitions before measuring, the same way `ResizeObserver` has to be
  doubled by an explicit call.
- **An unverified text replacement is a change you only think you made.** Twice in
  one session a scripted edit missed its anchor and did nothing, silently. Once it
  left this document claiming four finished things were still to do. Once it
  inserted a *call* to `paintHistory` while the block *defining* it never landed,
  so `refresh()` threw, the model import failed, and the drop overlay stayed up
  and ate every click: a model visible behind a veil, untouchable. Anchors are
  asserted now.
- **Click everything before believing any of it.** The regression above survives
  every check that reads code and dies instantly to one that runs it. Driving all
  27 buttons, 16 sliders and 10 checkboxes of the mode takes one command and would
  have caught it before it ever reached a build.
- **An absolute epsilon is a bug in disguise.** The flip test compared a triangle
  area to `f32::EPSILON`, so on a dense mesh every face read as already
  degenerate: a 406k asset came out untouched with 609,573 refusals and zero
  collapses. Every fixture happened to be one unit across. Anything comparing a
  length or an area now compares it against something of the same scale, with a
  test at 0.001, 1 and 1000.
- **A library that reads bytes without checking their type hands you plausible
  garbage.**
- **Relaxation inherited the decimation crease angle** and pinned eighty six
  percent of the vertices, so it silently did nothing. A mesh reduced fifty to one
  is faceted everywhere; the two thresholds are not the same question.
- **A rectangle fifty units long has four perfect right angles.** Scoring quad
  candidates on corner angles alone accepted a 50:1 sliver. Shape quality needs
  two independent measurements, angles and elongation.
- **The worst triangle is the wrong thing to report.** It sits on a crease, which
  relaxation pins on purpose. The mean is the honest number; the worst is
  context.

### Rejected, with reasons, so they are not proposed again

| Thing | Why not |
| --- | --- |
| [P3-SAM / Hunyuan3D-Part](https://github.com/Tencent-Hunyuan/Hunyuan3D-Part) | Its licence excludes the European Union outright. |
| [PartField](https://github.com/nv-tlabs/PartField) | The PartNet trained weights cannot be redistributed, and it needs Python and CUDA. |
| [quadwild-bimdf](https://github.com/cgg-bern/quadwild-bimdf) | GPL-3.0. Reachable only as a separate process, never linked. |
| A keyboard shortcut for Retopo's undo | `Ctrl+Z` is already Albedo's own history, and `W`, `F`, `Z`, `Space`, `Escape` and the digits are all bound too. Making one of them mean something different *only while a panel is open* is the modal surprise that makes a tool feel unpredictable. The undo and redo buttons are explicit and sit next to the button whose work they take back. |
| A second selection for per material scope | The hiding that already exists says the same thing. Two mechanisms for one idea drift apart, and the one you are not looking at is always the one that is stale. |
| xatlas through `xatlas-rs-v2` | Needs bindgen, which needs libclang, on every machine and every CI runner. Vendoring the C++ with a hand written FFI stays open. |
| `mikktspace` crate | Drags in nalgebra 0.26 for a few hundred lines of tangent maths. |
| Merging the plancton repository into this one | The CLI and the HTTP server have users this application will never have, and the Blender bridge needs the port Albedo refuses to open. Libraries in, everything else stays where it works. |
