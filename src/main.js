import { Viewer } from "./viewer/viewer.js";
import { loadModel, SUPPORTED } from "./viewer/loaders.js";
import { ChannelView, CHANNELS } from "./viewer/channels.js";
import { applyFoundTextures } from "./viewer/textures.js";
import { normalizeMaterials, fixColorSpaces, ensureAoUv } from "./viewer/materials.js";
import { Navigation, ACTIONS } from "./viewer/navigation.js";
import { wireHud, wireTimeline, showDevice } from "./ui/controls.js";

const $ = (id) => document.getElementById(id);
const app = $("app");
const viewer = new Viewer($("view"));
const channels = new ChannelView(viewer);

// The HUD needs the navigation and the navigation fires HUD actions, so the
// handlers are filled in once both exist.
const actions = {};
const nav = new Navigation(viewer, {
  onAction: (a) => actions[a]?.(),
  onDevice: showDevice,
});

viewer.onFrame = (dt) => {
  nav.update(dt);
  if (viewer.playing) timelinePaint();
};
let timelinePaint = () => {};

let tauri = null;
// The packages import fine in a plain browser; what tells the shell apart is
// the injected runtime, not the module resolution.
if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
  const core = await import("@tauri-apps/api/core");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const event = await import("@tauri-apps/api/event");
  tauri = { core, dialog, event };
}

const setBusy = (on) => {
  $("loading").hidden = !on;
};

/**
 * Turn a path relative to the model into an asset URL.
 *
 * The asset protocol collapses a path into one URL segment, so loaders cannot
 * resolve siblings on their own; they are given the real folder instead.
 */
