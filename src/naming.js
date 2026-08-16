/**
 * Names, and what a name is attached to.
 *
 * A viewer can get away with treating a name as a label. The moment the scene
 * holds more than one object and one of them was *made from* another, a name
 * stops being decoration and becomes the only thing that says which is which.
 * Three faults, all of them the same fault:
 *
 * - **Duplicating a mesh gave the copy the original's name**, so the scene held
 *   two rows saying `Head` and the outliner could not tell you which one the
 *   handles were on.
 * - **A retopology result was named after the *file***: `table.glb` yielded
 *   `table_LP` whichever mesh had been decimated. On a three mesh scene with a
 *   run restricted to one of them, the low poly claimed the whole document.
 * - **A second run dropped every result in the scene**, because "my output" was
 *   a boolean on the object rather than a link back to what it was made from.
 *   Retopologising the head after the hands threw the hands away.
 *
 * So this module owns three things and nothing else:
 *
 * 1. **Uniqueness.** `Head`, `Head.001`, `Head.002`, the way Blender counts,
 *    because that is the convention the people using this already read.
 * 2. **The high poly / low poly link**, in both directions, in `userData`.
 * 3. **Derived names**, which is the part that is easy to get subtly wrong. A
 *    low poly is called `Head_LP` *because* its source is called `Head`, so
 *    renaming the source renames it. But only while nobody has said otherwise:
 *    the first time a name is typed by hand it stops being derived, and from
 *    then on it is left alone. A rename that overwrites a name somebody chose is
 *    worse than no propagation at all.
 *
 * Links are `uuid`s and live for the session, which is the right lifetime: they
 * describe two objects that are both in the scene right now. Nothing here is
 * written to a file.
 */

/** Blender's counter: three digits, so `Head.001` sorts next to `Head.002`. */
const COPY = /\.(\d{3,})$/;
/** Any of the ways a low poly announces itself, at the end of a name. */
const LOW = /[_-](lp|low)$/i;

/** Our own corner of `userData`, created on demand. */
export function meta(node) {
  if (!node) return {};
  node.userData ??= {};
  node.userData.albedo ??= {};
  return node.userData.albedo;
}

/** `Head.001` → `Head`. A copy of a copy is still a copy of the original. */
export const stripCopy = (name) => String(name || "").replace(COPY, "");

/** `Head_LP` → `Head`, so a low poly of a low poly is not `Head_LP_LP`. */
export const stripLow = (name) => stripCopy(name).replace(LOW, "");

/** What the low poly of something called `name` wants to be called. */
export const lowName = (name) => `${stripLow(name) || "modele"}_LP`;

/**
 * Every name currently spoken for, under `root`.
 *
 * `except` is the subtree being renamed or brought in: its own current name
 * must not count against it, or renaming `Head` to `Head` would yield
 * `Head.001` and every import would climb a number for no reason.
 */
export function takenNames(root, except = null) {
  const skip = new Set();
  if (except) except.traverse?.((o) => skip.add(o));
  const taken = new Set();
  root?.traverse?.((o) => {
    if (skip.has(o) || !o.name) return;
    taken.add(o.name);
  });
  return taken;
}

/**
 * `base` if it is free, otherwise `base.001`, `.002`, and so on.
 *
 * Counting from the *stripped* base rather than from what was handed in, so
 * copying `Head.001` gives `Head.002` and not `Head.001.001`.
 */
