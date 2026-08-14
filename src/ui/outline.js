import { MAP_SLOTS } from "../viewer/materials.js";

/**
 * The outliner: meshes, their materials, and each material's maps.
 *
 * **Why a tree and not the flat list the inspector already has.** The flat list
 * answers "what materials are in this file", which is an inspection question. A
 * retopology asks a different one: "which *part* of this model am I about to
 * spend a triangle budget on". A model with one material across nine meshes and
 * a model with nine materials on one mesh look identical in a flat list and are
 * nothing alike to a decimator. The nesting is the answer, and it is also what
 * makes a selection expressible at all: you cannot select "the handle" from a
 * list that never mentions meshes.
 *
 * Three levels, and each level does the two things that matter:
 *
 * - **Mesh** — select it, hide it. Hiding sets `visible`, which the exporter
 *   already honours, so a hidden mesh is one a restricted run never sees.
 * - **Material** — select it, hide it. Hiding goes through the channel view's
 *   own `setMaterialHidden`, which swaps in a material that writes neither
 *   colour nor depth, so a mesh carrying four materials can lose one of them
 *   without losing the other three.
 * - **Map** — hide it. Not selectable, because nothing is ever decimated *per
 *   texture slot*; but a normal map you can switch off is how you find out
 *   whether the shape you are looking at is geometry or a lie painted on it,
 *   which is exactly the question before a retopology.
 *
 * Selection is a set of ids rather than a flag on the objects: the scene is
 * rebuilt on every import, and a flag would either be lost or, worse, survive
 * onto a different model.
 */

/** Everything the tree needs to draw itself, gathered in one traverse. */
export function readScene(viewer, channels) {
  const meshes = [];
  viewer.root.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const g = node.geometry;
    if (!g?.attributes?.position) return;

    channels?.remember?.(node);
    const source = channels?.original?.get(node) ?? node.material;
    const mats = Array.isArray(source) ? source : [source];

    const total = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const groups = g.groups?.length ? g.groups : null;

    meshes.push({
      id: node.uuid,
      node,
      name: node.name || "(sans nom)",
      visible: node.visible,
      triangles: Math.round(total),
      materials: mats.filter(Boolean).map((m, i) => ({
        id: m.uuid,
        material: m,
        name: m.name || "(sans nom)",
        hidden: !!channels?.hiddenMaterials?.has(m.uuid),
        // Per material triangles, from the groups when there are any. Without
        // groups the mesh belongs to its single material, and a mesh listing
        // several materials with no groups is a file being loose with itself,
        // so the count is shared rather than claimed by each.
        triangles: Math.round(
          groups
            ? groups
                .filter((gr) => (gr.materialIndex ?? 0) === i)
                .reduce((a, gr) => a + gr.count / 3, 0)
            : total / mats.length
        ),
        maps: MAP_SLOTS.filter(([slot]) => m[slot] || m.userData?.hiddenMaps?.[slot]).map(
          ([slot, label]) => ({
            slot,
            label,
            hidden: !!m.userData?.hiddenMaps?.[slot],
            texture: m[slot] || m.userData?.hiddenMaps?.[slot],
          })
        ),
      })),
    });
  });
  return meshes;
}

/**
 * Switch one texture slot off, and be able to switch it back on.
 *
 * The texture is parked on the material rather than dropped, because the point
 * is to look without it for a moment, not to edit the model. Anything that
 * reads the material meanwhile sees an honestly empty slot.
 */
export function toggleMap(material, slot) {
  material.userData.hiddenMaps ??= {};
  const parked = material.userData.hiddenMaps[slot];
  if (parked) {
    material[slot] = parked;
    delete material.userData.hiddenMaps[slot];
  } else {
    material.userData.hiddenMaps[slot] = material[slot];
    material[slot] = null;
  }
  // A slot appearing or disappearing changes which branches the shader compiles,
  // so the program has to be rebuilt rather than merely re-run.
  material.needsUpdate = true;
  return !parked;
}

/**
 * A thumbnail of a texture, small enough to sit in a row.
 *
 * Drawn from the texture's own decoded image: a model with a dozen 4K maps is
 * already holding them, and decoding second copies to make a list pretty is how
 * a viewer becomes slow on exactly the files that need it most.
 */
export function thumbnail(texture, size = 22) {
  const image = texture?.image;
  if (!image) return null;
  try {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const g = cv.getContext("2d");
    const half = size / 2;
    for (let y = 0; y < size; y += half) {
      for (let x = 0; x < size; x += half) {
        g.fillStyle = ((x + y) / half) % 2 ? "#23272f" : "#1a1d23";
        g.fillRect(x, y, half, half);
      }
    }
    g.drawImage(image, 0, 0, size, size);
    return cv.toDataURL();
  } catch {
    // Compressed and data textures have nothing drawable. A caller that gets
    // null shows a swatch, which is honest, rather than an empty square that
    // looks like a texture that failed to load.
    return null;
  }
}
