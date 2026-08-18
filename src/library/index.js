import "./library.css";
import { thumbnailFor, releaseThumbnails, cancelPending } from "./thumbs.js";
import { applyStaticIn, locale, register, t } from "../i18n/index.js";
import { setPressed } from "../ui/toggle.js";
import libFr from "./fr.json";
import libEn from "./en.json";

// The library's own strings travel with it, in this chunk, not in the startup
// dictionaries parsed by every Explorer thumbnail job.
register({ fr: libFr, en: libEn });

/**
 * The asset manager.
 *
 * Everything here is loaded the first time it is asked for and never before:
 * Albedo is a viewer, and a viewer that waits on a library scan to show its
 * first frame is a worse viewer. The module, its stylesheet and its thumbnail
 * decoders are one lazy chunk.
 *
 * Annotations travel with the folder. Tags live in a JSON file inside the
 * library, keyed by path relative to its root, so copying the folder to another
 * disk or handing it to someone else carries the tags along and they still
 * resolve. Writing them into the models instead would mean rewriting binary
 * formats, and some of them have nowhere to put a tag at all.
 */

const SIDECAR_VERSION = 1;
const SAVE_DELAY = 600;
const SEARCH_DELAY = 130;

/**
 * Cards are added a page at a time.
 *
 * A library of twenty thousand files is not unusual, and building a card for
 * every one of them means a hundred thousand nodes laid out before the first
 * one is visible, thrown away and built again at the next keystroke. Only what
 * can be reached is built; the rest follows the scrollbar.
 */
const PAGE = 240;

/**
 * Icons, drawn rather than shipped.
 *
 * A handful of paths in the stroke style the rest of the window already uses
 * costs nothing to load, scales to any density and takes the colour of the text
 * it sits next to, which an icon font or a sprite sheet would each complicate.
 */
const ICONS = {
  chevron: '<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen:
    '<path d="M3 18V7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.5 7H19a2 2 0 0 1 2 2v1"/><path d="M3.6 18.4l2-7.4h16.2l-2 7.4a1 1 0 0 1-1 .6H4.6a1 1 0 0 1-1-.6z"/>',
  drive:
    '<rect x="3" y="4.5" width="18" height="6.5" rx="2"/><rect x="3" y="13" width="18" height="6.5" rx="2"/><path d="M6.8 7.75h.01M6.8 16.25h.01"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.83 0l-6.17-6.17A2 2 0 0 1 3.8 13V5.8A1.8 1.8 0 0 1 5.6 4h7.2a2 2 0 0 1 1.43.6l6.37 6.37a2 2 0 0 1 0 2.43z"/><circle cx="8.4" cy="8.4" r="1.2"/>',
  cube: '<path d="M12 2.6l8.5 4.7v9.4L12 21.4 3.5 16.7V7.3z"/><path d="M12 12l8.5-4.7M12 12v9.4M12 12L3.5 7.3"/>',
  image:
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.6" cy="10" r="1.6"/><path d="M20.4 15.6L16 11.2l-8.6 8.3"/>',
};

const icon = (name, cls = "") => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls ? `ico ${cls}` : "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || "";
  return svg;
};

const bytes = (n) => {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} Mo`;
  return `${(n / 1073741824).toFixed(2)} Go`;
};

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, "fr"),
  recent: (a, b) => b.modified - a.modified,
  size: (a, b) => b.size - a.size,
  format: (a, b) => a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, "fr"),
};

// One box inside the host, because the breakpoints below rearrange this grid
// and a container query styles descendants, never the container itself. The
// host measures, the shell reacts.
const SHELL = `
  <div class="lib-shell">
  <div class="lib-bar">
    <button class="icon lib-drawer" data-el="drawer" data-i18n-title="lib.drawer" title="Dossiers et tags" aria-pressed="false">
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <span class="lib-title" data-i18n="lib.title">Bibliothèque</span>
    <span class="lib-spacer"></span>
    <div class="segment" data-el="kinds"></div>
    <select class="quiet" data-el="sort">
      <option value="name" data-i18n="lib.sortName">Nom</option>
      <option value="recent" data-i18n="lib.sortRecent">Plus récent</option>
      <option value="size" data-i18n="lib.sortSize">Taille</option>
      <option value="format" data-i18n="lib.sortFormat">Format</option>
    </select>
    <label class="lib-size" data-i18n-title="lib.zoomTitle" title="Taille des vignettes, Ctrl + molette dans la grille">
      <input type="range" min="84" max="320" step="4" value="132" data-el="zoom" />
    </label>
    <button class="icon" data-el="peek" data-i18n-title="lib.peek" title="Volet d'aperçu" aria-pressed="false">
      <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></svg>
    </button>
    <button class="icon" data-el="close" data-i18n-title="lib.close" title="Retour au viewer (Échap)">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>

  <aside class="lib-side">
    <h3><span data-i18n="lib.libraries">Bibliothèques</span> <button data-el="add" data-i18n="lib.add">Ajouter</button></h3>
    <div data-el="roots"></div>
    <h3 data-i18n="lib.folders">Dossiers</h3>
    <div class="lib-tree" data-el="tree"></div>
  </aside>

  <main class="lib-main">
    <div class="lib-filters" data-el="formats"></div>
    <div class="lib-grid" data-el="grid"></div>
    <div class="lib-detail" data-el="detail"></div>
    <div class="lib-bottom">
      <label class="lib-search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
        <input type="search" data-i18n-placeholder="lib.search" placeholder="Rechercher un nom ou un tag" data-el="search" />
      </label>
      <div class="lib-tags" data-el="tags"></div>
    </div>
  </main>

  <div class="lib-handle" data-el="handle" data-i18n-title="lib.handle" title="Largeur de l'aperçu"></div>
  </div>
