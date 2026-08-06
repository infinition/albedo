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
    this.mode = "shaded";
    this.wireframe = false;
  }

  reset() {
    this.original.clear();
    this.mode = "shaded";
  }

  remember(mesh) {
    if (!this.original.has(mesh)) this.original.set(mesh, mesh.material);
  }

  build(mat, channel) {
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
    const root = this.viewer.root;
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      if (mode === "shaded") {
        o.material = source;
      } else {
        const make = (m) => {
          const built = this.build(m, mode);
          built.wireframe = this.wireframe;
          return built;
        };
        o.material = Array.isArray(source) ? source.map(make) : make(source);
      }
      if (mode === "shaded") this.setWireframeOn(o.material, this.wireframe);
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
