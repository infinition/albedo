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

    // A skinned mesh stores its points in bind space, which is not where the
    // model stands: without this the silhouette is simply the wrong shape.
    applySkinning(crate, primPath, geometry, { fieldsAt, valueAt });

    // Whether the back of a surface is drawn at all. USD says single sided
    // unless told otherwise, and an open mouth or a cloak reads as holes when
    // that is guessed rather than read.
    if (valueAt(`${primPath}.doubleSided`) === true) material.side = THREE.DoubleSide;

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

  /**
   * Read one input of the surface shader.
   *
   * An input either states a value or is wired to another shader. Following the
   * wire is what tells a diffuse texture from a normal map: they are both an
   * `inputs:file` on some texture reader, and taking whichever came last put
   * normal maps in the albedo slot.
   *
   * @returns {{value: *}|{file: string}|null}
   */
  function readInput(shaderPath, name) {
    const fields = fieldsAt(`${shaderPath}.${name}`);
    if (!fields) return null;

    const wired = crate.value(fields.connectionPaths) || crate.value(fields.connectionChildren);
    const target = Array.isArray(wired) ? wired[0] : wired;
    if (target) {
      // The wire lands on an output; the reader is the prim that owns it.
      const reader = target.split(".")[0];
      const file = valueAt(`${reader}.inputs:file`);
      if (file) return { file, reader };
    }
    if (fields.default) return { value: crate.value(fields.default) };
    return null;
  }

  function getMaterial(materialPath) {
    if (!materialPath) return defaultMaterial();
    if (materials.has(materialPath)) return materials.get(materialPath);

    // UsdPreviewSurface's own defaults, so a file that states nothing lands
    // where the specification says it should.
    const material = new THREE.MeshPhysicalMaterial({
      name: materialPath.split("/").pop(),
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0,
      envMapIntensity: 1,
    });

    // The surface shader is whatever the material's surface output points at,
    // falling back to the one shader below it that says it is a preview surface.
    const surface =
      readInput(materialPath, "outputs:surface")?.reader ||
      crate.specs.find(
        (s) =>
          s.path.startsWith(`${materialPath}/`) &&
          s.path.endsWith(".info:id") &&
          crate.value(crate.fieldsOf(s).default) === "UsdPreviewSurface"
      )?.path.split(".")[0];
    if (!surface) {
      materials.set(materialPath, material);
      return material;
    }

    const texture = (file, srgb) => {
      const url = resolveTexture ? resolveTexture(file) : null;
      if (!url) return null;
      const tex = url.isTexture ? url : new THREE.TextureLoader().load(url);
      // USD st coordinates start at the bottom left of the image, which is
      // three's default orientation. Forcing flipY off is the glTF convention
      // and turns every USD texture upside down.
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      return tex;
    };

    const wire = (name, slot, srgb, apply) => {
      const input = readInput(surface, name);
      if (!input) return false;
      if (input.file) {
        const tex = texture(input.file, srgb);
        if (tex) {
          material[slot] = tex;
          return true;
        }
        return false;
      }
      apply?.(input.value);
      return false;
    };

    const textured = wire("inputs:diffuseColor", "map", true, (v) => {
      if (v?.length >= 3) material.color.setRGB(v[0], v[1], v[2]);
    });
    if (textured) material.color.setRGB(1, 1, 1);

    wire("inputs:normal", "normalMap", false);
    wire("inputs:occlusion", "aoMap", false);
    wire("inputs:emissiveColor", "emissiveMap", true, (v) => {
      if (v?.length >= 3 && (v[0] || v[1] || v[2])) material.emissive.setRGB(v[0], v[1], v[2]);
    });
    wire("inputs:metallic", "metalnessMap", false, (v) => {
      if (typeof v === "number") material.metalness = v;
    });

    // Two workflows exist and half the packages use the specular one, which
    // states glossiness where the other states roughness.
    let roughnessSet = wire("inputs:roughness", "roughnessMap", false, (v) => {
      if (typeof v === "number") {
        material.roughness = v;
        roughnessSet = true;
      }
    });
    if (!roughnessSet) {
      const gloss = readInput(surface, "inputs:glossiness");
      if (typeof gloss?.value === "number") {
        material.roughness = Math.min(1, Math.max(0, 1 - gloss.value));
      }
    }

    // A black specular colour says the surface is matte. Leaving the dielectric
    // default in place put a sheen of reflected environment on a rough hide
    // that the file never asked for, which is the same mistake the glTF
    // specular-glossiness path used to make.
    const specular = readInput(surface, "inputs:specularColor");
    if (specular && !specular.file && specular.value?.length >= 3) {
      const v = specular.value;
      material.specularIntensity = Math.min(1, Math.max(0, Math.max(v[0], v[1], v[2]) * 2));
      const peak = Math.max(v[0], v[1], v[2]);
      if (peak > 0) material.specularColor.setRGB(v[0] / peak, v[1] / peak, v[2] / peak);
    }

    const opacity = readInput(surface, "inputs:opacity");
    if (opacity && !opacity.file && typeof opacity.value === "number" && opacity.value < 1) {
      material.transparent = true;
      material.opacity = opacity.value;
    }

    material.needsUpdate = true;
    materials.set(materialPath, material);
    return material;
  }

  function defaultMaterial() {
    return new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.8, metalness: 0 });
  }
}

