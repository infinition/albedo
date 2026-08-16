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
 * Ids are three.js uuids for anything that comes out of a file. Meshes and
 * materials share that space and never collide, and each one is remembered with
 * its kind so a reader can ask for "the selected material" without a lookup into
 * the scene graph.
 *
 * **The room is in here too, now.** Lights, stands and backdrops are things you
 * click on and things the outliner lists, so they are selected the same way as
 * everything else rather than through a second variable that the first one never
 * hears about. They have no uuid, so they get a synthetic one from `decorId`:
 * `light:3`, `stand:main`, `bg:studio`. The prefix is what keeps them out of the
 * uuid space and, more importantly, what lets `prune` tell them apart — see
 * below, because that distinction is the whole reason this file changed.
 */

/**
 * Ids of a thing that has no uuid of its own.
 *
 * @param {"light" | "stand" | "bg"} kind
 * @param {string | number} key
 */
export const decorId = (kind, key) => `${kind}:${key}`;

/** The `3` in `light:3`, or null when the id is a uuid. */
export function decorKey(id) {
  const cut = typeof id === "string" ? id.indexOf(":") : -1;
  return cut < 0 ? null : id.slice(cut + 1);
}

/**
 * Kinds that arrive with a model and leave with it.
 *
 * Everything else is the room rather than the thing in it, and outlives any
 * number of files. This set is what `prune` consults, and getting it wrong is
 * not a visible bug but a silent one: the tree repaints on every eye click and
 * hands `prune` the ids it happens to know about, which are the meshes and the
 * materials. Judged against that list alone, a selected light is "no longer in
 * the scene" and is dropped — every repaint, instantly, so the row never even
 * flickers lit.
 */
const MODEL_KINDS = new Set(["mesh", "material"]);

/** @type {Set<string>} */
const ids = new Set();
/** @type {Map<string, "mesh" | "material" | "light" | "stand" | "bg">} */
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
  /** Every selected light, by its own numeric id rather than by `light:3`. */
  lights: () => ofKind("light").map((id) => Number(decorKey(id))),

  /**
   * The one row a detail panel should show: `{ id, kind }`, or null.
   *
   * The outliner has one panel under it and any number of selected rows, so it
   * needs a single answer to "what am I editing". The first selected, for the
   * same reason `material` below takes the first: a plain click replaces the
   * selection, so on the ordinary path there is exactly one.
   */
  get primary() {
    const id = [...ids][0];
    return id ? { id, kind: kinds.get(id) } : null;
  },

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
   *
   * `alive` is a list of what came out of the *model*, and is judged against the
   * model kinds only. A light is not in it and must not be read as missing: the
   * room is not part of the file, and the caller that repaints the tree has no
   * reason to know how many lights there are. Removing a light announces its own
   * departure through `delete`, which is where that lifecycle belongs.
   */
  prune(alive) {
    let gone = false;
    for (const id of [...ids]) {
      if (!MODEL_KINDS.has(kinds.get(id))) continue;
      if (alive.has(id)) continue;
      ids.delete(id);
      kinds.delete(id);
      gone = true;
    }
    if (gone) announce();
  },

  /** Forget one row, because the thing it pointed at is gone. */
  delete(id) {
    if (!ids.has(id)) return;
    ids.delete(id);
    kinds.delete(id);
    announce();
  },

  /** Listen. Returns the function that stops listening. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
