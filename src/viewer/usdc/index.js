import * as THREE from "three";
import { CrateFile, TYPES } from "./crate.js";

export { CrateFile, TYPES };

/**
 * Build a three.js scene from a decoded crate.
 *
 * USD describes a stage as prims addressed by path, with attributes hanging
 * off them as separate specs. Meshes are found by looking for a `points`
 * attribute, their place in the world comes from the transforms on their
 * ancestors, and their look from the material they bind.
 */
export function buildFromCrate(crate, { resolveTexture } = {}) {
  const byPath = new Map();
  for (const spec of crate.specs) byPath.set(spec.path, spec);

  const fieldsAt = (path) => {
    const spec = byPath.get(path);
    return spec ? crate.fieldsOf(spec) : null;
  };
  const valueAt = (path, field = "default") => {
    const fields = fieldsAt(path);
    return fields ? crate.value(fields[field]) : null;
  };

  const root = new THREE.Group();
  root.name = "USD";

  // Stage metadata lives on the pseudo root.
  const stage = fieldsAt("/");
  const upAxis = stage ? crate.value(stage.upAxis) : "Y";
  if (upAxis === "Z") root.rotation.x = -Math.PI / 2;
  // metersPerUnit says what a unit means, it is not a transform to apply: the
  // stage's own matrices already carry whatever scaling the author wanted.

  const materials = new Map();
  const meshPaths = crate.specs
    .filter((s) => s.path.endsWith(".points"))
    .map((s) => s.path.slice(0, -".points".length));

  for (const primPath of meshPaths) {
    const points = valueAt(`${primPath}.points`);
    const indices = valueAt(`${primPath}.faceVertexIndices`);
    const counts = valueAt(`${primPath}.faceVertexCounts`);
    if (!points || !indices || !counts) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(toFloat32(points), 3));

    const normals = valueAt(`${primPath}.normals`);
    const uvs = valueAt(`${primPath}.primvars:st0`) || valueAt(`${primPath}.primvars:st`);

    // USD stores arbitrary polygons; three needs triangles.
    const triangles = triangulate(indices, counts);
    geometry.setIndex(triangles);

    if (normals && normals.length === points.length) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(toFloat32(normals), 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (uvs && uvs.length / 2 === points.length / 3) {
      geometry.setAttribute("uv", new THREE.BufferAttribute(toFloat32(uvs), 2));
    }
    geometry.computeBoundingSphere();

    const binding = fieldsAt(`${primPath}.material:binding`);
    const target = binding ? crate.value(binding.targetPaths) || crate.value(binding.targetChildren) : null;
    const materialPath = Array.isArray(target) ? target[0] : target;
    const material = getMaterial(materialPath);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = primPath.split("/").pop();
    mesh.applyMatrix4(worldMatrix(primPath));
    root.add(mesh);
  }

  return root;

  /** Compose the transforms carried by a prim and its ancestors. */
  function worldMatrix(primPath) {
    const chain = [];
    let path = primPath;
    while (path && path !== "/") {
      chain.unshift(path);
      const cut = path.lastIndexOf("/");
      path = cut > 0 ? path.slice(0, cut) : "/";
    }
    const out = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    for (const step of chain) {
      const m = valueAt(`${step}.xformOp:transform`);
      if (!m || m.length !== 16) continue;
      // USD matrices are row major with row vectors, which is exactly what
      // fromArray reads as column major: the transpose it needs.
      local.fromArray(Array.from(m));
      out.multiply(local);
    }
    return out;
  }

  function getMaterial(materialPath) {
    if (!materialPath) return defaultMaterial();
    if (materials.has(materialPath)) return materials.get(materialPath);

    const material = new THREE.MeshStandardMaterial({
      name: materialPath.split("/").pop(),
      color: 0xffffff,
      // UsdPreviewSurface's own defaults, so a file that states nothing lands
      // where the specification says it should.
      roughness: 0.5,
      metalness: 0,
      envMapIntensity: 1,
    });
    let glossiness = null;
    let hasRoughness = false;

    // Walk the shader network below the material and take what is useful.
    for (const spec of crate.specs) {
      if (!spec.path.startsWith(materialPath + "/")) continue;
      const name = spec.path.slice(spec.path.lastIndexOf(".") + 1);
      const fields = crate.fieldsOf(spec);
      if (name === "inputs:file") {
        const file = crate.value(fields.default);
        const url = file && resolveTexture ? resolveTexture(file) : null;
        if (url) {
          const texture = url.isTexture ? url : new THREE.TextureLoader().load(url);
          texture.colorSpace = THREE.SRGBColorSpace;
          // USD st coordinates start at the bottom left of the image, which is
          // three's default orientation. Forcing flipY off is the glTF
          // convention and turns every USD texture upside down.
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          material.map = texture;
          material.needsUpdate = true;
        }
      } else if (name === "inputs:diffuseColor" && !material.map) {
        const c = crate.value(fields.default);
        if (c && c.length >= 3) material.color.setRGB(c[0], c[1], c[2]);
      } else if (name === "inputs:roughness") {
        const v = crate.value(fields.default);
        if (typeof v === "number") {
          material.roughness = v;
          hasRoughness = true;
        }
      } else if (name === "inputs:glossiness") {
        // UsdPreviewSurface has two workflows, and half the packages in the
        // wild use the specular one: it states glossiness where the other
        // states roughness. Ignoring it left every such surface at the default,
        // which on a rough hide reads as a white sheen of reflected
        // environment that the file never asked for.
        const v = crate.value(fields.default);
        if (typeof v === "number") glossiness = v;
      } else if (name === "inputs:metallic") {
        const v = crate.value(fields.default);
        if (typeof v === "number") material.metalness = v;
      } else if (name === "inputs:opacity") {
        const v = crate.value(fields.default);
        if (typeof v === "number" && v < 1) {
          material.transparent = true;
          material.opacity = v;
        }
      }
    }

    // Applied after the walk: the two workflows can both appear in one file,
    // and an explicit roughness is the more direct statement of the two.
    if (glossiness !== null && !hasRoughness) {
      material.roughness = Math.min(1, Math.max(0, 1 - glossiness));
    }

    materials.set(materialPath, material);
    return material;
  }

  function defaultMaterial() {
    return new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.8, metalness: 0 });
  }
}

const toFloat32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));

/** Fan-triangulate the polygons a face-count array describes. */
function triangulate(indices, counts) {
  let total = 0;
  for (let i = 0; i < counts.length; i++) total += Math.max(0, counts[i] - 2);
  const out = total * 3 > 65535 ? new Uint32Array(total * 3) : new Uint16Array(total * 3);

  let read = 0;
  let write = 0;
  for (let f = 0; f < counts.length; f++) {
    const n = counts[f];
    for (let k = 1; k + 1 < n; k++) {
      out[write++] = indices[read];
      out[write++] = indices[read + k];
      out[write++] = indices[read + k + 1];
    }
    read += n;
  }
  return new THREE.BufferAttribute(out, 1);
}