export function uniqueName(base, taken) {
  const wanted = String(base || "").trim() || "objet";
  if (!taken.has(wanted)) return wanted;
  const stem = stripCopy(wanted);
  for (let n = 1; n < 10000; n++) {
    const candidate = `${stem}.${String(n).padStart(3, "0")}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Ten thousand of one name is not a scene anyone is reading, but returning
  // something unique still beats returning a duplicate.
  return `${stem}.${Date.now().toString(36)}`;
}

/**
 * Give everything in an arriving subtree a name that is free in this scene.
 *
 * Called on import and on duplication, which are the two ways an object enters
 * a scene it was not loaded into. Names already assigned during this same pass
 * are added to the taken set as we go, so a group holding two meshes both
 * called `Cube` comes out as `Cube` and `Cube.001` rather than two `Cube`s that
 * were each unique against the *old* scene.
 *
 * Unnamed nodes are left unnamed. A blank name is a fact about the file, and
 * inventing `objet.007` for every bone and empty in an FBX would bury the
 * handful of names that mean something.
 */
export function adopt(root, object) {
  if (!object) return object;
  const taken = takenNames(root, object);
  const rename = (node) => {
    if (!node.name) return;
    const next = uniqueName(node.name, taken);
    if (next !== node.name) node.name = next;
    taken.add(node.name);
  };
  rename(object);
  object.traverse?.((o) => {
    if (o !== object) rename(o);
  });
  return object;
}

/** Names an exporter invents when nobody named anything: `mesh_0`, `Object_12`. */
const GENERIC = /^(mesh|object|node|group|geometry|primitive|default|untitled)[\s._-]*\d*$/i;

/**
 * Give a lone, anonymously-named mesh the file's own name.
 *
 * `mesh_0` is not Albedo's invention — it is what the exporter wrote, and most
 * generators write something like it. It tells you nothing, and it is the label
 * every derived name is then built from, so a result comes out `mesh_0_LP` when
 * `Blue_Alien_Plant_04_LP` was there for the taking.
 *
 * Only when there is exactly one mesh, and only when its name carries no
 * information. A file with forty parts has forty names its author chose, and
 * flattening those into `file`, `file.001`, `file.002` would replace real
 * information with none — the opposite of the trade being made here.
 *
 * @returns {string|null} the name applied, or null when nothing was touched
 */
export function nameFromFile(root, object, fileLabel) {
  const stem = stripCopy(String(fileLabel || "").replace(/\.[^.]+$/, "")).trim();
  if (!stem || !object) return null;
  const meshes = [];
  object.traverse?.((o) => {
    if (o.isMesh || o.isSkinnedMesh) meshes.push(o);
  });
  if (meshes.length !== 1) return null;
  const mesh = meshes[0];
  if (mesh.name && !GENERIC.test(mesh.name)) return null;

  mesh.name = uniqueName(stem, takenNames(root, mesh));
  return mesh.name;
}

/**
 * Tie a low poly to the high poly it was made from.
 *
 * Both directions, because both questions get asked: the outliner asks a low
 * poly what it came from, and a re-run asks a high poly what it already
 * produced so it can replace it rather than stack onto it.
 */
export function link(high, low) {
  if (!high || !low) return;
  meta(high).low = low.uuid;
  const m = meta(low);
  m.high = high.uuid;
  m.role = "low";
  // Derived until somebody types over it. Set here rather than at the call site
  // so there is one place that decides what "this name was computed" means.
  m.derived ??= true;
}

/** Find a node by uuid under `root`, or null. */
export function byUuid(root, uuid) {
  if (!uuid) return null;
  let found = null;
  root?.traverse?.((o) => {
    if (!found && o.uuid === uuid) found = o;
  });
  return found;
}

/** The low poly made from this node, if it is still in the scene. */
export const lowPolyOf = (root, high) => byUuid(root, meta(high).low);
/** The high poly this node was made from, if it is still in the scene. */
export const highPolyOf = (root, low) => byUuid(root, meta(low).high);

/**
 * Rename a node, and carry the consequences.
 *
 * Returns the name actually applied, which is not always the one asked for: it
 * is uniquified against the rest of the scene. A caller repainting a row should
 * use the returned value rather than what it typed.
 *
 * @param {any} root the scene subtree names are unique within
 * @param {any} node the node being renamed
 * @param {string} next what the user typed
 * @param {{ byHand?: boolean }} [opts] `byHand` marks the name as owned, which
 *   stops later propagation from overwriting it. False for the renames this
 *   function performs on its own.
 */
export function renameNode(root, node, next, { byHand = true } = {}) {
  if (!node) return "";
  const wanted = String(next || "").trim();
  // An empty box is a cancelled edit, not a request for a nameless object.
  if (!wanted || wanted === node.name) return node.name;

  const applied = uniqueName(wanted, takenNames(root, node));
  node.name = applied;
  if (byHand) meta(node).derived = false;

  propagate(root, node);
  return applied;
}

/**
 * Push a name change down the one link that follows it.
 *
 * Only high → low, and only while the low poly's name is still the computed
 * one. The other direction does not propagate on purpose: a low poly is named
 * *after* its source, so renaming it says something about that copy and nothing
 * about the original.
 */
export function propagate(root, high) {
  /*
   * Found by the back-link rather than by following the forward one.
   *
   * `meta(high).low` holds one uuid, and a result can be more than one node —
   * the part group and the mesh inside it at least, sometimes several meshes.
   * Following the forward pointer renamed whichever had been linked last and
   * left the rest, which on the ordinary path meant renaming the group nobody
   * sees while the row on screen kept its old name.
   */
  const wanted = lowName(high.name);
  const taken = takenNames(root, null);
  const derived = [];
  root?.traverse?.((o) => {
    if (o === high) return;
    const m = meta(o);
    if (m.high === high.uuid && m.derived !== false) derived.push(o);
  });
  /*
   * The meshes are served first, and that ordering is the whole of the fix.
   *
   * A result is a part group holding a mesh, and both are derived, so both want
   * the same name and one of them has to take a number. Left to the traversal
   * order it was the group — which nothing displays — so the row on screen read
   * `Casque_LP.001` next to an invisible `Casque_LP`. The list shows meshes, so
   * meshes get the clean name and the group takes whatever is left.
   */
  derived.sort((a, b) => (b.isMesh || b.isSkinnedMesh ? 1 : 0) - (a.isMesh || a.isSkinnedMesh ? 1 : 0));
  // Their current names come out of the pool first, or each would collide with
  // the name it is about to stop using.
  for (const low of derived) taken.delete(low.name);
  for (const low of derived) {
    low.name = uniqueName(wanted, taken);
    taken.add(low.name);
  }
}

/**
 * Name and link the output of a run against the meshes it was made from.
 *
 * One source is the ordinary case and the only one with an unambiguous answer:
 * the result is that mesh, low poly, and says so. Several sources means the run
 * covered a span of the scene, and the group takes the document's name; the
 * meshes inside it are matched back to their sources by name where the engine
 * preserved them, which is what makes a per mesh rename still work afterwards.
 *
 * @param {any} root the scene
 * @param {any} object the imported result
 * @param {any[]} sources the meshes the run was allowed to see
 * @param {string} fallback a name for the result when there is no single source
 * @returns {string} the name given to the result
 */
/**
 * Carry a group's name and link down to the meshes inside it.
 *
 * A result arrives as a group holding one mesh, and the outliner lists *meshes*.
 * Naming only the group therefore renamed something nobody displays, and the row
 * on screen kept whatever the engine's glb happened to call it — `retopo`.
 *
 * Shared by the two places a result gets its identity, and that sharing is the
 * repair rather than a tidy-up. A run named the group and its meshes; a bake
 * came back through `restoreIdentity`, which named the group *only* — so
 * decimating produced `mesh_0_LP` and baking silently turned it back into
 * `retopo`. Two paths that must agree, agreeing by construction.
 */
function nameInside(root, object, high) {
  if (high) link(high, object);
  const taken = takenNames(root, object);
  taken.add(object.name);
  let n = 0;
  object.traverse?.((o) => {
    if (o === object || (!o.isMesh && !o.isSkinnedMesh)) return;
    // One mesh takes the group's own name; a second and third are numbered from
    // it, so a result that came back split still reads as one family.
    o.name = n === 0 ? object.name : uniqueName(object.name, taken);
    taken.add(o.name);
    if (high) link(high, o);
    n++;
  });
}

export function nameResult(root, object, sources, fallback = "modele") {
  if (!object) return "";
  const list = (sources || []).filter(Boolean);

  if (list.length === 1) {
    object.name = uniqueName(lowName(list[0].name || fallback), takenNames(root, object));
    nameInside(root, object, list[0]);
    return object.name;
  }

  object.name = uniqueName(lowName(fallback), takenNames(root, object));
  meta(object).role = "low";
  meta(object).derived = true;

  // Per mesh linking, for the runs that produce a mesh per source. Matched on
  // the stripped name because the engine writes the source's own names through,
  // and a mesh that finds no match is simply left as part of the group: an
  // unmatched result is not a reason to refuse the whole naming.
  const bySource = new Map();
  for (const src of list) {
    const key = stripLow(src.name || "").toLowerCase();
    if (key && !bySource.has(key)) bySource.set(key, src);
  }
  const taken = takenNames(root, object);
  object.traverse?.((o) => {
    if (o === object || (!o.isMesh && !o.isSkinnedMesh)) return;
    const src = bySource.get(stripLow(o.name || "").toLowerCase());
    if (!src) return;
    o.name = uniqueName(lowName(src.name), taken);
    taken.add(o.name);
    link(src, o);
  });
  return object.name;
}

/**
 * The name and links of a node, kept so a replacement can inherit them.
 *
 * A rebake and a step through the history both throw an object away and import
 * another one that is, to the user, the same object with different pixels on
 * it. Rebuilding its name from scratch would rename `Casque_LP` back to
 * `Head_LP` and, worse, drop the link that a later rename propagates along.
 */
export function snapshotIdentity(node) {
  return node ? { name: node.name, meta: { ...meta(node) } } : null;
}

/**
 * Put a remembered identity onto the object that replaced it.
 *
 * The reverse link is rewritten rather than copied: the high poly was pointing
 * at the uuid of an object that no longer exists, and a stale link there is the
 * quiet kind of wrong — renaming the source would silently stop propagating.
 */
export function restoreIdentity(root, node, snap) {
  if (!node || !snap) return node?.name || "";
  node.name = uniqueName(snap.name, takenNames(root, node));
  Object.assign(meta(node), snap.meta);
  const high = highPolyOf(root, node);
  if (high) meta(high).low = node.uuid;
  // The meshes inside, exactly as a fresh run names them. Without this a bake
  // restored the group's name and left the mesh on screen called `retopo`,
  // which is what the engine writes and what the person had just renamed away
  // from.
  nameInside(root, node, high);
  return node.name;
}

/**
 * Which existing results a run is about to supersede.
 *
 * The question a re-run asks. Answered by the link rather than by a flag, which
 * is the whole point: with a flag the answer was "every result in the scene",
 * so decimating a second mesh threw away the first one's low poly.
 *
 * A result whose source has left the scene is included too. It is an orphan
 * either way, and leaving it behind means the scene accumulates low polys of
 * meshes that no longer exist.
 *
 * @param {any[]} parts `viewer.parts`
 * @param {Set<string>} sourceIds uuids of the meshes this run covers
 */
export function supersededBy(parts, sourceIds, root) {
  return (parts || []).filter((part) => {
    const object = part?.object;
    if (!object) return false;
    let hit = false;
    object.traverse?.((o) => {
      if (hit) return;
      const m = meta(o);
      if (m.role !== "low") return;
      if (!m.high) return;
      if (sourceIds.has(m.high)) hit = true;
      else if (root && !byUuid(root, m.high)) hit = true;
    });
    return hit;
  });
}
