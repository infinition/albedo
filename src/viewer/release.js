/**
 * Giving memory back.
 *
 * three holds the card's side of a geometry, a material and a texture until it
 * is told to let go. Dropping an object out of the scene drops the JavaScript
 * reference and nothing else: the vertex buffers, the compiled programs and the
 * decoded images stay where they are. A viewer that opens one file a session
 * never notices. A viewer with a preview strip does, because clicking through a
 * library loads one model after another and every one of them stays resident
 * until the window closes.
 *
 * What must not be released is anything the scene owns rather than the model:
 * the environment, the backdrop, the gradient, and the UV checker that is made
 * once and shared by every model there will ever be. Those are named by the
 * caller, which is the only place that knows them.
 */

/**
 * Every texture a material points at, whatever the slot happens to be called.
 *
 * By inspection rather than by a list of names: a material knows its own maps,
 * and a list written here would fall behind the first time three adds a slot or
 * a loader sets an unusual one.
 */
export function texturesOf(material, into = new Set()) {
  for (const value of Object.values(material)) {
    if (value && value.isTexture) into.add(value);
  }
  return into;
}

/**
 * Release materials and the textures they hold.
 *
 * @param {Iterable<any>} materials materials or arrays of them
 * @param {Set<any>} [keep] textures that outlive the model
 * @returns {{materials: number, textures: number}}
 */
export function releaseMaterials(materials, keep = new Set()) {
  const seen = new Set();
  const maps = new Set();
  for (const entry of materials) {
    for (const m of Array.isArray(entry) ? entry : [entry]) {
      if (!m || !m.isMaterial || seen.has(m)) continue;
      seen.add(m);
      texturesOf(m, maps);
      m.dispose();
    }
  }
  let textures = 0;
  for (const t of maps) {
    if (keep.has(t)) continue;
    t.dispose();
    textures++;
  }
  return { materials: seen.size, textures };
}

/**
 * Release everything a subtree holds on the card.
 *
 * The subtree itself is left alone; emptying it is the caller's business, and
 * doing both here would make the function impossible to use on a tree that has
 * to survive.
 *
 * @param {any} root
 * @param {Set<any>} [keep]
 * @returns {{geometries: number, materials: number, textures: number}}
 */
export function releaseSubtree(root, keep = new Set()) {
  const geometries = new Set();
  const materials = [];
  root.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    if (o.material) materials.push(o.material);
  });
  for (const g of geometries) g.dispose();
  return { geometries: geometries.size, ...releaseMaterials(materials, keep) };
}
