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
| A materials tab, one row per material | [x] | Matières pane, `#materials` |
| Every texture slot listed one at a time | [x] | `MAP_SLOTS`, ten slots, not five |
| The source of each texture, named | [x] | `texture.name` |
| Import an external texture into a slot | [x] | `replaceMap()` in `src/viewer/materials.js` |
| Restore the original | [x] | `channels.restoreMaterial(uuid)` |
| Click a material in the viewport to select it | [x] | `pick(x, y)` in `src/viewer/viewer.js` |
| Ctrl-click to add to the selection | [ ] | trivial on top of `pick()` |
| Triangle count per material | [ ] | trivial from the geometry groups |
| Isolate and hide per material | [ ] | |
| Decimate and bake a selection only | [ ] | the engine's job |

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

- **Quad topology.** glTF has no quads. plancton pairs triangles and carries the
  result as a per triangle diagonal mask inside PMSH, its own wire format, which
  the GLB does not hold. Load the result into three.js untouched and you see
  triangles. The 86 percent quad coverage that the Rebuild path is sold on
  becomes invisible. The mask has to travel beside the GLB and a line material
  has to honour it.
- **The deviation heatmap.** Per vertex distance from the source, measured
  through the BVH. It is an attribute the engine computes and nothing in three.js
  knows about. Needs its own transport and a shader.
- **The bake cage as a shell.** Geometry pushed along its own normals, drawn
  translucent, updating live with the slider. Cheap in three.js, but it does not
  exist there yet, and there is no other way to judge a cage distance than to see
  whether it swallows the detail without reaching onto the next part.

Everything else in plancton's viewer is either already in Albedo and better
(eleven unlit inspection channels against one unlit mode) or is a three.js
one-liner (wireframe, x-ray).

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

### The real number, now that the two are linked

The estimate above was 2 to 3 MB. It was wrong, and low. Measured on this
machine, both builds at Albedo's release profile:

| Build | Bytes | Link time |
| --- | ---: | ---: |
| `albedo.exe`, before | 3,947,008 | 3 m 55 s |
| `albedo.exe`, with decimation wired | **8,893,440** | 5 m 58 s |
| **Cost** | **+4,946,432 (+125 %)** | +2 m |

The old 4.4 MB binary on disk was stale, from before the project moved: a fresh
baseline is 3.95 MB, which is the "3.7 MB executable" the README claims, so that
claim was accurate.

Three reasons the estimate missed, and only the first was in it:

1. `gltf` and `image` are not small.
2. **The engine is built at `opt-level = 3`, not `"s"`.** That is deliberate and
   it is the whole point of the per package override, but it means the engine's
   code is optimised for speed in a binary otherwise optimised for size.
3. **Dropping `panic = "abort"` adds unwinding tables to the entire binary**, not
   to the engine alone. This is the one that was missed: it is not a cost of the
   engine, it is a cost the engine's presence imposes on Albedo's own code and on
   every dependency it already had.

And this is decimation only. The baker is not wired yet, so the number will grow
again in phase 5.

Whether 8.9 MB is acceptable is a judgement, not a measurement. It is still one
file with nothing to install, which is the promise that matters, but the README's
headline number has to be rewritten rather than quietly left wrong.

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

> **Before anything: the build cache does not survive moving the project.**
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
- [ ] Measure cold start, before and after, on a folder of models rather than a
      single launch. This is the number the thumbnail provider actually cares
      about and it is not taken yet.

### Phase 2: the mode [~]

> **It is a mode, not a tab.** It began as an eighth inspector pane and that was
> wrong: the tool has a triangle budget, three guards, a bake with six knobs and
> a per material selection still to come, and none of that belongs in a 324 pixel
> column. It is now a third mode beside the inspector and the library, which is
> also what makes plancton's finished interface reusable. Measured, and this is
> the number that settles it: of the 1,075 lines in plancton's `ui.js`, only
> **28** call into its viewer. The interface is barely welded to the renderer
> underneath it, so its layout, its stylesheet and its 217 translated strings can
> come over and be rewired onto three.js. `viewer.js`, 1,066 lines, is the part
> that does not come.
>
> **Unlike the library, the mode does not cover the viewport.** You cannot judge
> a retopology without looking at it, so the host passes every pointer event
> through and only its own panels take them back. Verified: a click at the centre
> of the window reaches the viewer, a click on the panel reaches the panel.
>
> **One panel on the right edge at a time.** Retopo is a state of the viewer
> rather than a second viewer, so it and the inspector close each other.
> Verified in both directions. With the library open and peeking, the chrome
> confines itself to the preview strip: three surfaces at once would be one too
> many, and the third would be showing the same model as the second.

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
- [ ] Method choice between Decimate, Rebuild and Pair. Only Decimate is wired.
- [ ] Cancellation.
- [ ] An A/B toggle between source and result.

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
- [ ] A line material that honours the quad mask, so the pairing is visible
      rather than merely computed.
- [ ] Deviation heatmap as a channel, next to the eleven that exist.

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

### Phase 5: baking [ ]
- [ ] UV atlas, cage projection, the five maps: base colour with alpha, metallic
      roughness, tangent space normal, emissive, ambient occlusion.
- [ ] Every knob: map size, cage distance, island gutter, edge bleed, island
      angle, occlusion reach.
- [ ] The cage drawn as a translucent shell, live with the slider.
- [ ] Baked maps land in the Matières slots through the existing `replaceMap`,
      which means restore already works on them.

### Phase 6: per material work [ ]
- [ ] Ctrl-click to add to the selection, on top of `pick()`.
- [ ] Triangle count per material, from the geometry groups.
- [ ] Isolate and hide per material.
- [ ] Decimate and bake restricted to the selection, leaving the rest untouched.

### Phase 7: paying the rent [ ]
- [ ] Export the result. GLB exists; OBJ is worth adding for one concrete reason,
      it stores quads natively and glTF cannot.
- [ ] Rewrite the README size claim.
- [ ] `docs/FORMATS.md` and `docs/CONTROLS.md` updated for the new tab and its
      keys.

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
| xatlas through `xatlas-rs-v2` | Needs bindgen, which needs libclang, on every machine and every CI runner. Vendoring the C++ with a hand written FFI stays open. |
| `mikktspace` crate | Drags in nalgebra 0.26 for a few hundred lines of tangent maths. |
| Merging the plancton repository into this one | The CLI and the HTTP server have users this application will never have, and the Blender bridge needs the port Albedo refuses to open. Libraries in, everything else stays where it works. |
