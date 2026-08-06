import * as THREE from "three";

/**
 * Inspection channels.
 *
 * Each mode swaps every material for a flat, unlit view of one PBR input, so
 * what you see is the texture itself, not the texture under lighting. The
 * originals are cached and restored when going back to "shaded".
 */
export const CHANNELS = [
  { id: "shaded", label: "Rendu" },
  { id: "unlit", label: "Handpainted" },
  { id: "albedo", label: "Albedo" },
  { id: "normalMap", label: "Normales" },
  { id: "roughness", label: "Rugosité" },
  { id: "metalness", label: "Métal" },
  { id: "ao", label: "AO" },
  { id: "emissive", label: "Émissif" },
  { id: "opacity", label: "Alpha" },
  { id: "normalGeom", label: "Normales géo" },
  { id: "uv", label: "UV" },
];

const MAP_OF = {
  albedo: "map",
  normalMap: "normalMap",
  roughness: "roughnessMap",
  metalness: "metalnessMap",
  ao: "aoMap",
  emissive: "emissiveMap",
  opacity: "alphaMap",
};

// Constant fallbacks when a channel has no texture: show the scalar factor.
function fallbackColor(mat, channel) {
  const grey = (v) => new THREE.Color(v, v, v);
  switch (channel) {
    case "albedo":
      return mat.color ? mat.color.clone() : new THREE.Color(0xcccccc);
    case "roughness":
      return grey(mat.roughness ?? 1);
    case "metalness":
      return grey(mat.metalness ?? 0);
    case "ao":
      return grey(1);
    case "emissive":
      return mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000);
    case "opacity":
      return grey(mat.opacity ?? 1);
    case "normalMap":
      return new THREE.Color(0.5, 0.5, 1);
    default:
      return grey(0.8);
  }
}

let checkerTexture = null;
function uvChecker() {
  if (checkerTexture) return checkerTexture;
  const size = 512;
  const cells = 16;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const even = (x + y) % 2 === 0;
      ctx.fillStyle = even ? "#3d434f" : "#c8ccd4";
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  ctx.strokeStyle = "#4c8dff";
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  checkerTexture = new THREE.CanvasTexture(c);
  checkerTexture.colorSpace = THREE.SRGBColorSpace;
  checkerTexture.wrapS = checkerTexture.wrapT = THREE.RepeatWrapping;
  return checkerTexture;
}

export class ChannelView {
  constructor(viewer) {
    this.viewer = viewer;
    this.original = new Map(); // mesh -> material(s)
    /** Per material override of the render mode, keyed by material uuid. */
    this.materialModes = new Map();
    this.built = new Map(); // uuid|channel -> material, so toggling is cheap
    this.mode = "shaded";
    this.wireframe = false;
  }

  reset() {
    this.original.clear();
    this.materialModes.clear();
    this.built.clear();
    this.mode = "shaded";
  }

  /** The distinct materials of the loaded model, for the inspector list. */
  materials() {
    const out = [];
    const seen = new Set();
    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      for (const m of Array.isArray(source) ? source : [source]) {
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        out.push({ uuid: m.uuid, name: m.name || "(sans nom)", textured: !!m.map });
      }
    });
    return out;
  }

  /**
   * Set one material's render mode.
   *
   * A model is rarely all one thing: painted skin wants to be shown flat while
   * the eyes it carries are genuinely shiny, so the choice is per material and
   * the viewport toggle only sets the default.
   */
  setMaterialMode(uuid, mode) {
    if (mode) this.materialModes.set(uuid, mode);
    else this.materialModes.delete(uuid);
    this.apply(this.mode);
  }

  /** Which channel a given material should be drawn with. */
  channelFor(material, mode) {
    // Inspection channels are a whole-model view; only the two render modes
    // are per material.
    if (mode !== "shaded" && mode !== "unlit") return mode;
    return this.materialModes.get(material?.uuid) || mode;
  }

  remember(mesh) {
    if (!this.original.has(mesh)) this.original.set(mesh, mesh.material);
  }

  build(mat, channel) {
    if (channel === "unlit") {
      // Hand-painted art bakes its own light into the texture, so lighting it
      // again is what puts the veil on it. Unlike the inspection channels this
      // is a way to actually look at the model, so masks, blending and vertex
      // colours are carried over instead of being flattened away.
      const out = new THREE.MeshBasicMaterial({
        map: mat.map || null,
        color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
        side: mat.side,
        transparent: mat.transparent,
        opacity: mat.opacity ?? 1,
        alphaTest: mat.alphaTest ?? 0,
        alphaMap: mat.alphaMap || null,
        depthWrite: mat.depthWrite !== false,
        vertexColors: !!mat.vertexColors,
      });
      if (mat.aoMap) {
        out.aoMap = mat.aoMap;
        out.aoMapIntensity = mat.aoMapIntensity ?? 1;
      }
      // No tone mapping: the point of this mode is the texture as authored.
      out.toneMapped = false;
      return out;
    }
    if (channel === "normalGeom") {
      return new THREE.MeshNormalMaterial({ side: mat.side, flatShading: false });
    }
    if (channel === "uv") {
      return new THREE.MeshBasicMaterial({ map: uvChecker(), side: mat.side });
    }
    const key = MAP_OF[channel];
    const tex = key ? mat[key] : null;
    const out = new THREE.MeshBasicMaterial({
      side: mat.side,
      transparent: false,
      map: tex || null,
      color: tex ? 0xffffff : fallbackColor(mat, channel),
    });
    if (tex) {
      // data maps are linear; only the base colour lives in sRGB
      out.map = tex;
      out.toneMapped = channel === "albedo" || channel === "emissive";
    } else {
      out.toneMapped = false;
    }
    return out;
  }

  apply(mode) {
    this.mode = mode;
    const make = (m) => {
      if (!m) return m;
      const channel = this.channelFor(m, mode);
      if (channel === "shaded") {
        this.setWireframeOn(m, this.wireframe);
        return m;
      }
      const key = `${m.uuid}|${channel}`;
      let built = this.built.get(key);
      if (!built) {
        built = this.build(m, channel);
        this.built.set(key, built);
      }
      built.wireframe = this.wireframe;
      return built;
    };

    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      o.material = Array.isArray(source) ? source.map(make) : make(source);
    });
    this.viewer.invalidate();
  }

  setWireframeOn(material, on) {
    for (const m of Array.isArray(material) ? material : [material]) {
      if (m && "wireframe" in m) m.wireframe = on;
    }
  }

  setWireframe(on) {
    this.wireframe = on;
    this.viewer.root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) this.setWireframeOn(o.material, on);
    });
    this.viewer.invalidate();
  }
}
