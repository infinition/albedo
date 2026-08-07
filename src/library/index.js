import "./library.css";
import { thumbnailFor, releaseThumbnails } from "./thumbs.js";

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

const SHELL = `
  <div class="lib-bar">
    <span class="lib-title">Bibliothèque</span>
    <label class="lib-search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input type="search" placeholder="Rechercher un nom ou un tag" data-el="search" />
    </label>
    <span class="lib-spacer"></span>
    <div class="segment" data-el="kinds"></div>
    <select class="quiet" data-el="sort">
      <option value="name">Nom</option>
      <option value="recent">Plus récent</option>
      <option value="size">Taille</option>
      <option value="format">Format</option>
    </select>
    <label class="lib-size" title="Taille des vignettes, Ctrl + molette dans la grille">
      <input type="range" min="84" max="320" step="4" value="132" data-el="zoom" />
    </label>
    <button class="icon" data-el="peek" title="Volet d'aperçu" aria-pressed="false">
      <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></svg>
    </button>
    <button class="icon" data-el="close" title="Retour au viewer (Échap)">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>

  <aside class="lib-side">
    <h3>Bibliothèques <button data-el="add">Ajouter</button></h3>
    <div data-el="roots"></div>
    <h3>Dossiers</h3>
    <div class="lib-tree" data-el="tree"></div>
    <h3>Tags</h3>
    <div class="lib-tags" data-el="tags"></div>
  </aside>

  <main class="lib-main">
    <div class="lib-filters" data-el="formats"></div>
    <div class="lib-grid" data-el="grid"></div>
    <div class="lib-detail" data-el="detail"></div>
  </main>

  <div class="lib-handle" data-el="handle" title="Largeur de l'aperçu"></div>
`;

/**
 * @param {object} deps
 * @param {object|null} deps.tauri the shell bridge, absent in a plain browser
 * @param {(path: string) => Promise<void>} deps.onOpen open a file in the viewer
 * @param {object} [deps.prefs] persisted settings
 */
export function createLibrary({ tauri, onOpen, prefs }) {
  const host = document.createElement("div");
  host.id = "library";
  host.innerHTML = SHELL;
  document.getElementById("app").appendChild(host);

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
    /** Folder paths the tree is showing the inside of. */
    expanded: new Set(),
    /** Which slice of the result is on screen. */
    page: { list: [], shown: 0 },
    open: false,
    peek: false,
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
  for (const [id, label] of [["all", "Tout"], ["model", "Modèles"], ["texture", "Textures"]]) {
    const b = document.createElement("button");
    b.className = "seg" + (id === "all" ? " active" : "");
    b.textContent = label;
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
      hint.textContent = "Ajoute un dossier pour commencer.";
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
      drop.title = "Retirer de la liste (le dossier n'est pas touché)";
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
    const root = { name: "Tout", path: null, children: new Map(), count: entries.length };
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
        twist.title = open ? "Replier" : "Déplier";
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
      button.title = node.path || "Toute la bibliothèque";
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
      hint.textContent = "Sélectionne un élément pour lui poser un tag.";
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
    all.textContent = "Tous formats";
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
      ? `${visible.length} affichés, dossier tronqué`
      : `${visible.length} élément${visible.length > 1 ? "s" : ""}`;
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
        ? "Rien ne correspond."
        : "Ajoute un dossier pour commencer.";
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
    node.className = "card" + (state.selected?.rel === entry.rel ? " selected" : "");
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
    node.addEventListener("click", () => {
      state.selected = entry;
      for (const other of el.grid.children) other.classList.remove("selected");
      node.classList.add("selected");
      paintDetail();
      if (state.peek) peek(entry);
    });
    node.addEventListener("dblclick", () => open(entry));
    observer.observe(art);
    return node;
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
  function paintDetail() {
    const entry = state.selected;
    el.detail.classList.toggle("open", !!entry);
    el.detail.textContent = "";
    if (!entry) return;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    name.title = entry.path;

    const meta = document.createElement("span");
    meta.className = "meta";
    const date = new Date(entry.modified * 1000);
    meta.textContent = `${entry.ext.toUpperCase()} · ${bytes(entry.size)} · ${date.toLocaleDateString("fr-FR")}`;

    const chips = document.createElement("span");
    chips.style.display = "flex";
    chips.style.gap = "5px";
    chips.style.flexWrap = "wrap";
    for (const tag of tagsOf(entry.rel)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.append(tag);
      const drop = document.createElement("button");
      drop.textContent = "✕";
      drop.title = "Retirer";
      drop.addEventListener("click", () => {
        removeTag(entry.rel, tag);
        paintDetail();
        paintTags();
        paint();
      });
      chip.appendChild(drop);
      chips.appendChild(chip);
    }

    const input = document.createElement("input");
    input.className = "tag-input";
    input.placeholder = "Ajouter un tag, Entrée";
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !input.value.trim()) return;
      addTag(entry.rel, input.value);
      input.value = "";
      paintDetail();
      paintTags();
      paint();
    });

    const spacer = document.createElement("span");
    spacer.className = "lib-spacer";

    const openIt = document.createElement("button");
    openIt.className = "wide";
    openIt.style.width = "auto";
    openIt.textContent = "Ouvrir";
    openIt.addEventListener("click", () => open(entry));

    el.detail.append(name, meta, chips, input, spacer, openIt);
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

  function peek(entry) {
    clearTimeout(peekTimer);
    if (!entry) return;
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

  function setPeek(on, remember = true) {
    state.peek = !!on;
    document.body.classList.toggle("peeking", state.peek);
    el.peek.classList.toggle("active", state.peek);
    el.peek.setAttribute("aria-pressed", String(state.peek));
    if (!state.peek) {
      const image = document.getElementById("peek-image");
      if (image) image.hidden = true;
    }
    if (remember) prefs?.set?.("libPeek", state.peek);
    // The viewer sizes itself to its box, which just changed
    window.dispatchEvent(new Event("resize"));
    if (state.peek && state.selected) peek(state.selected);
  }

  el.peek.addEventListener("click", () => setPeek(!state.peek));

  /** Drag the edge; the width is the user's, and it is remembered. */
  el.handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const width = Math.min(window.innerWidth - 320, Math.max(220, window.innerWidth - ev.clientX));
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
  el.grid.addEventListener("scroll", growIfNeeded, { passive: true });
  el.close.addEventListener("click", () => hide());

  function show() {
    state.open = true;
    host.classList.add("open");
    document.body.classList.add("library-open");
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
  el.peek.classList.toggle("active", state.peek);
  el.peek.setAttribute("aria-pressed", String(state.peek));

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
