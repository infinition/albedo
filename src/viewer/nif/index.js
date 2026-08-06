import * as THREE from "three";
import { parseNif } from "./parser.js";

export { parseNif } from "./parser.js";

/**
 * NIF to three.js.
 *
 * Turns the parsed block graph into a scene: node hierarchy, meshes, materials,
 * external textures and keyframe animations. Files that hold only a node tree
 * (the skeletons games keep in their own file) come back as bones with a
 * visible helper, so opening one shows something instead of an empty viewport.
 */

const baseName = (p) => (p || "").split(/[\\/]/).pop() || "";
const lower = (p) => baseName(p).toLowerCase();

/**
 * @param {string} url
 * @param {object} options
 * @param {{name: string, url: string}[]} [options.candidates] texture files
 *   already known to sit near the model.
 * @param {(names: string[]) => Promise<{name: string, url: string}[]>} [options.findTextures]
 *   asked for the exact file names the NIF references. A NIF names its maps, so
 *   they are looked up rather than guessed from naming conventions, and the
 *   search can reach the shared texture folder a game keeps them in.
 */
export async function loadNIF(url, { candidates = [], findTextures } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lecture impossible (${res.status})`);
  const nif = parseNif(await res.arrayBuffer());

  let pool = candidates;
  if (findTextures) {
    const wanted = textureNames(nif).filter((n) => !pool.some((c) => lower(c.name) === lower(n)));
    if (wanted.length) {
      const found = await findTextures(wanted).catch(() => []);
      if (found?.length) pool = pool.concat(found);
    }
  }
  return buildNIF(nif, { candidates: pool, name: baseName(url.split(/[?#]/)[0]) });
}

/** Every external map the file references, base name only. */
export function textureNames(nif) {
  const out = new Set();
  for (const b of nif.blocks) {
    if (b?.kind === "NiSourceTexture" && b.file) out.add(baseName(b.file));
  }
  return [...out];
}

export async function buildNIF(nif, { candidates = [], name = "model.nif" } = {}) {
  const byName = new Map();
  for (const c of candidates) if (!byName.has(lower(c.name))) byName.set(lower(c.name), c.url);

  const textures = new TextureCache(byName);
  const root = new THREE.Group();
  root.name = name;

  // NIF is Z-up; three is Y-up. Rotating the wrapper leaves every transform,
  // bone and animation curve below it untouched.
  const zUp = new THREE.Group();
  zUp.name = "Z_up_to_Y_up";
  zUp.rotation.x = -Math.PI / 2;
  root.add(zUp);

  const geometryCount = nif.blocks.filter((b) => b?.geometry?.indices?.length).length;
  const nodeCount = nif.blocks.filter((b) => b?.kind === "NiNode").length;
  // A file with a deep node tree and no geometry is a skeleton.
  const asBones = geometryCount === 0 && nodeCount >= 3;

  const built = new Map(); // block index -> Object3D
  const names = new Set();
  const pending = [];

  const uniqueName = (raw, fallback) => {
    let n = raw || fallback;
    if (!names.has(n)) {
      names.add(n);
      return n;
    }
    for (let i = 2; ; i++) {
      const candidate = `${n}_${i}`;
      if (!names.has(candidate)) {
        names.add(candidate);
        return candidate;
      }
    }
  };

  const build = (index, depth) => {
    const b = nif.blocks[index];
    if (!b || built.has(index) || depth > 256) return null;

    let obj = null;
    if (b.kind === "NiTriShape" || b.kind === "NiTriStrips") {
      obj = makeMesh(b, nif, textures, pending);
    } else if (b.children || b.transform) {
      obj = asBones && b.kind === "NiNode" ? new THREE.Bone() : new THREE.Group();
    }
    if (!obj) return null;

    obj.name = uniqueName(b.name, `${b.kind}_${index}`);
    obj.userData.nifBlock = index;
    obj.userData.nifKind = b.kind;
    if (b.transform) applyTransform(obj, b.transform);
    built.set(index, obj);

    for (const child of b.children || []) {
      const c = build(child, depth + 1);
      if (c) obj.add(c);
    }
    return obj;
  };

  for (const r of nif.roots) {
    const o = build(r, 0);
    if (o) zUp.add(o);
  }
  // Anything the roots did not reach: keep it rather than silently dropping it.
  for (const b of nif.blocks) {
    if (!b || built.has(b.index)) continue;
    if (b.kind !== "NiTriShape" && b.kind !== "NiTriStrips") continue;
    const o = build(b.index, 0);
    if (o) zUp.add(o);
  }

  // A bones-only file has nothing to rasterise; the viewer draws the helper.
  if (asBones && [...built.values()].some((o) => o.isBone)) {
    root.updateMatrixWorld(true);
    root.userData.boneTree = true;
  }

  await Promise.all(pending);

  const animations = buildAnimations(nif, built, name);

  return {
    object: root,
    animations,
    info: {
      version: nif.versionName,
      blocks: nif.blocks.length,
      meshes: geometryCount,
      bones: asBones ? nodeCount : 0,
      warnings: nif.warnings,
    },
  };
}

/** NIF stores rotation column by column, which is Matrix4.elements order. */
function applyTransform(obj, t) {
  const r = t.rotation;
  const m = new THREE.Matrix4().set(
    r[0], r[3], r[6], 0,
    r[1], r[4], r[7], 0,
    r[2], r[5], r[8], 0,
    0, 0, 0, 1
  );
  obj.quaternion.setFromRotationMatrix(m);
  obj.position.set(t.translation[0], t.translation[1], t.translation[2]);
  obj.scale.setScalar(t.scale || 1);
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

function makeMesh(shape, nif, textures, pending) {
  const data = nif.blocks[shape.data];
  const g = data?.geometry;
  if (!g || !g.indices || !g.indices.length) return null;

  const geometry = new THREE.BufferGeometry();
  if (g.vertices) geometry.setAttribute("position", new THREE.BufferAttribute(g.vertices, 3));
  if (g.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
  if (g.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));
  if (!g.normals) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // Properties are gathered by kind: a shape carries at most one of each.
  const props = (shape.props || []).map((p) => nif.blocks[p]).filter(Boolean);
  const material = props.find((p) => p.kind === "NiMaterialProperty");
  const texturing = props.find((p) => p.kind === "NiTexturingProperty");
  const alpha = props.find((p) => p.kind === "NiAlphaProperty");
  const vcol = props.find((p) => p.kind === "NiVertexColorProperty");
  const wire = props.find((p) => p.kind === "NiWireframeProperty");

  const useColors = !!(vcol && g.colors);
  if (useColors) {
    geometry.setAttribute("color", new THREE.BufferAttribute(g.colors, 4));
  }

  const mat = new THREE.MeshStandardMaterial({
    name: material?.name || shape.name || "NIF",
    color: material ? new THREE.Color(...material.diffuse) : new THREE.Color(0xb9c0cc),
    emissive: material ? new THREE.Color(...material.emissive) : new THREE.Color(0x000000),
    roughness: glossToRoughness(material?.glossiness),
    metalness: 0,
    vertexColors: useColors,
    wireframe: !!wire,
    envMapIntensity: 0.6,
  });

  // A DXT5 map has an alpha channel whether or not it should blend; the shape's
  // NiAlphaProperty is the only reliable signal, and its flags say which of
  // blending and alpha testing the artist actually asked for.
  if (alpha) {
    const blend = (alpha.flags & 0x1) !== 0;
    const test = (alpha.flags & 0x200) !== 0;
    if (blend) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
    if (test) mat.alphaTest = (alpha.threshold ?? 128) / 255;
  }
  if (material && material.alpha < 1) {
    mat.transparent = true;
    mat.opacity = material.alpha;
  }

  const file = texturing?.maps?.base ? nif.blocks[texturing.maps.base.source]?.file : null;
  if (file) {
    pending.push(
      textures.load(file, true).then((t) => {
        if (!t) return;
        mat.map = t;
        // The base colour tint doubles up with the map on these old materials
        // and turns everything muddy; the map is the intent.
        mat.color.setRGB(1, 1, 1);
        mat.needsUpdate = true;
      })
    );
  }
  const glow = texturing?.maps?.glow ? nif.blocks[texturing.maps.glow.source]?.file : null;
  if (glow) {
    pending.push(
      textures.load(glow, true).then((t) => {
        if (!t) return;
        mat.emissiveMap = t;
        mat.emissive.setRGB(1, 1, 1);
        mat.needsUpdate = true;
      })
    );
  }
  const bump = texturing?.maps?.bump ? nif.blocks[texturing.maps.bump.source]?.file : null;
  if (bump) {
    pending.push(
      textures.load(bump, false).then((t) => {
        if (!t) return;
        mat.bumpMap = t;
        mat.bumpScale = 0.4;
        mat.needsUpdate = true;
      })
    );
  }

  const mesh = new THREE.Mesh(geometry, mat);
  mesh.userData.skinned = shape.skin >= 0;
  return mesh;
}

/** Specular exponent to perceptual roughness, the usual approximation. */
function glossToRoughness(gloss) {
  const s = Math.max(0, Math.min(1000, gloss ?? 20));
  return Math.min(1, Math.max(0.08, Math.sqrt(2 / (s + 2))));
}

class TextureCache {
  constructor(byName) {
    this.byName = byName;
    this.cache = new Map();
    this.loaders = {};
  }

  urlFor(file) {
    const key = lower(file);
    if (this.byName.has(key)) return this.byName.get(key);
    // Games reference .dds while the loose file on disk may be .tga, and back
    const stem = key.replace(/\.[^.]+$/, "");
    for (const ext of ["dds", "tga", "png", "jpg", "jpeg", "bmp"]) {
      const alt = `${stem}.${ext}`;
      if (this.byName.has(alt)) return this.byName.get(alt);
    }
    return null;
  }

  async load(file, srgb) {
    const url = this.urlFor(file);
    if (!url) return null;
    const key = `${url}|${srgb}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const p = this.decode(url)
      .then((t) => {
        if (!t) return null;
        // NIF UVs follow the DirectX convention (v grows downwards), which is
        // what an unflipped upload gives. Compressed formats cannot be flipped
        // at all, so not flipping anything keeps both paths consistent.
        t.flipY = false;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        t.needsUpdate = true;
        return t;
      })
      .catch(() => null);
    this.cache.set(key, p);
    return p;
  }

  async decode(url) {
    const clean = url.split(/[?#]/)[0].toLowerCase();
    if (clean.endsWith(".dds")) {
      if (!this.loaders.dds) {
        const { DDSLoader } = await import("three/examples/jsm/loaders/DDSLoader.js");
        this.loaders.dds = new DDSLoader();
      }
      return this.loaders.dds.loadAsync(url);
    }
    if (clean.endsWith(".tga")) {
      if (!this.loaders.tga) {
        const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
        this.loaders.tga = new TGALoader();
      }
      return this.loaders.tga.loadAsync(url);
    }
    if (!this.loaders.plain) this.loaders.plain = new THREE.TextureLoader();
    return this.loaders.plain.loadAsync(url);
  }
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/**
 * Keyframe controllers hang off the nodes they drive. In animation-only files
 * the controller's own `target` is -1, so the link that counts is the node
 * pointing at its controller.
 */
function buildAnimations(nif, built, name) {
  const tracks = [];
  let duration = 0;

  for (const [index, obj] of built) {
    const block = nif.blocks[index];
    if (!block) continue;

    for (let ref = block.controller; ref >= 0; ) {
      const ctrl = nif.blocks[ref];
      if (!ctrl) break;
      if (ctrl.kind === "NiKeyframeController" || ctrl.kind === "NiTransformController") {
        const data = nif.blocks[ctrl.data];
        if (data) duration = Math.max(duration, addTracks(tracks, obj.name, data));
      }
      ref = ctrl.next ?? -1;
    }
  }

  if (!tracks.length) return [];
  const clip = new THREE.AnimationClip(
    name.replace(/\.[^.]+$/, "") || "NIF",
    duration || undefined,
    tracks
  );
  return [clip];
}

function addTracks(tracks, target, data) {
  let last = 0;
  const times = (keys) => keys.map((k) => k[0]);
  const end = (keys) => (keys.length ? keys[keys.length - 1][0] : 0);

  if (data.rotations?.length) {
    const values = [];
    for (const [, q] of data.rotations) values.push(q[0], q[1], q[2], q[3]);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, times(data.rotations), values));
    last = Math.max(last, end(data.rotations));
  } else if (data.euler?.length === 3 && data.euler.some((c) => c.length)) {
    const sampled = eulerToQuaternion(data.euler);
    if (sampled) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, sampled.times, sampled.values));
      last = Math.max(last, sampled.times[sampled.times.length - 1] || 0);
    }
  }

  if (data.translations?.length) {
    const values = [];
    for (const [, v] of data.translations) values.push(v[0], v[1], v[2]);
    tracks.push(new THREE.VectorKeyframeTrack(`${target}.position`, times(data.translations), values));
    last = Math.max(last, end(data.translations));
  }

  if (data.scales?.length) {
    const values = [];
    for (const [, s] of data.scales) values.push(s, s, s);
    tracks.push(new THREE.VectorKeyframeTrack(`${target}.scale`, times(data.scales), values));
    last = Math.max(last, end(data.scales));
  }
  return last;
}

/**
 * XYZ rotation keys are three independent angle curves. three has no such
 * track, so they are sampled onto the union of their key times and composed
 * into quaternions.
 */
function eulerToQuaternion(curves) {
  const set = new Set();
  for (const c of curves) for (const [t] of c) set.add(t);
  const times = [...set].sort((a, b) => a - b);
  if (!times.length) return null;

  const sample = (keys, t) => {
    if (!keys.length) return 0;
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t > keys[i][0]) continue;
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const span = t1 - t0;
      return span > 0 ? v0 + ((v1 - v0) * (t - t0)) / span : v1;
    }
    return keys[keys.length - 1][1];
  };

  const euler = new THREE.Euler();
  const q = new THREE.Quaternion();
  const values = [];
  for (const t of times) {
    euler.set(sample(curves[0], t), sample(curves[1], t), sample(curves[2], t), "XYZ");
    q.setFromEuler(euler);
    values.push(q.x, q.y, q.z, q.w);
  }
  return { times, values };
}
