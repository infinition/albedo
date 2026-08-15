import { readScene, thumbnail, toggleMap } from "./outline.js";
import { forgetPortraits, portrait } from "./portrait.js";
import { selection } from "../selection.js";
import "./tree.css";

/**
 * The scene tree, in the shared panel.
 *
 * It was Retopo's outliner and it should never have been: "which meshes are in
 * this model, which materials do they carry, and which maps does each material
 * have" is a question about what is on screen, not about what a decimator is
 * about to do to it. Attaching it to a mode meant the same three levels of
 * information were reachable from one mode and invisible from the other two,
 * and it is what forced Retopo to grow a second navigation of its own.
 *
 * So it lives here now, in one tab, permanently, and Retopo reads the same
 * selection everybody else does.
 *
 * Its module and stylesheet are still fetched rather than parsed at startup, for
 * the reason that outranks everything: this executable is also the Windows shell
 * thumbnail provider, one process per file, and a tree that renders a portrait
 * per row is exactly the sort of thing that must not exist during a thumbnail
 * job.
 */

const fr = (n) => n.toLocaleString("fr-FR");

export function createTree({ host, viewer, channels, swapTexture, onNotice }) {
  host.textContent = "";

  const bar = document.createElement("div");
  bar.className = "tree-bar";
  const count = document.createElement("span");
  const showAll = document.createElement("button");
  showAll.type = "button";
  showAll.className = "tree-mini";
  showAll.textContent = "Tout";
  showAll.title = "Tout réafficher et ne rien laisser sélectionné";
  const only = document.createElement("button");
  only.type = "button";
  only.className = "tree-mini";
  only.textContent = "Isoler";
  only.title = "Masquer tout ce qui n'est pas sélectionné";
  bar.append(count, showAll, only);

  const body = document.createElement("div");
  body.className = "tree-list";

  const empty = document.createElement("p");
  empty.className = "hint";
  empty.textContent = "Ouvre un modèle pour voir ce qu'il contient.";

  host.append(bar, body, empty);

  /**
   * Which branches are open.
   *
   * Meshes start open and materials start closed, because the first question is
   * always "what parts are there" and the maps only matter once one is chosen.
   * Kept as ids and kept across repaints: a tree that snaps shut every time you
   * click an eye is a tree you stop using.
   */
  const opened = new Set();
  /** Whether this model has ever been drawn, so the first paint can open it. */
  let seen = false;

  const notice = (text) => onNotice?.(text);

  /** A caret that opens a branch, or a spacer that keeps the column straight. */
  function caret(id, has) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-caret" + (has ? "" : " empty");
    b.textContent = has ? (opened.has(id) ? "▾" : "▸") : "";
    if (has) {
      b.title = opened.has(id) ? "Replier" : "Déplier";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        opened.has(id) ? opened.delete(id) : opened.add(id);
        paint();
      });
    }
    return b;
  }

  function paint() {
    const meshes = viewer.current ? readScene(viewer, channels) : [];
    empty.hidden = meshes.length > 0;
    bar.hidden = meshes.length === 0;

    // The first paint of a model opens every mesh, so the shape of the file is
    // visible without a single click.
    if (!seen && meshes.length) {
      forgetPortraits();
      for (const m of meshes) opened.add(m.id);
      seen = true;
    }
    if (!meshes.length) seen = false;

    // Anything selected that the current model does not contain is gone: a
    // selection kept across a load points at objects that were disposed.
    const alive = new Set();
    for (const m of meshes) {
      alive.add(m.id);
      for (const mat of m.materials) alive.add(mat.id);
    }
    if (meshes.length) selection.prune(alive);

    body.textContent = "";
    for (const mesh of meshes) body.appendChild(meshNode(mesh));

    count.textContent = selection.size
      ? `${selection.size} sélectionné${selection.size > 1 ? "s" : ""}`
      : "Rien de sélectionné";
    only.disabled = selection.size === 0;
  }

  function meshNode(mesh) {
    const group = document.createElement("div");
    group.className = "tree-node";

    const row = document.createElement("div");
    row.className = "tree-row tree-mesh" + (selection.has(mesh.id) ? " picked" : "");
    row.appendChild(caret(mesh.id, mesh.materials.length > 0));
    // The mesh draws itself. On a file whose parts are called Object_12 through
    // Object_47 this is the only thing that tells one row from another.
    const face = portrait(viewer.renderer, mesh.node);
    row.insertAdjacentHTML(
      "beforeend",
      (face
        ? `<span class="tree-face" style="background-image:url(${face})"></span>`
        : `<span class="tree-glyph">▦</span>`) +
        `<span class="tree-name"></span><span class="tree-num"></span>`
    );
    row.querySelector(".tree-name").textContent = mesh.name;
    row.querySelector(".tree-num").textContent = fr(mesh.triangles);
    row.title = `${mesh.name} · ${fr(mesh.triangles)} triangles`;
    row.addEventListener("click", (e) =>
      selection.choose(mesh.id, "mesh", e.ctrlKey || e.metaKey)
    );
    row.appendChild(
      eye(mesh.visible, mesh.visible ? "Masquer ce maillage" : "Afficher ce maillage", () => {
        mesh.node.visible = !mesh.node.visible;
        notice(`${mesh.name} ${mesh.node.visible ? "affiché" : "masqué"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    row.appendChild(trash(mesh));
    group.appendChild(row);

    if (!opened.has(mesh.id)) return group;
    for (const mat of mesh.materials) group.append(...materialRows(mesh, mat));
    return group;
  }

  function materialRows(mesh, mat) {
    const rows = [];
    const row = document.createElement("div");
    row.className =
      "tree-row tree-mat" + (selection.has(mat.id) ? " picked" : "") + (mat.hidden ? " muted" : "");
    // The material's own portrait: this mesh with every other material ghosted
    // out, which says *where on the part* it sits. A colour swatch says "this
    // one is blue", which is a different and lesser fact.
    const shown = mesh.materials.indexOf(mat);
    const face = portrait(viewer.renderer, mesh.node, mesh.materials.length > 1 ? shown : -1);
    const url = face || thumbnail(mat.material.map);
    row.appendChild(caret(mat.id, mat.maps.length > 0));
    row.insertAdjacentHTML(
      "beforeend",
      `<span class="${face ? "tree-face" : "mat-chip"}"${
        url
          ? ` style="background-image:url(${url})"`
          : ` style="background:${
              mat.material.color ? "#" + mat.material.color.getHexString() : "#3a3f48"
            }"`
      }></span><span class="tree-name"></span><span class="tree-num"></span>`
    );
    row.querySelector(".tree-name").textContent = mat.name;
    row.querySelector(".tree-num").textContent = fr(mat.triangles);
    row.title = `${mat.name} · ${fr(mat.triangles)} triangles`;
    row.addEventListener("click", (e) =>
      selection.choose(mat.id, "material", e.ctrlKey || e.metaKey)
    );
    row.appendChild(
      eye(!mat.hidden, mat.hidden ? "Afficher cette matière" : "Masquer cette matière", () => {
        channels?.setMaterialHidden?.(mat.id, !mat.hidden);
        notice(`${mat.name} ${mat.hidden ? "affichée" : "masquée"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    rows.push(row);

    if (!opened.has(mat.id)) return rows;
    for (const map of mat.maps) rows.push(mapRow(mat, map));
    return rows;
  }

  function mapRow(mat, map) {
    const row = document.createElement("div");
    row.className = "tree-row tree-map" + (map.hidden ? " muted" : "");
    const url = thumbnail(map.texture, 18);
    row.insertAdjacentHTML(
      "beforeend",
      `<span class="mat-chip small"${url ? ` style="background-image:url(${url})"` : ""}></span>` +
        `<span class="tree-name"></span>`
    );
    row.querySelector(".tree-name").textContent = map.label;

    const size = document.createElement("span");
    size.className = "tree-num";
    const img = map.texture?.image;
    size.textContent = img?.width ? `${img.width}×${img.height}` : "";

    // Replacing lives on the row of the map it replaces, rather than in a second
    // list somewhere else saying the same things about the same slots.
    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "tree-swap";
    swap.textContent = "⇄";
    swap.title = `Remplacer ${map.label}`;
    swap.addEventListener("click", (e) => {
      e.stopPropagation();
      swapTexture?.(mat.id, map.slot);
    });

    row.append(
      size,
      swap,
      eye(!map.hidden, map.hidden ? "Rebrancher cette carte" : "Débrancher cette carte", () => {
        const off = toggleMap(mat.material, map.slot);
        notice(`${map.label} ${off ? "débranchée" : "rebranchée"}`);
        viewer.invalidate?.();
        paint();
      })
    );
    return row;
  }

  function eye(on, title, act) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-eye" + (on ? "" : " off");
    b.title = title;
    b.textContent = on ? "◉" : "◌";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      act();
    });
    return b;
  }

  /** Delete a mesh from the scene, whatever its depth in the file. */
  function trash(mesh) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-trash";
    b.title = "Supprimer ce maillage";
    b.textContent = "🗑";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      viewer.removeMesh(mesh.node);
      selection.delete(mesh.id);
      notice(`${mesh.name} supprimé`);
      viewer.invalidate?.();
      paint();
    });
    return b;
  }

  /**
   * Hide everything that is not selected.
   *
   * The fastest way to answer "is this the part I think it is", and the fastest
   * way to set up a restricted run: isolate, look, decimate the visible.
   */
  function isolate() {
    if (!selection.size) return;
    let hidden = 0;
    for (const mesh of readScene(viewer, channels)) {
      const keepMesh =
        selection.has(mesh.id) || mesh.materials.some((m) => selection.has(m.id));
      mesh.node.visible = keepMesh;
      if (!keepMesh) hidden++;
      for (const mat of mesh.materials) {
        // A material is kept when it is picked itself, or when its whole mesh is.
        channels?.setMaterialHidden?.(mat.id, !(selection.has(mesh.id) || selection.has(mat.id)));
      }
    }
    notice(`Isolé : ${hidden} maillage${hidden > 1 ? "s" : ""} masqué${hidden > 1 ? "s" : ""}`);
    viewer.invalidate?.();
    paint();
  }

  /** Everything visible again and nothing selected: the way back, in one button. */
  function reveal() {
    for (const mesh of readScene(viewer, channels)) {
      mesh.node.visible = true;
      for (const mat of mesh.materials) channels?.setMaterialHidden?.(mat.id, false);
    }
    selection.clear();
    viewer.invalidate?.();
    paint();
    notice("Tout affiché");
  }

  only.addEventListener("click", isolate);
  showAll.addEventListener("click", reveal);

  paint();
  return {
    paint,
    /** A new model: forget the portraits, the open branches and the first paint. */
    reset() {
      forgetPortraits();
      opened.clear();
      seen = false;
      paint();
    },
  };
}
