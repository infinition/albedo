# Adaptive reconstruction and guided quad pairing

This implementation improves Albedo's existing CPU pipeline in Rust. It is a
deterministic geometry heuristic, not a trained model, semantic loop generator,
seamless integer-grid solver or demonstrated new state of the art.

## Modes

- **Decimate** keeps the existing QEM path and its UV/seam cost controls.
- **Uniform** reconstructs with a common target edge length.
- **Adaptive** interpolates a source-curvature size field through the source BVH
  to spend more elements around bends and fewer on flatter regions.

Reconstruction destroys the original UV layout; bake when textures must survive.
The requested triangle budget is approximate. Protecting many borders and
creases can make a low budget unreachable, and the UI reports a large overshoot.
Both hard-surface and organic assets can benefit from quads. Deformation and
subdivision needs determine the appropriate topology; organic does not imply
triangles, and hard-surface does not imply quads in every use case.

## Implemented changes

The sizing field uses area-normalized dihedral curvature, stable `atan2` angles
and bounded spatial gradation. It stays attached to the original source instead
of mistaking newly coarse facets for features. Split/collapse operations use the
local target sizes; constrained source edges are carried across iterations.
Boundaries, creases and non-manifold regions are protected. Collapses reject
duplicate surviving faces; relaxation backtracks invalid or inverted moves and
projects accepted vertices to the source. Operation ordering is deterministic.

Quad candidates must be convex, consistently wound, manifold across the shared
edge, and within the same material. A fourfold tangent field transports
`exp(4 i theta)` directions over adjacent faces and diffuses boundary/crease
seeds with a bounded iteration count. Direction confidence supplements shape
quality. Short augmenting paths repair greedy matching, including odd cycles.
This does not solve globally optimal matching or design animation-ready loops.

The output remains a **triangulated GLB with a `.quads` edge mask**. The mask
describes paired triangles and hides their internal diagonals in Albedo; it does
not make the GLB a native polygon-quad interchange format. Pairing runs after
baking, and masks follow exported material primitive ordering. Disabling quads
removes a stale sidecar rather than loading an earlier result's mask.

Other fixes: zero iterations is respected; an unlimited deviation value behaves
consistently between API and CLI; unknown modes fail explicitly; multi-object
reports preserve worst deviation; deviation overlays use the shared vertex
accessor across material primitives. Normal generation now builds local vertex
fans and splits render vertices across creases without splitting welded topology.

## Reproducible local measurement

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example retopo_quality -- input.glb 5000
```

The local `testdata/test.glb` scene contains 109,840 usable input triangles and
5,704 boundary edges. One run on the development Windows machine, optimized
geometry crates in the dev profile, produced:

| Mode | Output triangles | Remesh time | Geometry-only greedy quads | Guided/repaired quads | Pairing time | Sampled deviation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Uniform | 49,142 | 2,082 ms | 12,589 | 12,831 | 44 ms | 0.209598 |
| Adaptive | 51,332 | 2,905 ms | 13,851 | 14,153 | 54 ms | 0.171491 |

Both results had zero non-manifold edge incidents. The 5,000-triangle request
was **not reached** under preserved constraints. Adaptive retained more
triangles and reduced this sampled error; this is not a same-budget superiority
claim. Guided pairing recovered about 2% more quads than the geometry-only greedy
baseline on the same respective meshes. Timings are single-run observations,
not a hardware-independent benchmark. Error is measured in model units from
bidirectional vertex/centroid samples; it is not a Hausdorff bound.

Regression coverage includes scale invariance, repeated deterministic output,
closed-surface topology, protected creases/borders, non-manifold pairing refusal,
concave/folded quads, augmenting paths, aggressive relaxation, and GLB/sidecar
round trips for all three modes. Production comparison against established
retopology systems still requires a representative public asset corpus and
equal-budget quality measurements.
