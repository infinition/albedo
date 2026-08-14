# Albedo Supported Formats & Decoders

Complete status, technical specifications, and custom format reader documentation for Albedo.

Legend: **[x]** loaded from an actual file and measured, **[ ]** implemented but not yet put in front of one. Rows whose evidence says "generated" were checked against a file written by `tools/make-samples.mjs`, not one found in the wild.

## Supported Formats

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

Formats that are deliberately refused report why: `.blend` is an internal Blender file, `.max`, `.ma` and `.mb` are closed formats. Export to glTF.

---

## Files that travel beside a result

A retopology result is a GLB, and glTF has nowhere to put three things the viewer
needs. Rather than invent a container, each one is written as a plain little file
next to the model, named `<result>.<kind>`, little endian throughout.

| File | One per | Type | Meaning |
| --- | --- | --- | --- |
| `.quads` | triangle | `u32` | Bit `k` set means the edge from corner `k` to `k+1` is real. The cleared bit on a paired triangle is the quad's diagonal. |
| `.charts` | triangle | `u32` | Which atlas chart the triangle landed in. Written only when a bake ran and the mapping could be vouched for. |
| `.dev` | **vertex** | `f32` | How far the result moved from the source, in model units. |

Two things worth knowing about them. `.dev` is indexed by *vertex* where the other
two are indexed by *triangle*, so a reader that un-indexes the geometry has to
capture the index buffer before discarding it or the heatmap comes out plausible
and wrong. And `.charts` is deliberately absent rather than approximate when the
triangle counts do not line up: a shifted chart mask paints a perfectly
believable atlas layout that is false everywhere.

They are read back through a single command, `retopo_sidecar`, which returns all
three as `f32`. That is safe rather than sloppy: a quad mask is `0..7` and a chart
id counts islands, both far below the 2^24 where `f32` stops representing
integers exactly.

---

## Custom Format Readers

### NIF Reader (NetImmerse / Gamebryo)

NIF carries no block size table before version 20.2, so a single mis-sized field silently corrupts everything after it. The reader was measured against a strict criterion: the file footer has to land exactly on the last byte.

Benchmark results on the Dark Age of Camelot client (10,043 files across four versions):

| Version | Files | Read exactly |
| --- | --- | --- |
| Gamebryo 10.1.0.0 | 4,955 | 4,943 |
| NetImmerse 4.2.2.0 | 2,644 | 2,640 |
| NetImmerse 4.2.1.0 | 2,194 | 2,184 |
| NetImmerse 4.1.0.12 | 250 | 234 |

10,001 of 10,043 files (99.6%) read bit-exact. All 10,043 build without an exception, for a total of 19,279 meshes, 4.4 million triangles, 5,108 animation clips, and 264,095 bones. Files that stop early still render everything read up to that point.

Supported structures:
- Node hierarchy, geometry, triangle strips, materials
- DDS and TGA textures
- Alpha properties, skeletons, keyframe curves, and particle systems
- Skeleton files without geometry display their bone tree instead of an empty viewport

### USD Crate Reader (`PXR-USDC`)

three.js only reads ASCII USD inside `.usdz` archives. Albedo adds a native reader for binary USDC crates and loose USD packages:

- **Crate Parsing**: LZ4 decompression, OpenUSD delta & code integer encoding, and decoding for all six sections (tokens, strings, fields, field sets, paths, specs).
- **Loose Files**: `.usd` and `.usda` loose files are repackaged in memory with textures found beside them.
- **Texture Transcoding**: Non-PNG textures are transcoded automatically.
- **Compressed Float Arrays**: Integer decoder fallback for compressed floats (e.g. skin weights).
- **`UsdPreviewSurface` Workflows**: Full support for both `glossiness` and `roughness` surface workflows.
- **UV Coordinates**: Default bottom-left orientation matching three.js coordinates.
