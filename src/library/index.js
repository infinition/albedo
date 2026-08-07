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
    <label class="lib-size" title="Taille des vignettes">
      <input type="range" min="84" max="320" step="4" value="132" data-el="zoom" />
    </label>
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
    open: false,
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
      name.textContent = root.name;
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
  function paintTree() {
    el.tree.textContent = "";
    const all = document.createElement("button");
    all.className = "lib-item" + (state.folder === null ? " active" : "");
    all.textContent = "Tout";
    all.addEventListener("click", () => {
      state.folder = null;
      paintTree();
      paint();
    });
    el.tree.appendChild(all);

    for (const folder of state.folders) {
      const row = document.createElement("button");
      row.className = "lib-item" + (state.folder === folder ? " active" : "");
      row.style.setProperty("--depth", String(folder.split("/").length));
      row.textContent = folder.split("/").pop();
      row.title = folder;
      row.addEventListener("click", () => {
        state.folder = state.folder === folder ? null : folder;
        paintTree();
        paint();
      });
      el.tree.appendChild(row);
    }
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
      b.textContent = `${tag} ${n}`;
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
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "lib-empty";
      empty.textContent = state.root
        ? "Rien ne correspond."
        : "Ajoute un dossier pour commencer.";
      el.grid.appendChild(empty);
      paintDetail();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of list) frag.appendChild(card(entry));
    el.grid.appendChild(frag);
    paintDetail();
  }

  function card(entry) {
    const node = document.createElement("button");
    node.className = "card" + (state.selected?.rel === entry.rel ? " selected" : "");
    node.type = "button";

    const art = document.createElement("div");
    art.className = "card-art" + (entry.kind === "texture" ? " texture" : "");
    art._entry = entry;

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

  // --- wiring ------------------------------------------------------------
  el.search.addEventListener("input", () => {
    state.query = el.search.value;
    paint();
  });
  el.search.addEventListener("keydown", (e) => e.stopPropagation());
  el.sort.addEventListener("change", () => {
    state.sort = el.sort.value;
    prefs?.set?.("libSort", state.sort);
    paint();
  });
  el.zoom.addEventListener("input", () => {
    el.grid.style.setProperty("--card", `${el.zoom.value}px`);
    prefs?.set?.("libZoom", Number(el.zoom.value));
  });
  el.close.addEventListener("click", () => hide());

  function show() {
    state.open = true;
    host.classList.add("open");
    document.body.classList.add("library-open");
    el.search.focus();
    if (!state.roots.length) loadRoots();
  }

  function hide() {
    state.open = false;
    host.classList.remove("open");
    document.body.classList.remove("library-open");
  }

  window.addEventListener("keydown", (e) => {
    if (!state.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });

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
