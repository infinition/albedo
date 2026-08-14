/**
 * What is selected, for the whole application.
 *
 * There were three answers to that question and they disagreed. The inspector
 * held one material uuid in `selectedMaterial`, so a click on a surface opened
 * its textures. The Retopo mode held a `picked` set of mesh *and* material ids,
 * so a run could be restricted to part of a model. Neither knew about the other,
 * which meant clicking a surface in the viewport rang a row in one panel and
 * left the other one pointing at something else entirely.
 *
 * One set, here, and every reader takes its answer from it.
 *
 * **Hiding is not the third one.** `channels.hiddenMaterials` looks like a
 * selection and is not: it says what is *drawn*, which is why the scope control
 * can offer "everything", "what is visible" and "what is selected" as three
 * different things. Folding it in here would make hiding a surface select it and
 * selecting one hide everything else, and the scope control would lose two of
 * its three positions. The two states stay apart; what they now share is a
 * single tree that shows both, so they can no longer drift by being edited in
 * two places that never look at each other.
 *
 * Ids are three.js uuids. Meshes and materials share the space and never
 * collide, and each one is remembered with its kind so a reader can ask for
 * "the selected material" without a lookup into the scene graph.
 */

/** @type {Set<string>} */
const ids = new Set();
/** @type {Map<string, "mesh" | "material">} */
const kinds = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();

function announce() {
  // A copy, because a listener is allowed to unsubscribe itself while running.
  for (const fn of [...listeners]) fn();
}

/** Ids of one kind, in insertion order. */
function ofKind(kind) {
  return [...ids].filter((id) => kinds.get(id) === kind);
}

export const selection = {
  get size() {
    return ids.size;
  },

  /** The live set. Read it; change it through the methods below. */
  get ids() {
    return ids;
  },

  has: (id) => ids.has(id),
  kindOf: (id) => kinds.get(id) || null,

  /** Every selected material uuid. */
  materials: () => ofKind("material"),
  /** Every selected mesh uuid. */
  meshes: () => ofKind("mesh"),

  /**
   * The one material a detail panel should show, or null.
   *
   * The first selected rather than the last: a click replaces the selection, so
   * on the ordinary path there is exactly one and the choice never comes up. It
   * only matters after a ctrl-click, where the first is the one that was already
   * being looked at.
   */
  get material() {
    return ofKind("material")[0] || null;
  },

  /**
   * A click, with its two well worn meanings.
   *
   * A plain click replaces the selection, and clicking the only selected thing
   * again clears it, because the way out of a selection should be the same
   * gesture that got in. Ctrl-click adds and removes one at a time.
   */
  choose(id, kind = "material", add = false) {
    if (!id) {
      this.clear();
      return;
    }
    if (add) {
      if (ids.has(id)) {
        ids.delete(id);
        kinds.delete(id);
      } else {
        ids.add(id);
        kinds.set(id, kind);
      }
    } else {
      const alone = ids.size === 1 && ids.has(id);
      ids.clear();
      kinds.clear();
      if (!alone) {
        ids.add(id);
        kinds.set(id, kind);
      }
    }
    announce();
  },

  /** Replace the whole selection with a list of `[id, kind]` pairs. */
  set(pairs) {
    ids.clear();
    kinds.clear();
    for (const [id, kind] of pairs) {
      ids.add(id);
      kinds.set(id, kind);
    }
    announce();
  },

  clear() {
    if (!ids.size) return;
    ids.clear();
    kinds.clear();
    announce();
  },

  /**
   * Drop whatever is no longer in the scene.
   *
   * Loading a model builds new uuids, so a selection kept across a load points
   * at objects that were disposed. Silent rather than announced when it changes
   * nothing, so the ordinary repaint after a load does not fire twice.
   */
  prune(alive) {
    let gone = false;
    for (const id of [...ids]) {
      if (alive.has(id)) continue;
      ids.delete(id);
      kinds.delete(id);
      gone = true;
    }
    if (gone) announce();
  },

  /** Listen. Returns the function that stops listening. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
