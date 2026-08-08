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

## Lighting & Post-Processing Pipeline

### Dynamic Light Rig

Custom directional, point, and spot lights are specified by bearing, height, and distance scaled to a multiple of the model's bounding sphere radius.

### Post-Processing Pass Execution Order

To maintain physically accurate light transport, post-processing passes are strictly ordered:

1. **Linear Optical Passes** (before tone mapping): GTAO (Ground Truth Ambient Occlusion), Bloom, Depth of Field.
2. **Darkroom / Grading Passes** (after tone mapping): Contrast, Saturation, Temperature, Vignette, Grain, Chromatic Aberration, Sharpening.
3. **Final Pass**: SMAA (Subpixel Morphological Antialiasing).

Background clear colors are pre-compensated by inverting the tone curve to prevent backdrop darkening when post-processing is active.

---

## Multi-File Scenes & Responsive Container Queries

- **Scene Import**: Additional 3D models can be imported alongside existing models, positioned independently, and exported together as a single glTF scene.
- **Center of Rotation**: Pivot point can be toggled between bounding box center and vertex position average.
- **Container Queries**: UI overlays and drawers use CSS Container Queries (`cqw` / `cqh`) based on the stage container width rather than window dimensions, ensuring responsive layouts when the library preview strip is open.