function siblingResolver(modelPath) {
  const cut = Math.max(modelPath.lastIndexOf("\\"), modelPath.lastIndexOf("/"));
  const dir = modelPath.slice(0, cut);
  const unc = dir.startsWith("\\\\");
  return (relative) => {
    const parts = dir.split(/[\\/]/).filter(Boolean);
    for (const segment of relative.split(/[\\/]/)) {
      if (!segment || segment === ".") continue;
      if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    return tauri.core.convertFileSrc((unc ? "\\\\" : "") + parts.join("\\"));
  };
}

async function open(url, label, { findTextures, resolveSibling } = {}) {
  setBusy(true);
  try {
    const { object, animations, info } = await loadModel(url, {
      renderer: viewer.renderer,
      findTextures,
      resolveSibling,
    });
    // Phong/Lambert under an IBL turns into a white veil: unify on PBR first
    normalizeMaterials(object);
    fixColorSpaces(object);
    ensureAoUv(object);
    const stats = viewer.setModel(object, animations);
    nav.calibrate(viewer.boxHelper.box);
    channels.reset();
    channels.setWireframe($("opt-wireframe").checked);
    applyChannel(currentChannel);
    $("opt-skeleton").checked = viewer.skeletons.visible;

    setTitle(label);
    showStats(stats);
    $("tree").textContent = viewer.sceneTree();
    paintMaterialList();
    $("empty").classList.add("hidden");
    buildAnimationUi(animations);
    if (info?.warnings?.length) console.warn("[albedo]", info.warnings);
  } catch (e) {
    console.error(e);
    setTitle(`Échec : ${e.message || e}`, true);
  } finally {
    setBusy(false);
  }
}

function setTitle(label, idle = false) {
  const el = $("file-name");
  el.textContent = label;
  el.title = label;
  el.classList.toggle("idle", idle);
  const kind = /\.([a-z0-9]+)$/i.exec(label);
  const badge = $("file-kind");
  badge.hidden = !kind;
  if (kind) badge.textContent = kind[1];
}

function showStats(stats, extra) {
  $("stats").textContent =
    `${stats.triangles.toLocaleString("fr-FR")} tri · ${stats.meshes} mesh · ` +
    `${stats.materials} mat · ${stats.textures} tex${extra ? ` · ${extra}` : ""}`;
}

/** Open a path coming from the OS (dialog, "Open with", drag & drop). */
async function openPath(path) {
  if (!tauri) return;
  const url = tauri.core.convertFileSrc(path);
  const name = path.split(/[\\/]/).pop();
  // A NIF names its maps, so it asks for them by name instead of being handed
  // a folder listing to guess from.
  const findTextures = async (names) => {
    const found = await tauri.core.invoke("find_textures", { modelPath: path, names });
    return (found || []).map((f) => ({ name: f.name, url: tauri.core.convertFileSrc(f.path) }));
  };
  await open(url, name, { findTextures, resolveSibling: siblingResolver(path) });
  await rescueTextures(path, name);
}

/**
 * Formats that embed everything need no help; the others often reference maps
 * by a path that only existed on the author's machine.
 */
const LOOSE_TEXTURE_FORMATS = /\.(obj|fbx|dae|3mf|stl|ply|gltf)$/i;

async function rescueTextures(path, name) {
  if (!tauri || !viewer.current || !LOOSE_TEXTURE_FORMATS.test(name)) return;
  try {
    const found = await tauri.core.invoke("scan_textures", { modelPath: path });
    if (!found || !found.length) return;
    const candidates = found.map((f) => ({
      name: f.name,
      url: tauri.core.convertFileSrc(f.path),
    }));
    const { applied, roles } = await applyFoundTextures(viewer.current, candidates, name);
    if (!applied) return;
    ensureAoUv(viewer.current);
    viewer.invalidate();
    showStats(viewer.stats(), `${applied} texture(s) retrouvée(s) : ${roles.join(", ")}`);
    if (currentChannel !== "shaded") applyChannel(currentChannel);
  } catch (e) {
    console.warn("[albedo] recherche de textures:", e);
  }
}

// --- channels -------------------------------------------------------------

let currentChannel = "shaded";
function applyChannel(id) {
  currentChannel = id;
  channels.apply(id);
  for (const b of $("channels").children) b.classList.toggle("active", b.dataset.id === id);
  // The viewport toggle and the inspector list are two views of one state.
  $("mode-pbr").classList.toggle("active", id === "shaded");
  $("mode-unlit").classList.toggle("active", id === "unlit");
}

$("mode-pbr").addEventListener("click", () => setRenderMode("shaded"));
$("mode-unlit").addEventListener("click", () => setRenderMode("unlit"));
const toggleUnlit = () => setRenderMode(currentChannel === "unlit" ? "shaded" : "unlit");

/**
 * The viewport toggle sets the default for the whole model and clears the per
 * material choices, which is what someone expects from a master switch.
 */
function setRenderMode(mode) {
  channels.materialModes.clear();
  applyChannel(mode);
  paintMaterialList();
}

/**
 * One row per material, so a painted body and glossy eyes can be shown the way
 * each was authored.
 */
function paintMaterialList() {
  const holder = $("materials");
  const list = viewer.current ? channels.materials() : [];
  $("materials-section").hidden = list.length === 0;
  holder.textContent = "";

  for (const { uuid, name, textured } of list) {
    const row = document.createElement("div");
    row.className = "mat-row";

    const label = document.createElement("span");
    label.className = "mat-name";
    label.textContent = name;
    label.title = textured ? `${name} (texturé)` : name;

    const group = document.createElement("div");
    group.className = "segment";
    for (const [mode, text] of [["shaded", "PBR"], ["unlit", "Unlit"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg";
      b.textContent = text;
      const active = channels.channelFor({ uuid }, currentChannel === "unlit" ? "unlit" : "shaded");
      b.classList.toggle("active", active === mode);
      b.addEventListener("click", () => {
        channels.setMaterialMode(uuid, mode);
        paintMaterialList();
      });
      group.appendChild(b);
    }

    row.append(label, group);
    holder.appendChild(row);
  }
}

function stepChannel(delta) {
  const i = CHANNELS.findIndex((c) => c.id === currentChannel);
  const next = (i + delta + CHANNELS.length) % CHANNELS.length;
  applyChannel(CHANNELS[next].id);
}

for (const c of CHANNELS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = c.label;
  b.dataset.id = c.id;
  b.addEventListener("click", () => applyChannel(c.id));
  $("channels").appendChild(b);
}
applyChannel("shaded");

// --- display toggles ------------------------------------------------------

$("opt-wireframe").addEventListener("change", (e) => channels.setWireframe(e.target.checked));
$("opt-grid").addEventListener("change", (e) => viewer.setGrid(e.target.checked));
$("opt-bounds").addEventListener("change", (e) => viewer.setBounds(e.target.checked));
$("opt-skeleton").addEventListener("change", (e) => viewer.setSkeleton(e.target.checked));
$("opt-exposure").addEventListener("input", (e) => viewer.setExposure(Number(e.target.value)));

// --- animations -----------------------------------------------------------

const timeline = wireTimeline({ viewer });

function buildAnimationUi(clips) {
  const select = $("anim-select");
  select.textContent = "";
  viewer.playing = false;

  // Some formats carry a bind pose as a clip with no duration; that is not
  // something to play, so it must not put a scrubber on screen.
  const playable = clips
    .map((c, i) => ({ clip: c, index: i }))
    .filter(({ clip }) => clip.duration > 0);

  if (!playable.length) {
    timeline.attach(null, 0);
    return;
  }
  // The picker only earns its place when there is something to pick.
  select.hidden = playable.length < 2;
  for (const { clip, index } of playable) {
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = clip.name || `clip ${index + 1}`;
    select.appendChild(opt);
  }
  selectClip(playable[0].index);
}

function selectClip(index) {
  const clip = viewer.clips[index];
  if (!clip || !viewer.mixer) return;
  viewer.mixer.stopAllAction();
  const action = viewer.mixer.clipAction(clip);
  action.play();
  action.paused = true;
  viewer.playing = false;
  viewer.mixer.setTime(0);
  timeline.attach(action, clip.duration);
  viewer.invalidate();
}

$("anim-select").addEventListener("change", (e) => selectClip(Number(e.target.value)));

// --- opening --------------------------------------------------------------

$("btn-open").addEventListener("click", async () => {
  if (tauri) {
    const picked = await tauri.dialog.open({
      multiple: false,
      filters: [{ name: "Modèles 3D", extensions: SUPPORTED }],
    });
    if (picked) openPath(picked);
    return;
  }
  browserPicker.click();
});

// --- browser fallback -----------------------------------------------------
// Running `npm run dev` alone (no Tauri shell) stays useful for UI work.
const browserPicker = document.createElement("input");
browserPicker.type = "file";
browserPicker.accept = SUPPORTED.map((e) => `.${e}`).join(",");
browserPicker.addEventListener("change", () => {
  const f = browserPicker.files && browserPicker.files[0];
  if (f) open(URL.createObjectURL(f) + "#." + f.name.split(".").pop(), f.name);
});

// DOM-level drag & drop is registered in both modes: without a dragover that
// calls preventDefault the webview shows a "forbidden" cursor, even when Tauri
// is the one that will actually deliver the drop.
for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    app.classList.add("dragover");
  });
}
for (const type of ["dragleave", "dragend"]) {
  window.addEventListener(type, () => app.classList.remove("dragover"));
}
window.addEventListener("drop", (e) => {
  e.preventDefault();
  app.classList.remove("dragover");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  // In the shell the payload arrives through onDragDropEvent with a real path;
  // this branch only fires when the webview handled the drop itself.
  if (f) open(URL.createObjectURL(f) + "#." + f.name.split(".").pop(), f.name);
});

