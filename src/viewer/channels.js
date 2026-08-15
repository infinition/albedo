import * as THREE from "three";
import { releaseMaterials, texturesOf } from "./release.js";

/**
 * Inspection channels.
 *
 * Each mode swaps every material for a flat, unlit view of one PBR input, so
 * what you see is the texture itself, not the texture under lighting. The
 * originals are cached and restored when going back to "shaded".
 */
export const CHANNELS = [
  { id: "shaded", labelKey: "chann.shaded" },
  { id: "unlit", labelKey: "chann.unlit" },
  { id: "albedo", labelKey: "chann.albedo" },
  { id: "normalMap", labelKey: "chann.normalMap" },
  { id: "roughness", labelKey: "chann.roughness" },
  { id: "metalness", labelKey: "chann.metalness" },
  { id: "ao", labelKey: "chann.ao" },
  { id: "emissive", labelKey: "chann.emissive" },
  { id: "opacity", labelKey: "chann.opacity" },
  { id: "normalGeom", labelKey: "chann.normalGeom" },
  { id: "uv", labelKey: "chann.uv" },
  { id: "clay", labelKey: "chann.clay" },
  { id: "clayUnlit", labelKey: "chann.clayUnlit" },
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
    /** Flat faces rather than smooth ones: a mode of the lit look. */
    this.flat = false;
    /**
     * The wireframe overlay, once someone has asked for one.
     *
     * Null until then, and that is the whole point: the overlay un-indexes every
     * geometry it touches, which triples the vertex buffer, and it arrives in a
     * chunk that is not fetched at startup. A viewer showing one model must not
     * pay for lines nobody asked to see.
     *
     * It lives here rather than in whichever panel offers the switch, because
     * this class is the one place that decides which material a mesh actually
     * draws with. That is the lesson the first version cost: the overlay was
     * applied to the model's own materials from outside, and every inspection
     * channel silently replaced them with unpatched stand-ins, so the wireframe
     * vanished on ten of the eleven channels and nothing anywhere said why.
     */
    this.wire = null;
  }

  /**
   * Hand over the overlay, once its module has been fetched.
   * @param {{ patch: (material: any) => void, uniforms: object }} wire
   */
  useWire(wire) {
    this.wire = wire;
  }

  /** Every material this class hands out goes through here. */
  dress(material) {
    this.wire?.patch(material);
    // Flat shading is a property of the material, so it is applied on the way
    // out like the wire patch: a stand-in built earlier follows whatever the
    // switch says now instead of freezing the look it was built under.
    if (material.flatShading !== this.flat) {
      material.flatShading = this.flat;
      material.needsUpdate = true;
    }
    return material;
  }

  /**
   * Everything this class knows about the model currently in the scene.
   *
   * Handed out when a document is put aside and handed back when it returns, so
   * a tab keeps its hidden materials, its per material render modes and the
   * stand-ins already built for it. `reset()` is the wrong tool there: it
   * *releases* those materials, which is right for a model being thrown away and
   * ruinous for one that is coming back.
   *
   * The wire is deliberately not in here. It is one overlay for the whole
   * application, shared by every document, like the lights and the grid.
   */
  snapshot() {
    return {
      original: this.original,
      built: this.built,
      materialModes: this.materialModes,
      hiddenMaterials: this.hiddenMaterials,
      pristine: this.pristine,
      mode: this.mode,
    };
  }

  adopt(state) {
    this.original = state?.original || new Map();
    this.built = state?.built || new Map();
    this.materialModes = state?.materialModes || new Map();
    this.hiddenMaterials = state?.hiddenMaterials || new Set();
    this.pristine = state?.pristine;
    this.mode = state?.mode || "shaded";
  }

  /** Release a snapshot that will never be adopted again: a closed tab. */
  releaseSnapshot(state) {
    if (!state) return;
    const keep = this.viewer.keptTextures();
    releaseMaterials(
      [...(state.built?.values() || []), ...(state.original?.values() || []),
       ...(state.pristine?.values() || [])],
      keep
    );
    state.built?.clear();
    state.original?.clear();
    state.pristine?.clear();
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
   * The scene gained or lost an object while the model itself stayed.
   *
   * `reset()` was being used for this and it is wrong here in a way that stays
   * invisible for exactly as long as the shaded channel is showing. `original`
   * is where a mesh's real material lives *while a channel stand-in is sitting
   * on the mesh*; clearing it does not put anything back, so the very next
   * `apply` calls `remember` on those same meshes and writes the stand-in down
   * as if it were the file's own material. From then on the object is frozen:
   * every later channel is built from a MeshBasicMaterial that carries one
   * texture and none of the PBR maps, so it keeps drawing whatever channel
   * happened to be showing at the moment the other object arrived.
   *
   * That is the split view disagreeing with itself after a remesh or a bake:
   * the result follows the Couleur group because its materials were remembered
   * correctly, and the source does not because its own were thrown away. It
   * also costs the real materials outright, since `reset` disposes everything
   * it forgets, and it silently un-hides every material and drops every per
   * material choice the user had made.
   *
   * So: forget only the meshes that actually left, keep everything about the
   * ones still standing, and let `apply` remember the newcomers.
   */
  absorb() {
    const live = new Set();
    this.viewer.root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) live.add(o);
    });

    /** The file's own materials of the meshes that left, and their stand-ins. */
    const gone = [];
    for (const mesh of [...this.original.keys()]) {
      if (live.has(mesh)) continue;
      const held = this.original.get(mesh);
      this.original.delete(mesh);
      for (const m of Array.isArray(held) ? held : [held]) {
        if (!m) continue;
        gone.push(m);
        // A stand-in is keyed by the uuid of what it stands in for, so a
        // material that leaves takes its whole column of channel copies along.
        for (const key of [...this.built.keys()]) {
          if (!key.startsWith(`${m.uuid}|`)) continue;
          gone.push(this.built.get(key));
          this.built.delete(key);
        }
        this.materialModes.delete(m.uuid);
        this.hiddenMaterials.delete(m.uuid);
      }
    }
    if (!gone.length) {
      this.apply(this.mode);
      return;
    }

    /*
     * Two ways a material that left is still needed, and both have to be
     * checked before anything is disposed.
     *
     * One mesh removed from a group of several can be drawn with a material the
     * rest of the group also carries, in which case it never left at all. And
     * `keptTextures` only knows what is *attached*, which under any channel but
     * shaded is the stand-ins: the real materials are set aside in `original`,
     * so their images have to be named here or removing one part frees the
     * textures of the parts that stayed.
     */
    const stays = new Set();
    const keep = this.viewer.keptTextures();
    if (checkerTexture) keep.add(checkerTexture);
    const alive = [
      ...this.original.values(),
      ...this.built.values(),
      ...(this.pristine?.values() || []),
    ];
    for (const entry of alive) {
      for (const m of Array.isArray(entry) ? entry : [entry]) {
        if (!m?.isMaterial) continue;
        stays.add(m.uuid);
        texturesOf(m, keep);
      }
    }
    releaseMaterials(
      gone.filter((m) => m?.isMaterial && !stays.has(m.uuid)),
      keep
    );
    this.apply(this.mode);
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
    // Two passes, and that is not an accident: a material carried by several
    // meshes only has its full triangle count once every mesh has been seen, so
    // counting and building rows in one traverse undercounts everything but the
    // last mesh to use it.
    const counts = new Map();
    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const list = (() => {
        const source = this.original.get(o);
        return Array.isArray(source) ? source : [source];
      })();
      const g = o.geometry;
      const total = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
      // A geometry with groups spends each group on one material; without them
      // the whole mesh belongs to the single material it carries.
      const groups = g?.groups?.length ? g.groups : null;
      list.forEach((m, i) => {
        if (!m) return;
        const n = groups
          ? groups
              .filter((gr) => (gr.materialIndex ?? 0) === i)
              .reduce((a, gr) => a + gr.count / 3, 0)
          : total / list.length;
        counts.set(m.uuid, (counts.get(m.uuid) ?? 0) + n);
      });
    });

    const out = [];
    const seen = new Set();
    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const source = this.original.get(o);
      for (const m of Array.isArray(source) ? source : [source]) {
        if (!m || seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        out.push({
          uuid: m.uuid,
          name: m.name || "(sans nom)",
          textured: !!m.map,
          /** The base colour map itself, for a thumbnail beside the name. */
          map: m.map || null,
          /** The flat colour to show when there is no map to show instead. */
          color: m.color ? `#${m.color.getHexString()}` : null,
          alphaLost: ChannelView.alphaLost(m),
          invisible: ChannelView.invisible(m),
          deadVertexColors: !!m.userData?.deadVertexColors,
          hidden: this.hiddenMaterials.has(m.uuid),
          /** Triangles this material is responsible for, across every mesh. */
          triangles: Math.round(counts.get(m.uuid) ?? 0),
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
    if (channel === "clay") {
      // The retopology look: a neutral gray, matte, lit like the model, so the
      // wireframe reads against a surface that says nothing about itself. Not an
      // inspection channel: the light stays, which is what makes it a surface.
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x9b9b9b),
        roughness: 0.95,
        metalness: 0,
        side: mat.side,
        flatShading: this.flat,
      });
    }
    if (channel === "clayUnlit") {
      // The same gray without the light, which is where the wireframe reads
      // best of all: no shading competes with the lines. Unlit, so it is a
      // MeshBasicMaterial like the inspection channels.
      return new THREE.MeshBasicMaterial({
        color: new THREE.Color(0x9b9b9b),
        side: mat.side,
      });
    }
    if (channel === "normalGeom") {
      return new THREE.MeshNormalMaterial({ side: mat.side, flatShading: this.flat });
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
        // Not dressed: a material that writes neither colour nor depth has
        // nothing to draw lines over, and patching it would put a wireframe on
        // the one thing the user asked to stop seeing.
        return blank;
      }
      const channel = this.channelFor(m, mode);
      if (channel === "shaded") return this.dress(m);
      const key = `${m.uuid}|${channel}`;
      let built = this.built.get(key);
      if (!built) {
        built = this.build(m, channel);
        this.built.set(key, built);
      }
      // Dressed on every pass rather than only on the one that built it: the
      // overlay can arrive after a stand-in was cached, and a cached material
      // that never gets patched is exactly how the wireframe used to disappear
      // on ten channels out of eleven.
      return this.dress(built);
    };

    this.viewer.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      this.remember(o);
      const source = this.original.get(o);
      o.material = Array.isArray(source) ? source.map(make) : make(source);
    });
    this.viewer.invalidate();
  }

  /**
   * Draw the edges, or stop.
   *
   * One switch for the whole application. There were two: this one, which set
   * `material.wireframe` and therefore *replaced* the surface with lines, and
   * the mode's own shader overlay which drew them *over* the shading. Two
   * controls in two places for one idea, and they could both be on at once, in
   * which case the crude one won by destroying the surface the other was drawing
   * on. Only the overlay survives, because losing the shading is losing the
   * thing you opened a wireframe to judge.
   *
   * Does nothing until `useWire` has been called, which is what makes the
   * overlay's cost conditional on wanting it.
   */
  setWireframe(on) {
    this.wireframe = on;
    if (this.wire) this.wire.uniforms.uWire.value = on ? 1 : 0;
    this.viewer.invalidate();
  }

  /**
   * Draw the edges and nothing else.
   *
   * The other half of the same overlay: the surface goes away, only the lines
   * stay, in the colour the master switch already chose. As a uniform rather
   * than `material.wireframe` it survives a channel change, which a property on
   * the current material never did.
   */
  setWireOnly(on) {
    if (this.wire) this.wire.uniforms.uWireOnly.value = on ? 1 : 0;
    this.viewer.invalidate();
  }

  /**
   * One flat colour per face, or the smooth gradient.
   *
   * A property of the lit materials, applied by `dress` on the way out, so it
   * survives every channel switch. Only the channels that actually light the
   * surface (shaded, normalGeom) show it, which is where the question is asked.
   */
  setFlat(on) {
    this.flat = on;
    this.apply(this.mode);
  }
}
