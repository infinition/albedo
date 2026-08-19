import * as THREE from "three";
import { takenNames, uniqueName } from "../naming.js";
import { WIRE_ATTRIBUTES } from "../viewer/wire.js";

/**
 * Cutting a segmented model into one mesh per group.
 *
 * The output the whole mode exists for. Everything before it is a way of
 * agreeing where the parts are; this is where the model stops being one object
 * that happens to be painted in several ways and becomes several objects.
 *
 * ## Sibling meshes, sharing the atlas
 *
 * Each group becomes a `Mesh` beside the one it came out of, under the same
 * parent, carrying the same transform. That choice pays for itself immediately:
 * the outliner, the visibility eyes, the transform gizmo, the GLB export and
 * retopology per part are all written against ordinary objects in the scene, so
 * a split gets every one of them without a line of code here.
 *
 * The textures are **shared, not copied**. A clone of a material copies map
 * references and not the images behind them, so ten parts off one atlas cost
 * one atlas on the GPU and come out pixel-identical to the source. Giving each
 * part a tight atlas of its own is a different operation, it is a bake, and
 * there is already an engine in this repository for that.
 *
 * ## What has to be carried across
 *
 * Every vertex attribute except this application's own scaffolding, which is
 * listed in `WIRE_ATTRIBUTES` and belongs to how the model is being looked at
 * rather than to the model. The per-triangle material slot comes from
 * `geometry.groups`, which is the only place a mesh with several materials
 * records which triangle belongs to which, and which nothing in this
 * application had ever needed to read per triangle before.
 */

/**
 * Which material slot each triangle of a geometry draws with.
 *
 * `geometry.groups` counts in index units when the geometry is indexed and in
 * vertex units when it is not. Everything reaching here has been through
 * `prepareWire`, so it is not indexed and a group covers `count / 3` triangles
 * starting at `start / 3`. Returning nulls for a single-material mesh rather
 * than an array of zeros keeps the common case free.
 */
function slotPerTriangle(geometry, triangles) {
  const groups = geometry.groups;
  if (!groups?.length) return null;
  const slot = new Uint16Array(triangles);
  for (const g of groups) {
    const from = Math.floor(g.start / 3);
    const to = Math.min(triangles, from + Math.floor(g.count / 3));
    slot.fill(g.materialIndex ?? 0, from, to);
  }
  return slot;
}

/**
 * Build one geometry from the triangles listed in `pick`.
 *
 * Copies every attribute the source has, three vertices per triangle, in the
 * order the triangles are given.
 */
function subset(source, pick) {
  const out = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (WIRE_ATTRIBUTES.includes(name)) continue;
    const size = attribute.itemSize;
    const src = attribute.array;
    const dst = new src.constructor(pick.length * 3 * size);
    for (let i = 0; i < pick.length; i++) {
      const t = pick[i] * 3;
      for (let c = 0; c < 3; c++) {
        const from = (t + c) * size;
        const to = (i * 3 + c) * size;
        for (let k = 0; k < size; k++) dst[to + k] = src[from + k];
      }
    }
    out.setAttribute(
      name,
      new THREE.BufferAttribute(dst, size, attribute.normalized)
    );
  }
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * A copy of a material, named for the group it now belongs to.
 *
 * `clone` rather than reuse, because a split exists so that the parts can be
 * given different surfaces afterwards, and sharing one material object would
 * mean changing all of them at once. The maps inside are shared, which is the
 * opposite decision for the opposite reason: those are the same pixels.
 */
function materialFor(source, name) {
  const copy = source.clone();
  copy.name = name;
  return copy;
}

/**
 * Cut every segmented mesh into one mesh per group.
 *
 * @param {object} o
 * @param {any} o.root the scene subtree, for name collisions
 * @param {any[]} o.meshes the meshes the ids were indexed against, in order
 * @param {Float32Array|number[]} o.labelOfSuper group id per superface
 * @param {(n: number) => string} o.name what to call group `n`
 * @returns an undo record, and what was made
 */
