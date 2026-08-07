import * as THREE from "three";
import { releaseMaterials } from "./release.js";

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
    /** Materials the user has taken out of the way, keyed by uuid. */
    this.hiddenMaterials = new Set();
    this.built = new Map(); // uuid|channel -> material, so toggling is cheap
    this.mode = "shaded";
    this.wireframe = false;
  }

  reset() {
    // These maps are the other half of the model's materials: the ones built
    // per channel, and the originals held on the meshes' behalf while a channel
    // was showing. The viewer released what was attached; this releases what
    // was set aside. The checker survives both, being made once and shared by
    // every UV view there will ever be.
    const keep = this.viewer.keptTextures();
    if (checkerTexture) keep.add(checkerTexture);
    releaseMaterials(
      [...this.built.values(), ...this.original.values(), ...(this.pristine?.values() || [])],
      keep
    );
    this.original.clear();
    this.materialModes.clear();
    this.hiddenMaterials.clear();
    this.pristine?.clear();
    this.built.clear();
    this.mode = "shaded";
  }

  /**
   * A transparency that cannot vary is a transparency that was lost.
   *
   * An exporter writes blending only when the source material had some, so a
   * material that asks for it while carrying no alpha map, no texture and full
   * opacity is describing something the file no longer contains: it draws as a
   * solid slab, which is what the specification says and never what the author
   * drew. Detecting the contradiction takes no file name and no format guess,
   * so it holds for every model; repairing it would take inventing a texture,
   * which is not this program's business.
   */
  static alphaLost(m) {
    return !!m.transparent && (m.opacity ?? 1) >= 1 && !m.alphaMap && !m.map && !m.alphaTest;
  }

  /**
   * Fully transparent, so nothing of it can ever be seen.
   *
   * Sometimes deliberate, for collision or helper geometry, and sometimes an
   * exporter writing a slider into the wrong field: refractive glass is the
   * common one, since its opacity setting is not a coverage. Either way a mesh
   * that draws nothing is worth naming rather than leaving the viewer looking
   * broken.
   */
  static invisible(m) {
    return !!m.transparent && (m.opacity ?? 1) <= 0 && !(m.transmission > 0);
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
        out.push({
          uuid: m.uuid,
          name: m.name || "(sans nom)",
          textured: !!m.map,
          alphaLost: ChannelView.alphaLost(m),
          invisible: ChannelView.invisible(m),
          deadVertexColors: !!m.userData?.deadVertexColors,
          hidden: this.hiddenMaterials.has(m.uuid),
        });
      }
    });
    return out;
  }

  /** The source material behind a uuid, and every mesh drawn with it. */
  usersOf(uuid) {
    const meshes = [];
    let material = null;
    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      for (const m of Array.isArray(source) ? source : [source]) {
        if (!m || m.uuid !== uuid) continue;
        material = m;
        meshes.push(o);
      }
    });
    return { material, meshes };
  }

  /** Rebuild the channel copies after a material changed underneath them. */
  refresh() {
    this.built.clear();
    this.apply(this.mode);
  }

  /**
   * Put another material everywhere one was used.
   *
   * The per material choices travel with it: converting a material to glass
   * must not silently un-hide it or send it back to PBR.
   */
  /**
   * Put the file's own material back.
   *
   * Every substitution remembers what it displaced, so a preset is a thing you
   * try rather than a thing you commit to. An inspection tool that could not
   * undo would be asking the user to trust it about the file.
   */
  restoreMaterial(uuid) {
    const original = this.pristine?.get(uuid);
    if (!original) return null;
    this.pristine.delete(uuid);
    this.swapMaterial(uuid, original, false);
    return original;
  }

  /** Whether this material stands in for one the file actually carries. */
  isSubstitute(uuid) {
    return !!this.pristine?.has(uuid);
  }

  swapMaterial(uuid, next, remember = true) {
    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      const keep = (m) => {
        if (!m || m.uuid !== uuid) return m;
        if (remember && next.uuid !== uuid) {
          this.pristine ||= new Map();
          // The file's material is what the first substitution displaced; a
          // second preset on top of the first must not become the thing to
          // restore, so the origin travels with the chain.
          const origin = this.pristine.get(uuid) || m;
          this.pristine.delete(uuid);
          this.pristine.set(next.uuid, origin);
        }
        return next;
      };
      if (Array.isArray(source)) {
        this.original.set(o, source.map(keep));
      } else if (source && source.uuid === uuid) {
        this.original.set(o, keep(source));
      }
    });
    if (this.materialModes.has(uuid)) {
      this.materialModes.set(next.uuid, this.materialModes.get(uuid));
      this.materialModes.delete(uuid);
    }
    if (this.hiddenMaterials.has(uuid)) {
      this.hiddenMaterials.delete(uuid);
      this.hiddenMaterials.add(next.uuid);
    }
    this.refresh();
  }

  /** Take one material out of the picture, or put it back. */
  setMaterialHidden(uuid, hidden) {
    if (hidden) this.hiddenMaterials.add(uuid);
    else this.hiddenMaterials.delete(uuid);
    this.apply(this.mode);
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
      // Hiding writes neither colour nor depth, so the slot stays in place on a
      // mesh that carries several materials and only one of them is in the way.
      if (this.hiddenMaterials.has(m.uuid)) {
        const key = `${m.uuid}|hidden`;
        let blank = this.built.get(key);
        if (!blank) {
          blank = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
          this.built.set(key, blank);
        }
        return blank;
      }
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