const toFloat32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));

/**
 * Put a skinned mesh into its rest pose.
 *
 * A skinned mesh stores its points in bind space, which is not where the model
 * stands: the same alligator came out with a different silhouette from its
 * glTF twin, twenty percent fewer pixels, because the bind pose and the rest
 * pose are different poses and nothing was moving the points between them.
 *
 * UsdSkel says a point lands at the weighted sum of, for each joint, the
 * joint's place in the rest pose times the inverse of where it sat at bind
 * time. Applied here on the points rather than through a skeleton on the GPU,
 * because a still model is what a viewer shows and this is checkable against
 * the same asset in another format.
 *
 * @returns {boolean} whether anything was moved
 */
function applySkinning(crate, primPath, geometry, lookup) {
  const { fieldsAt, valueAt } = lookup;

  const binding = fieldsAt(`${primPath}.skel:skeleton`);
  const target = binding
    ? crate.value(binding.targetPaths) || crate.value(binding.targetChildren)
    : null;
  const skelPath = Array.isArray(target) ? target[0] : target;
  if (!skelPath) return false;

  const joints = valueAt(`${skelPath}.joints`);
  const bind = valueAt(`${skelPath}.bindTransforms`);
  const rest = valueAt(`${skelPath}.restTransforms`);
  const indices = valueAt(`${primPath}.primvars:skel:jointIndices`);
  const weights = valueAt(`${primPath}.primvars:skel:jointWeights`);
  if (!joints || !bind || !rest || !indices || !weights) return false;
  if (bind.length !== joints.length || rest.length !== joints.length) return false;

  const position = geometry.attributes.position;
  const count = position.count;
  const influences = Math.max(1, Math.round(indices.length / count));
  if (indices.length !== count * influences) return false;

  // A joint's parent is the path it hangs off, which the names carry already.
  const order = new Map(joints.map((path, i) => [path, i]));
  const parents = joints.map((path) => {
    const cut = path.lastIndexOf("/");
    return cut < 0 ? -1 : order.get(path.slice(0, cut)) ?? -1;
  });

  // USD writes matrices for row vectors; fromArray reads column major, which is
  // the transpose, so composition reverses and reads as parent times child.
  const local = rest.map((m) => new THREE.Matrix4().fromArray(Array.from(m)));
  const world = new Array(joints.length);
  for (let i = 0; i < joints.length; i++) {
    const parent = parents[i];
    world[i] =
      parent >= 0 && world[parent]
        ? new THREE.Matrix4().multiplyMatrices(world[parent], local[i])
        : local[i].clone();
  }

  const skin = bind.map((m, i) => {
    const inverseBind = new THREE.Matrix4().fromArray(Array.from(m)).invert();
    return new THREE.Matrix4().multiplyMatrices(world[i], inverseBind);
  });

  const geomBind = valueAt(`${primPath}.primvars:skel:geomBindTransform`);
  const bindMatrix =
    geomBind && geomBind.length === 16
      ? new THREE.Matrix4().fromArray(Array.from(geomBind))
      : null;

  const normal = geometry.attributes.normal;
  const source = new THREE.Vector3();
  const moved = new THREE.Vector3();
  const scratch = new THREE.Vector3();
  const normalSource = new THREE.Vector3();
  const normalMoved = new THREE.Vector3();

  for (let v = 0; v < count; v++) {
    source.fromBufferAttribute(position, v);
    if (bindMatrix) source.applyMatrix4(bindMatrix);
    moved.set(0, 0, 0);
    if (normal) {
      normalSource.fromBufferAttribute(normal, v);
      normalMoved.set(0, 0, 0);
    }

    let total = 0;
    for (let k = 0; k < influences; k++) {
      const weight = weights[v * influences + k];
      if (!weight) continue;
      const joint = skin[indices[v * influences + k]];
      if (!joint) continue;
      total += weight;
      moved.addScaledVector(scratch.copy(source).applyMatrix4(joint), weight);
      if (normal) {
        normalMoved.addScaledVector(
          scratch.copy(normalSource).transformDirection(joint),
          weight
        );
      }
    }
    // A vertex nothing claims stays where it was rather than collapsing to the
    // origin, which is what an unweighted stray would otherwise do.
    if (total <= 0) continue;
    position.setXYZ(v, moved.x, moved.y, moved.z);
    if (normal) {
      normalMoved.normalize();
      normal.setXYZ(v, normalMoved.x, normalMoved.y, normalMoved.z);
    }
  }

  position.needsUpdate = true;
  if (normal) normal.needsUpdate = true;
  geometry.computeBoundingSphere();
  return true;
}

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