export function splitByGroup({ root, meshes, labelOfSuper, name }) {
  const removed = [];
  const created = [];
  let skipped = 0;

  /*
   * One material per group, across every mesh the group turned out to touch.
   *
   * Kept outside the loop below on purpose. A group is very often spread over
   * several source meshes, that is exactly the case the appearance grouping
   * exists for, where two hundred separate rocks are one family, and giving
   * each fragment its own clone would hand back two hundred materials called
   * "Famille 1" that have to be edited two hundred times. The geometry stays
   * separate because separate rocks *are* separate objects; the surface does
   * not, because it is one surface.
   */
  const surfaces = new Map();

  /*
   * Whether a group's name is enough to identify its surface.
   *
   * A group that spans two source materials has to become two materials,
   * they carry different textures and there is no such thing as one material
   * with two atlases, and calling both of them "Famille 1" would leave two
   * rows in the panel with one name between them. When the model had a single
   * material to begin with, which is the whole case this mode was built for,
   * that never happens and the names stay clean.
   */
  const sources = new Set();
  for (const m of meshes) {
    for (const s of Array.isArray(m.material) ? m.material : [m.material]) {
      if (s) sources.add(s.uuid);
    }
  }
  const ambiguous = sources.size > 1;

  for (const source of meshes) {
    const geometry = source.geometry;
    const group = geometry?.attributes?.aGroup;
    if (!group) {
      skipped++;
      continue;
    }
    const triangles = geometry.attributes.position.count / 3;
    const slots = slotPerTriangle(geometry, triangles);
    const materials = Array.isArray(source.material) ? source.material : [source.material];

    /*
     * Triangles by group, and by material within it.
     *
     * The second key is not paranoia. A group is allowed to cross a material
     * boundary the moment somebody turns that barrier off, and a mesh whose
     * triangles came from two materials cannot be one mesh with one material
     * without deciding which one to throw away. Splitting on both means the
     * answer is never wrong, at the price of a part or two more than asked for
     * in a case that is rare and entirely the user's choice.
     */
    const buckets = new Map();
    for (let t = 0; t < triangles; t++) {
      const superface = group.array[t * 3];
      if (superface < 0) continue;
      const g = labelOfSuper[superface];
      if (g === undefined) continue;
      const slot = slots ? slots[t] : 0;
      const key = `${g}|${slot}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = { g, slot, tris: [] }));
      list.tris.push(t);
    }
    if (!buckets.size) {
      skipped++;
      continue;
    }

    const parent = source.parent;
    const at = parent ? parent.children.indexOf(source) : -1;

    // Sorted, so the parts come out in group order rather than in whatever
    // order a hash map happens to hold them. A list that reshuffles between two
    // identical runs is a list nobody can check.
    const order = [...buckets.values()].sort((a, b) => a.g - b.g || a.slot - b.slot);
    for (const bucket of order) {
      const geo = subset(geometry, bucket.tris);
      // The object needs a name nothing else has; the surface keeps the group's
      // own, so a family reads as one material however many pieces it is in.
      const wanted = name(bucket.g);
      const label = uniqueName(wanted, takenNames(root));
      /*
       * Keyed on the source material itself, and not on the slot number.
       *
       * A slot index is local to one mesh: slot 0 of the walls and slot 0 of
       * the floor are two different surfaces that happen to be first in their
       * own lists. Caching on the number let a group spanning both take
       * whichever mesh was processed first and silently drop the other's
       * textures, a result that renders perfectly and is wrong. Caught by
       * counting the distinct maps before and after a split: three went in and
       * two came out.
       */
      const from = materials[bucket.slot] || materials[0];
      const key = `${bucket.g}|${from?.uuid ?? "none"}`;
      let material = surfaces.get(key);
      if (!material) {
        const surfaceName =
          ambiguous && from?.name ? `${wanted} · ${from.name}` : wanted;
        material = materialFor(from, surfaceName);
        surfaces.set(key, material);
      }

      let mesh;
      if (source.isSkinnedMesh) {
        mesh = new THREE.SkinnedMesh(geo, material);
        // The skeleton is shared: it is the same bones driving the same
        // vertices, and rebinding a copy would double the cost of every frame
        // for a pose that is identical by construction.
        mesh.bind(source.skeleton, source.bindMatrix);
        mesh.bindMode = source.bindMode;
      } else {
        mesh = new THREE.Mesh(geo, material);
      }
      mesh.name = label;
      mesh.position.copy(source.position);
      mesh.quaternion.copy(source.quaternion);
      mesh.scale.copy(source.scale);
      mesh.castShadow = source.castShadow;
      mesh.receiveShadow = source.receiveShadow;
      mesh.renderOrder = source.renderOrder;
      mesh.userData = { ...source.userData, albedoGroup: bucket.g };

      parent?.add(mesh);
      created.push(mesh);
    }

    if (parent) {
      parent.remove(source);
      removed.push({ parent, node: source, at });
    }
  }

  return { created, removed, skipped };
}

/**
 * Put a split back.
 *
 * One level, owned by this mode, because the application's undo stack holds
 * poses and nothing else, it was built for the gizmo and a split is not a
 * transform. The removed meshes are kept rather than rebuilt: they are the
 * originals, geometry and materials and all, so restoring them is exact and
 * costs nothing but holding the reference.
 */
export function unsplit({ created, removed }) {
  // Materials are shared across the pieces of one group, so they are collected
  // and released once rather than once per piece.
  const surfaces = new Set();
  for (const mesh of created) {
    mesh.parent?.remove(mesh);
    mesh.geometry?.dispose?.();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m) surfaces.add(m);
    }
  }
  // The clones go; the maps inside them belong to the originals about to come
  // back, so nothing here touches a texture.
  for (const m of surfaces) m.dispose();
  for (const { parent, node, at } of removed) {
    if (at >= 0 && at <= parent.children.length) parent.children.splice(at, 0, node);
    else parent.add(node);
    node.parent = parent;
  }
}