if (tauri) {
  const win = await import("@tauri-apps/api/webviewWindow");
  const current = win.getCurrentWebviewWindow();
  current.onDragDropEvent((e) => {
    if (e.payload.type === "over") app.classList.add("dragover");
    else if (e.payload.type === "drop") {
      app.classList.remove("dragover");
      const p = e.payload.paths && e.payload.paths[0];
      if (p) openPath(p);
    } else app.classList.remove("dragover");
  });

  // A file passed on the command line ("Open with…")
  const startup = await tauri.core.invoke("startup_file").catch(() => null);
  if (startup) openPath(startup);
  tauri.event.listen("open-file", (e) => e.payload && openPath(e.payload));
}

// Dev hook: drive the app from the console while building the UI
if (import.meta.env && import.meta.env.DEV) {
  window.__albedo = { viewer, channels, nav, open, applyChannel };
}

// --- HUD, shortcuts -------------------------------------------------------

const hud = wireHud({
  viewer,
  nav,
  tauri,
  onNotice: (msg) => {
    $("stats").title = msg || "";
    if (msg) console.info("[albedo]", msg);
  },
});
timelinePaint = () => {
  if (!timeline.scrubbing) timeline.paint();
};

Object.assign(actions, {
  [ACTIONS.FRAME]: () => viewer.frameCurrent(),
  [ACTIONS.TOGGLE_MODE]: () => hud.toggleMode(),
  [ACTIONS.PLAY_PAUSE]: () => timeline.toggle(),
  [ACTIONS.NEXT_CHANNEL]: () => stepChannel(1),
  [ACTIONS.PREV_CHANNEL]: () => stepChannel(-1),
  [ACTIONS.RESET_ROLL]: () => nav.resetRoll(),
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
  switch (e.code) {
    case "Space":
      // in fly mode the space bar lifts the camera instead
      if (nav.mode === "fly") return;
      e.preventDefault();
      timeline.toggle();
      break;
    case "Tab":
      e.preventDefault();
      hud.toggleInspector();
      break;
    case "KeyH":
      // show nothing but the model
      document.body.classList.toggle("clean");
      break;
    case "KeyF":
      if (e.ctrlKey || e.altKey) return;
      e.preventDefault();
      viewer.frameCurrent();
      break;
    case "F11":
      e.preventDefault();
      hud.toggleFullscreen();
      break;
    case "Digit1": applyChannel("shaded"); break;
    case "Digit2": applyChannel("albedo"); break;
    case "Digit3": applyChannel("normalMap"); break;
    case "Digit4": applyChannel("roughness"); break;
    case "Digit5": applyChannel("uv"); break;
    case "KeyO": hud.setMode("orbit"); break;
    case "KeyV": hud.setMode("fly"); break;
    case "KeyU": toggleUnlit(); break;
    case "KeyR": nav.resetRoll(); break;
    case "KeyW":
      if (!e.ctrlKey && nav.mode === "orbit") {
        $("opt-wireframe").checked = !$("opt-wireframe").checked;
        channels.setWireframe($("opt-wireframe").checked);
      }
      break;
    default:
      break;
  }
});