`;

/**
 * @param {object} deps
 * @param {object|null} deps.tauri the shell bridge, absent in a plain browser
 * @param {(path: string) => Promise<void>} deps.onOpen open a file in the viewer
 * @param {object} [deps.prefs] persisted settings
 */
export function createLibrary({ tauri, onOpen, prefs, hasModel, refit }) {
  const host = document.createElement("div");
  host.id = "library";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);
  applyStaticIn(host);

  const el = {};
  for (const node of host.querySelectorAll("[data-el]")) el[node.dataset.el] = node;

  const state = {
    roots: [],
    root: null,
    entries: [],
    folders: [],
    /** rel -> { tags: string[], note: string } */
    meta: {},
    truncated: false,
    folder: null,
    tag: null,
    kind: "all",
    format: null,
    sort: prefs?.get?.("libSort") || "name",
    query: "",
    selected: null,
    /** Every chosen entry, by relative path. */
    chosen: new Set(),
    /** Where a range extends from. */
    anchor: null,
    /** Folder paths the tree is showing the inside of. */
    expanded: new Set(),
    /** Which slice of the result is on screen. */
    page: { list: [], shown: 0 },
    open: false,
    peek: false,
    /** Set when the panel is closed by hand, so a click stops reopening it. */
    peekDismissed: false,
  };

  el.sort.value = state.sort;
  el.zoom.value = String(prefs?.get?.("libZoom") || 132);
  el.grid.style.setProperty("--card", `${el.zoom.value}px`);

  // --- shell calls, with a browser fallback so `npm run dev` still runs ---
  const call = async (name, args) => {
    if (!tauri) throw new Error("disponible seulement dans l'application");
    return tauri.core.invoke(name, args);
  };

  // --- kinds -------------------------------------------------------------
  /*
   * A word each, and a glyph each for when the words do not fit.
   *
   * The three of them used to be text only, in a bar that wraps, so a narrow
   * library dropped "Textures" onto a second line under the search field: three
   * buttons that are one choice, drawn as two rows and one orphan, and the bar
   * grew a line to hold it. Then below the last breakpoint the whole group was
   * hidden outright, which answers "there is no room" by taking the control
   * away.
   *
   * Both are the same mistake, that a label is the control. It is not: the
   * choice is, and it survives losing its words. The group never wraps now, and
   * when the bar gets tight the labels go and the icons stay, which is the same
   * three buttons in a third of the width.
   */
  const KIND_ICONS = {
    all: '<circle cx="8.5" cy="12" r="4.5"/><circle cx="15.5" cy="12" r="4.5"/>',
    model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" />',
    texture:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" />' +
      '<path d="M4 16l5-4.5 4 3.5 3-2.5 4 3.5" />',
  };
  for (const [id, key] of [["all", "lib.kindAll"], ["model", "lib.kindModel"], ["texture", "lib.kindTexture"]]) {
    const label = t(key);
    const b = document.createElement("button");
    b.className = "seg" + (id === "all" ? " active" : "");
    b.innerHTML =
      `<svg class="seg-icon" viewBox="0 0 24 24" aria-hidden="true">${KIND_ICONS[id]}</svg>` +
      `<span class="seg-label"></span>`;
    b.querySelector(".seg-label").textContent = label;
    // The word disappears at narrow widths, so the tooltip carries it instead.
    b.title = label;
    b.addEventListener("click", () => {
      state.kind = id;
      state.format = null;
      for (const other of el.kinds.children) other.classList.toggle("active", other === b);
      paint();
    });
    el.kinds.appendChild(b);
  }

  // --- libraries ---------------------------------------------------------
  async function loadRoots(select) {
    state.roots = await call("library_roots").catch(() => []);
    paintRoots();
    const wanted = select || prefs?.get?.("libRoot");
    const found = state.roots.find((r) => r.path === wanted) || state.roots[0];
    if (found) await openRoot(found);
    else paint();
  }

  function paintRoots() {
    el.roots.textContent = "";
    if (!state.roots.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = t("lib.empty");
      el.roots.appendChild(hint);
      return;
    }
    for (const root of state.roots) {
      const row = document.createElement("button");
      row.className = "lib-item" + (state.root?.path === root.path ? " active" : "");
      row.title = root.path;
      const name = document.createElement("span");
      name.className = "label";
      name.textContent = root.name;
      row.appendChild(icon("drive"));
      const drop = document.createElement("span");
      drop.className = "drop";
      drop.textContent = "✕";
      drop.title = t("lib.remove");
      drop.addEventListener("click", async (e) => {
        e.stopPropagation();
        state.roots = await call("library_remove", { path: root.path });
        if (state.root?.path === root.path) state.root = null;
        paintRoots();
        if (!state.root && state.roots[0]) await openRoot(state.roots[0]);
        else paint();
      });
      row.append(name, drop);
      row.addEventListener("click", () => openRoot(root));
      el.roots.appendChild(row);
    }
  }

  el.add.addEventListener("click", async () => {
    const picked = await tauri?.dialog?.open({ directory: true, multiple: false });
    if (!picked) return;
    const roots = await call("library_add", { path: picked }).catch((e) => {
      notice(String(e));
      return null;
    });
    if (roots) {
      state.roots = roots;
      await loadRoots(picked);
    }
  });

  async function openRoot(root) {
    state.root = root;
    state.folder = null;
    state.tag = null;
    state.format = null;
    state.selected = null;
    state.chosen.clear();
    state.anchor = null;
    prefs?.set?.("libRoot", root.path);
    paintRoots();
    el.grid.innerHTML = `<div class="lib-empty"><div class="lib-spin" style="margin:0 auto"></div></div>`;

    const scan = await call("library_scan", { root: root.path, limit: 20000 }).catch((e) => {
      notice(String(e));
      return null;
    });
    if (!scan || state.root?.path !== root.path) return;
    state.entries = scan.entries;
    state.folders = scan.folders;
    state.truncated = scan.truncated;
    state.meta = await readMeta(root.path);
    paintTree();
    paintTags();
    paint();
  }

  // --- the sidecar -------------------------------------------------------
  async function readMeta(root) {
    const text = await call("library_meta_read", { root }).catch(() => null);
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed?.items && typeof parsed.items === "object" ? parsed.items : {};
    } catch (_) {
      // A hand edited file should not lose the library, only its annotations
      notice("annotations illisibles, elles seront réécrites");
      return {};
    }
  }

  let saveTimer = null;
  function saveMeta() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!state.root) return;
      // Entries with nothing on them are dropped, so the file stays readable
      const items = {};
      for (const [rel, value] of Object.entries(state.meta)) {
        if (value?.tags?.length || value?.note) items[rel] = value;
      }
      const payload = JSON.stringify(
        { albedo: SIDECAR_VERSION, name: state.root.name, items },
        null,
        2
      );
      await call("library_meta_write", { root: state.root.path, data: payload }).catch((e) =>
        notice(`écriture impossible : ${e}`)
      );
    }, SAVE_DELAY);
  }

  const tagsOf = (rel) => state.meta[rel]?.tags || [];

  function addTag(rel, tag) {
    const clean = tag.trim().toLowerCase();
    if (!clean) return;
    const entry = (state.meta[rel] ||= { tags: [], note: "" });
    entry.tags ||= [];
    if (!entry.tags.includes(clean)) entry.tags.push(clean);
    saveMeta();
  }

  function removeTag(rel, tag) {
    const entry = state.meta[rel];
    if (!entry?.tags) return;
    entry.tags = entry.tags.filter((t) => t !== tag);
    saveMeta();
  }

  // --- sidebar lists -----------------------------------------------------
  /**
   * The folder tree, derived from the files rather than from the walk.
   *
   * The scan only reports folders that directly hold something, so a library
   * laid out as `chars/hero/body.glb` reported `chars/hero` and never `chars`:
   * the tree had holes in it and the top level was missing. Rebuilding it from
   * the relative paths puts every intermediate level back, and gives each one a
   * count of everything at or below it, which is the number a person actually
   * wants when deciding where to look.
   */
  function buildTree(entries) {
    const root = { name: t("lib.kindAll"), path: null, children: new Map(), count: entries.length };
    for (const entry of entries) {
      const parts = entry.rel.split("/");
      parts.pop(); // the file itself
      let node = root;
      let path = "";
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, path, children: new Map(), count: 0 });
        }
        node = node.children.get(part);
        node.count++;
      }
    }
    return root;
  }

  function paintTree() {
    el.tree.textContent = "";
    const tree = buildTree(state.entries);

    // Whatever is selected must be reachable without hunting for it. Its
    // ancestors only: forcing the folder itself open as well meant a selected
    // folder could not be collapsed, since it reopened on the next paint.
    if (state.folder) {
      const parts = state.folder.split("/");
      for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join("/"));
    }

    const row = (node, depth) => {
      const line = document.createElement("div");
      line.className = "lib-row";
      line.style.setProperty("--depth", String(depth));

      const hasChildren = node.children.size > 0;
      const open = node.path === null || state.expanded.has(node.path);

      const twist = document.createElement("button");
      twist.className = "twist" + (open ? " open" : "");
      twist.type = "button";
      if (hasChildren) {
        twist.appendChild(icon("chevron"));
        twist.title = open ? t("lib.collapse") : t("lib.expand");
        twist.addEventListener("click", (e) => {
          e.stopPropagation();
          if (open) state.expanded.delete(node.path);
          else state.expanded.add(node.path);
          paintTree();
        });
      } else {
        twist.disabled = true;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "lib-item" + (state.folder === node.path ? " active" : "");
      button.title = node.path || t("lib.allLibrary");
      button.append(
        icon(node.path === null ? "drive" : open && hasChildren ? "folderOpen" : "folder"),
        Object.assign(document.createElement("span"), { textContent: node.name, className: "label" })
      );
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(node.count);
      button.appendChild(count);
      button.addEventListener("click", () => {
        state.folder = state.folder === node.path ? null : node.path;
        paintTree();
        paint();
      });

      line.append(twist, button);
      el.tree.appendChild(line);

      if (!open) return;
      const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
      for (const child of kids) row(child, depth + 1);
    };

    row(tree, 0);
  }

  function paintTags() {
    const counts = new Map();
    for (const entry of state.entries) {
      for (const tag of tagsOf(entry.rel)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    el.tags.textContent = "";
    if (!counts.size) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = t("lib.tagHint");
      el.tags.appendChild(hint);
      return;
    }
    for (const [tag, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const b = document.createElement("button");
      b.className = "lib-tag" + (state.tag === tag ? " active" : "");
      b.append(icon("tag"), document.createTextNode(`${tag} ${n}`));
      b.addEventListener("click", () => {
        state.tag = state.tag === tag ? null : tag;
        paintTags();
        paint();
      });
      el.tags.appendChild(b);
    }
  }

  function paintFormats(visible) {
    const counts = new Map();
    for (const entry of visible) counts.set(entry.ext, (counts.get(entry.ext) || 0) + 1);
    el.formats.textContent = "";

    const all = document.createElement("button");
    all.className = "lib-tag" + (state.format === null ? " active" : "");
    all.textContent = t("lib.allFormats");
    all.addEventListener("click", () => {
      state.format = null;
      paint();
    });
    el.formats.appendChild(all);

    for (const [ext, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const b = document.createElement("button");
      b.className = "lib-tag" + (state.format === ext ? " active" : "");
      b.textContent = `${ext.toUpperCase()} ${n}`;
      b.addEventListener("click", () => {
        state.format = state.format === ext ? null : ext;
        paint();
      });
      el.formats.appendChild(b);
    }

    const count = document.createElement("span");
    count.className = "lib-count mono";
    count.textContent = state.truncated
      ? t("lib.countTruncated").replace("{n}", visible.length)
      : t(visible.length > 1 ? "lib.countMany" : "lib.countOne").replace("{n}", visible.length);
    el.formats.appendChild(count);
  }

  // --- filtering ---------------------------------------------------------
  function visibleEntries() {
    const query = state.query.trim().toLowerCase();
    return state.entries.filter((entry) => {
      if (state.kind !== "all" && entry.kind !== state.kind) return false;
      if (state.folder !== null && !entry.rel.startsWith(`${state.folder}/`)) return false;
      if (state.tag && !tagsOf(entry.rel).includes(state.tag)) return false;
      if (query) {
        const hay = `${entry.rel} ${tagsOf(entry.rel).join(" ")}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }

  // --- grid --------------------------------------------------------------
  let observer = null;

  function paint() {
    // Pictures asked for by the previous view are of no use now, and each one
    // that is still missing costs a process to make.
    cancelPending();
    const beforeFormat = visibleEntries();
    paintFormats(beforeFormat);
    const list = state.format ? beforeFormat.filter((e) => e.ext === state.format) : beforeFormat;
    list.sort(SORTS[state.sort] || SORTS.name);

    observer?.disconnect();
    observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          observer.unobserve(record.target);
          fillArt(record.target);
        }
      },
      { root: el.grid, rootMargin: "220px" }
    );

    el.grid.textContent = "";
    el.grid.scrollTop = 0;
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "lib-empty";
      empty.textContent = state.root
        ? t("lib.noMatch")
        : t("lib.empty");
      el.grid.appendChild(empty);
      state.page = { list: [], shown: 0 };
      paintDetail();
      return;
    }

    state.page = { list, shown: 0 };
    grow();
    paintDetail();
  }

  /**
   * Add the next page of cards.
   *
   * Twenty thousand cards is a hundred thousand nodes laid out before the first
   * one is visible, thrown away and built again at the next keystroke. Only what
   * the scrollbar can reach is built.
   */
  function grow() {
    const { list, shown } = state.page;
    if (shown >= list.length) return;
    const frag = document.createDocumentFragment();
    const until = Math.min(shown + PAGE, list.length);
    for (let i = shown; i < until; i++) frag.appendChild(card(list[i]));
    el.grid.appendChild(frag);
    state.page.shown = until;
  }

  /** Keep filling while the end of the grid is in sight. */
  function growIfNeeded() {
    if (state.page.shown >= state.page.list.length) return;
    const room = el.grid.scrollHeight - el.grid.scrollTop - el.grid.clientHeight;
    if (room < el.grid.clientHeight) {
      grow();
      // A short list may not reach the bottom even after a page
      requestAnimationFrame(growIfNeeded);
    }
  }

  function card(entry) {
    const node = document.createElement("button");
    node.className = "card" + (state.chosen.has(entry.rel) ? " selected" : "");
    node._rel = entry.rel;
    node.type = "button";

    const art = document.createElement("div");
    art.className = "card-art" + (entry.kind === "texture" ? " texture" : "");
    art._entry = entry;

    art.appendChild(icon(entry.kind === "texture" ? "image" : "cube", "placeholder"));

    const ext = document.createElement("span");
    ext.className = "card-ext";
    ext.textContent = entry.ext;
    art.appendChild(ext);
    if (tagsOf(entry.rel).length) {
      const dot = document.createElement("span");
      dot.className = "card-dot";
      dot.title = tagsOf(entry.rel).join(", ");
      art.appendChild(dot);
    }

    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = entry.name;
    name.title = entry.rel;

    const sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = bytes(entry.size);

    node.append(art, name, sub);
    node.addEventListener("click", (e) => {
      // Plain click replaces, control adds or removes, shift takes the run
      // between the anchor and here, which is what every file list does.
      if (e.shiftKey && state.anchor) {
        const list = state.page.list;
        const from = list.findIndex((x) => x.rel === state.anchor);
        const to = list.findIndex((x) => x.rel === entry.rel);
        if (from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from];
          if (!e.ctrlKey && !e.metaKey) state.chosen.clear();
          for (let i = a; i <= b; i++) state.chosen.add(list[i].rel);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (state.chosen.has(entry.rel)) state.chosen.delete(entry.rel);
        else state.chosen.add(entry.rel);
        state.anchor = entry.rel;
      } else {
        state.chosen.clear();
        state.chosen.add(entry.rel);
        state.anchor = entry.rel;
      }
      state.selected = state.chosen.has(entry.rel) ? entry : null;
      paintChosen();
      paintDetail();
      // The strip shows one asset, so it only follows a selection of one.
      // Building a selection is not a request to look at each thing put in it:
      // every control-click used to load another model into the viewer, and a
      // run taken with shift loaded them one after another.
      if (state.chosen.size === 1 && state.selected) {
        /*
         * A click opens the side viewer, rather than waiting to be told twice.
         *
         * Selecting a card and getting nothing until you find the panel button
         * makes the first click a wasted one, and the panel is what selecting a
         * card is *for*. So it opens itself.
         *
         * Unless you closed it on purpose. Auto-opening a panel someone has just
         * dismissed is an argument, not a convenience, so an explicit close is
         * remembered for the session and a click then does what it did before.
         */
        if (!state.peek && !state.peekDismissed) {
          /*
           * The strip has to have its width before it has its model.
           *
           * Coming from an empty viewer the library owns the whole window, and
           * opening the strip without saying how wide left it on whatever the
           * last session had written: a sliver at the right edge with the model
           * loading behind the folder list. `show` already sizes it when there
           * is a model to keep beside it, and this is the same moment for the
           * case where the model arrives second.
           */
          sizeStripForModel();
          /*
           * `setPeek` peeks on its way in, so this must not peek again.
           *
           * `peek` opens with `clearTimeout(peekTimer)` and then returns early
           * when the asset asked for is the one it is already showing. A second
           * call therefore cancels the load the first one had just scheduled and
           * returns without rescheduling it: the panel opened and stayed empty,
           * which is exactly the shape of the bug this line caused.
           */
          setPeek(true);
        } else if (state.peek) {
          peek(state.selected);
        }
      }
    });
    node.addEventListener("dblclick", () => open(entry));
    observer.observe(art);
    return node;
  }

  /** Which cards are ringed, without rebuilding any of them. */
  function paintChosen() {
    for (const node of el.grid.children) {
      if (node._rel) node.classList.toggle("selected", state.chosen.has(node._rel));
    }
  }

  /** Fill a card once it comes into view, never before. */
  async function fillArt(art) {
    const entry = art._entry;
    if (!entry || art._filled) return;
    art._filled = true;

    const spin = document.createElement("div");
    spin.className = "lib-spin";
    art.appendChild(spin);

    const size = Number(el.zoom.value) >= 200 ? 512 : 256;
    const src = await thumbnailFor(entry, { call, tauri, size }).catch(() => null);
    spin.remove();
    if (!src) return;

    art.querySelector(".placeholder")?.remove();
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.alt = "";
    art.prepend(img);
  }

  // --- detail bar --------------------------------------------------------
  /**
   * The bar under the grid, which acts on everything chosen.
   *
   * Tagging one asset at a time is fine for one asset. A library is sorted in
   * runs, so a tag typed once has to land on the whole run: the count in the
   * bar is what says how many it will reach.
   */
  function paintDetail() {
    const chosen = [...state.chosen];
    const entry = state.selected;
    el.detail.classList.toggle("open", chosen.length > 0);
    el.detail.textContent = "";
    if (!chosen.length) return;

    const many = chosen.length > 1;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = many
      ? t("lib.chosenMany").replace("{n}", chosen.length)
      : entry?.name ?? chosen[0];
    name.title = many ? chosen.slice(0, 20).join(String.fromCharCode(10)) : entry?.path ?? "";

    const meta = document.createElement("span");
    meta.className = "meta";
    if (many) {
      const total = state.entries.filter((x) => state.chosen.has(x.rel)).reduce((n, x) => n + x.size, 0);
      meta.textContent = bytes(total);
    } else if (entry) {
      const date = new Date(entry.modified * 1000);
      meta.textContent =
        `${entry.ext.toUpperCase()} · ${bytes(entry.size)} · ` +
        date.toLocaleDateString(locale());
    }

    // A tag shown here is one every chosen asset carries; removing it removes
    // it from all of them, which is the only reading that is not a surprise.
    const shared = chosen
      .map((rel) => tagsOf(rel))
      .reduce((all, tags) => all.filter((t) => tags.includes(t)), tagsOf(chosen[0]).slice());

    const chips = document.createElement("span");
    chips.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";
    for (const tag of shared) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.append(tag);
      const drop = document.createElement("button");
      drop.textContent = "✕";
      drop.title = many ? t("lib.removeTagMany").replace("{n}", chosen.length) : t("lib.removeTagOne");
      drop.addEventListener("click", () => {
        for (const rel of chosen) removeTag(rel, tag);
        paintDetail();
        paintTags();
        paintChosen();
      });
      chip.appendChild(drop);
      chips.appendChild(chip);
    }

    const input = document.createElement("input");
    input.className = "tag-input";
    input.placeholder = many
      ? t("lib.tagMany").replace("{n}", chosen.length)
      : t("lib.tagOne");
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !input.value.trim()) return;
      for (const rel of chosen) addTag(rel, input.value);
      input.value = "";
      paintDetail();
      paintTags();
      paintChosen();
    });

    const spacer = document.createElement("span");
    spacer.className = "lib-spacer";

    el.detail.append(name, meta, chips, input, spacer);
    if (!many && entry) {
      const openIt = document.createElement("button");
      openIt.className = "wide";
      openIt.style.width = "auto";
      openIt.textContent = "Ouvrir";
      openIt.addEventListener("click", () => open(entry));
      el.detail.appendChild(openIt);
    }
  }

  async function open(entry) {
    if (entry.kind === "texture") {
      // A texture is not a scene; showing it large is the useful answer
      window.open(tauri ? tauri.core.convertFileSrc(entry.path) : entry.path, "_blank");
      return;
    }
    hide();
    await onOpen(entry.path);
  }

  function notice(message) {
    console.warn("[albedo] bibliothèque :", message);
  }

  // --- preview strip -----------------------------------------------------
  //
  // One click shows the asset without leaving the grid. The strip is not a
  // second viewer: the library gives up its right edge and the real one draws
  // there, with its own navigation, lighting and inspector. A texture is not a
  // scene, so it is shown as the picture it is.

  let peekTimer = null;
  /**
   * What the strip already shows.
   *
   * Nothing else can change the viewer while the library is up, so asking for
   * the asset already on screen is answered by leaving it there rather than by
   * loading it again. Cleared on the way out, where that stops being true.
   */
  let peeked = null;

  function peek(entry) {
    clearTimeout(peekTimer);
    if (!entry || entry.rel === peeked) return;
    peeked = entry.rel;
    if (entry.kind === "texture") {
      const image = document.getElementById("peek-image");
      if (image) {
        image.src = tauri ? tauri.core.convertFileSrc(entry.path) : entry.path;
        image.hidden = false;
      }
      return;
    }
    const image = document.getElementById("peek-image");
    if (image) image.hidden = true;
    // A click that only passes through on its way elsewhere should not cost a
    // full load, so the strip waits to see whether the selection settles.
    peekTimer = setTimeout(() => onOpen(entry.path, { keepLibrary: true }), 180);
  }

  /**
   * The split to open on, when the library arrives over a loaded model.
   *
   * Thirty percent to the folder list and the rest to the model: enough columns
   * of thumbnails to pick from, and a viewport still worth looking at. Written
   * only when the user has no remembered width of their own, because a width
   * they dragged is an answer they already gave.
   */
  function sizeStripForModel() {
    const saved = Number(prefs?.get?.("libPeekWidth")) || 0;
    /*
     * A remembered width is an answer, until it stops being one.
     *
     * Drag the divider all the way over and it clamps at 220px, which is then
     * saved and restored in every session after: the strip came back as a
     * two hundred pixel slot whatever the window, and a model previewed into it
     * showed about one leg. That is not a width someone chose for looking at
     * models, it is the edge of the drag, and treating it as a preference meant
     * the application never recovered from one careless drag.
     *
     * So a saved width is kept whenever it leaves the viewer a usable share, and
     * a 40 percent library is well inside that. Below it, the default answers
     * instead.
     */
    const usable = saved >= window.innerWidth * 0.3 ? saved : 0;
    const width = usable || Math.round(window.innerWidth * 0.7);
    document.documentElement.style.setProperty("--peek", `${width}px`);
  }

  function setPeek(on, remember = true) {
    state.peek = !!on;
    document.body.classList.toggle("peeking", state.peek);
    setPressed(el.peek, state.peek);
    if (!state.peek) {
      const image = document.getElementById("peek-image");
      if (image) image.hidden = true;
    }
    if (remember) prefs?.set?.("libPeek", state.peek);
    // The viewer sizes itself to its box, which just changed
    window.dispatchEvent(new Event("resize"));
    /*
     * And a preview already on screen was framed for the box it had before.
     *
     * Opening the strip over a model loaded a moment earlier leaves the camera
     * fitted to a window that is now a column, so the model sits mostly outside
     * it. Only a preview is refitted: a document being worked on has a camera
     * someone put where they wanted it, and moving that would be worse than any
     * framing.
     */
    if (state.peek) refit?.();
    if (state.peek && state.selected) peek(state.selected);
  }

  el.peek.addEventListener("click", () => {
    // Closing it by hand is the one thing that stops a click from reopening it.
    state.peekDismissed = state.peek;
    setPeek(!state.peek);
  });

  /** Drag the edge; the width is the user's, and it is remembered. */
  el.handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      // The same two floors the stylesheet clamps to. Dragging past a limit the
      // stylesheet then puts back is a divider that argues with the cursor.
      const width = Math.min(
        window.innerWidth - 280,
        Math.max(280, window.innerWidth - ev.clientX)
      );
      document.documentElement.style.setProperty("--peek", `${Math.round(width)}px`);
      window.dispatchEvent(new Event("resize"));
    };
    const up = () => {
      el.handle.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const width = parseInt(document.documentElement.style.getPropertyValue("--peek"), 10);
      if (width) prefs?.set?.("libPeekWidth", width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // --- wiring ------------------------------------------------------------
  // Repainting on every keystroke rebuilds the whole grid while someone is
  // still typing the word; a short wait costs nothing and saves all of it.
  let searchTimer = null;
  el.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = el.search.value;
      paint();
    }, SEARCH_DELAY);
  });
  el.search.addEventListener("keydown", (e) => e.stopPropagation());
  el.sort.addEventListener("change", () => {
    state.sort = el.sort.value;
    prefs?.set?.("libSort", state.sort);
    paint();
  });
  function setZoom(px) {
    const value = Math.min(Number(el.zoom.max) || 320, Math.max(Number(el.zoom.min) || 84, Math.round(px)));
    el.zoom.value = String(value);
    el.grid.style.setProperty("--card", `${value}px`);
    prefs?.set?.("libZoom", value);
    return value;
  }
  el.zoom.addEventListener("input", () => setZoom(Number(el.zoom.value)));

  // Ctrl and the wheel resizes the cards, the gesture every file browser and
  // map uses. Without the modifier the wheel keeps scrolling the grid.
  el.grid.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(Number(el.zoom.value) * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    },
    { passive: false }
  );
  // On a narrow window the sidebar is a drawer rather than a column
  el.drawer.addEventListener("click", () => {
    setPressed(el.drawer, host.classList.toggle("browsing"), { active: false });
  });
  // Picking something is the end of browsing, so the drawer gets out of the way
  el.tree.addEventListener("click", () => host.classList.remove("browsing"));
  el.tags.addEventListener("click", () => host.classList.remove("browsing"));
  /*
   * And so is reaching past it.
   *
   * The drawer slides over the grid and it used to stay there until the same
   * button was found again, so the first click anywhere else went into whatever
   * the drawer was covering, or into nothing at all. Every drawer in every
   * application closes when you reach around it; this one just never did.
   *
   * Captured on the host rather than on the document, so it hears the click
   * before a card can act on it, and it costs nothing while the drawer is shut.
   */
  host.addEventListener(
    "pointerdown",
    (e) => {
      if (!host.classList.contains("browsing")) return;
      if (e.target.closest(".lib-side") || e.target.closest(".lib-drawer")) return;
      host.classList.remove("browsing");
      setPressed(el.drawer, false, { active: false });
    },
    true
  );

  el.grid.addEventListener("scroll", growIfNeeded, { passive: true });
  el.close.addEventListener("click", () => hide());

  function show() {
    state.open = true;
    host.classList.add("open");
    document.body.classList.add("library-open");
    /*
     * A model already on screen is not a model you asked to leave.
     *
     * Opening the library used to take the whole window whenever the strip was
     * off, which is right from an empty viewer and wrong from a model you are
     * working on: it replaces what you were looking at with a folder listing,
     * and getting back to it is a second click. With something loaded the
     * library comes up beside it instead, as a column, and the model keeps most
     * of the room.
     *
     * Only when the strip has never been shut by hand: closing it is a decision
     * and it outranks this.
     */
    if (!state.peek && !state.peekDismissed && hasModel?.()) {
      sizeStripForModel();
      setPeek(true, false);
    }
    if (state.peek) document.body.classList.add("peeking");
    el.search.focus();
    if (!state.roots.length) loadRoots();
    window.dispatchEvent(new Event("resize"));
  }

  function hide() {
    state.open = false;
    host.classList.remove("open");
    document.body.classList.remove("library-open");
    // The strip belongs to the library; the viewer takes its window back
    document.body.classList.remove("peeking");
    const image = document.getElementById("peek-image");
    if (image) image.hidden = true;
    // Out here the viewer answers to someone else, so what it holds is no
    // longer known and the next preview has to load rather than assume.
    peeked = null;
    clearTimeout(peekTimer);
    window.dispatchEvent(new Event("resize"));
  }

  window.addEventListener("keydown", (e) => {
    if (!state.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

  const savedWidth = prefs?.get?.("libPeekWidth");
  if (savedWidth) document.documentElement.style.setProperty("--peek", `${savedWidth}px`);
  state.peek = !!prefs?.get?.("libPeek");
  setPressed(el.peek, state.peek);

  loadRoots();
  // Pictures nothing can reach any more, dropped once, off the critical path
  call("thumbnails_prune").catch(() => {});

  return {
    show,
    hide,
    toggle: () => (state.open ? hide() : show()),
    get isOpen() {
      return state.open;
    },
    dispose() {
      observer?.disconnect();
      releaseThumbnails();
      host.remove();
    },
  };
}
