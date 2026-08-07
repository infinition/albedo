import { Viewer, shiftHue } from "./viewer/viewer.js";
import { loadModel, SUPPORTED } from "./viewer/loaders.js";
import { ChannelView, CHANNELS } from "./viewer/channels.js";
import { applyFoundTextures } from "./viewer/textures.js";
import {
  normalizeMaterials,
  fixColorSpaces,
  ensureAoUv,
  ignoreDeadVertexColors,
  resolveTransparency,
  replaceMap,
  toPhysical,
  applyPreset,
  MAP_SLOTS,
} from "./viewer/materials.js";
import { createPrefs } from "./prefs.js";
import { Navigation, ACTIONS } from "./viewer/navigation.js";
import { wireHud, wireTimeline, showDevice } from "./ui/controls.js";

const $ = (id) => document.getElementById(id);
const app = $("app");

// Declared here rather than beside the edit mode they belong to, and this is
// not tidiness. A file passed on the command line is opened while this module
// is still being evaluated, and opening clears the edit mode: reading a `let`
// from above its own declaration is a ReferenceError, not an undefined, so
// double clicking a model in Explorer failed before the loader was ever
// reached. See the edit mode section for what they mean.
/** @type {"translate"|"rotate"|"scale"|null} */
let editMode = null;
/** @type {{object: any, name: string}|null} */
let selectedPart = null;
/** The formats Albedo can write, so the only ones it may offer to replace. */
const WRITABLE = /\.(glb|gltf)$/i;

/**
 * Say what just changed, once, and get out of the way.
 *
 * Half of what the keyboard does happens off screen: the grid goes, the lens
 * narrows, the interface hides, and the only evidence is the picture itself,
 * which is exactly what you were looking at instead of the controls. A call
 * while one is already up replaces it and restarts the clock, so dragging the
 * lens reads as one number counting rather than a queue of messages.
 */
let toastTimer = null;
function toast(text, ms = 1100) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), ms);
}

/**
 * Every slider says what it is set to.
 *
 * Attached rather than written into the markup: thirty six sliders is thirty
 * six chances to forget one, and the next one added would start out silent.
 * The number of decimals comes from the step, so a slider that moves in whole
 * degrees never shows a fraction and one that moves in thousandths never hides
 * what it did.
 */
function decimalsOf(step) {
  const s = String(step ?? "");
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

function wireSliderValues(scope) {
  for (const input of scope.querySelectorAll('input[type="range"]')) {
    if (input.dataset.novalue !== undefined) continue;
    const label = input.closest("label");
    // A dozen sliders state their value already, in their own units and from
    // wherever the value actually changes, a lens drag included. Those keep it.
    if (!label || label.querySelector(".mono")) continue;
    const out = document.createElement("span");
    out.className = "slider-value";
    label.appendChild(out);
    input._readout = out;
    input.addEventListener("input", () => showSliderValue(input));
    showSliderValue(input);
  }
}

function showSliderValue(input) {
  const out = input._readout;
  if (!out) return;
  const n = Number(input.value);
  out.textContent = `${n.toFixed(decimalsOf(input.step))}${input.dataset.unit || ""}`;
}

/** After anything sets values behind the sliders' backs, prefs above all. */
function refreshSliderValues() {
  for (const input of $("inspector").querySelectorAll('input[type="range"]')) showSliderValue(input);
}

const labelOfChannel = (id) => CHANNELS.find((c) => c.id === id)?.label || id;
const viewer = new Viewer($("view"));
const channels = new ChannelView(viewer);

// The HUD needs the navigation and the navigation fires HUD actions, so the
// handlers are filled in once both exist.
const actions = {};
const nav = new Navigation(viewer, {
  onAction: (a) => actions[a]?.(),
  onDevice: showDevice,
  // The lens can be dragged as well as slid, and the panel must agree
  onFov: (fov) => {
    $("opt-fov").value = String(Math.round(fov));
    $("fov-value").textContent = `${Math.round(fov)}°`;
    // The panel is usually shut while the lens is being dragged, and the drag
    // is the one gesture where the number is the whole point.
    toast(`Champ ${Math.round(fov)}°`);
    prefs.set("fov", Math.round(fov));
  },
  // Shift and drag turns the environment when the environment is the light
  onEnvRotate: (deg) => {
    $("env-rotation").value = String(deg);
    $("rot-value").textContent = `${deg}°`;
    toast(`Environnement ${deg}°`);
    prefs.set("environmentRotation", deg);
  },
});

viewer.onFrame = (dt) => {
  nav.update(dt);
  if (viewer.playing) timelinePaint();
  watchShotFraming();
  // Read after the controls have run, not on the wheel event: damping spreads
  // one notch over several frames, so the number on the event is not yet true.
  if (performance.now() < zoomAnnounceUntil) {
    const percent = viewer.zoomPercent();
    if (percent !== null) toast(`Zoom ${percent} %`);
  }
};

/**
 * The wheel is unambiguously a zoom, which is why it is the hook rather than
 * the controls' change event: that one also fires for every orbit and every
 * pan, and a number that appears whenever the camera moves is noise.
 */
let zoomAnnounceUntil = 0;
$("view").addEventListener(
  "wheel",
  () => {
    if (nav.mode !== "orbit") return;
    zoomAnnounceUntil = performance.now() + 600;
  },
  { passive: true }
);
let timelinePaint = () => {};

let tauri = null;
// The packages import fine in a plain browser; what tells the shell apart is
// the injected runtime, not the module resolution.
if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
  const core = await import("@tauri-apps/api/core");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const event = await import("@tauri-apps/api/event");
  tauri = { core, dialog, event };

  // Free look without the webview's capture, and so without its banner: the
  // shell holds the cursor at the window level and puts it back in the middle
  // before it can reach an edge.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  nav.pointer = {
    grab: (on) => win.setCursorGrab(on).catch(() => {}),
    show: (on) => win.setCursorVisible(on).catch(() => {}),
    async recenter() {
      try {
        const pos = await win.outerPosition();
        const size = await win.innerSize();
        await win.setCursorPosition(
          new PhysicalPosition(
            pos.x + Math.round(size.width / 2),
            pos.y + Math.round(size.height / 2)
          )
        );
      } catch (_) {
        /* a window that moved out from under us is not worth a message */
      }
    },
  };
}

const prefs = await createPrefs(tauri);
/** True when this process exists only to draw one thumbnail and stop. */
let headless = false;

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
  // Cleared here and set again by openPath once the load succeeded, so a model
  // dropped in from a browser picker can never be mistaken for a file on disk
  // and offered up for overwriting.
  openedPath = null;
  selectedPart = null;
  setEditMode(null);
  try {
    const { object, animations, info } = await loadModel(url, {
      renderer: viewer.renderer,
      findTextures,
      resolveSibling,
    });
    // Phong/Lambert under an IBL turns into a white veil: unify on PBR first
    normalizeMaterials(object);
    fixColorSpaces(object);
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    const stats = viewer.setModel(object, animations, label || "");
    nav.calibrate(viewer.boxHelper.box);
    channels.reset();
    selectedMaterial = null;
    channels.setWireframe($("opt-wireframe").checked);
    applyChannel(currentChannel);
    $("opt-skeleton").checked = viewer.skeletons.visible;

    // Once the maps are in, blending that the file asked for and the picture
    // does not want can be settled. Not awaited: the model is on screen and
    // this only ever makes it more correct.
    texturesSettled(4000).then(() => {
      if (!viewer.current) return;
      const fixed = resolveTransparency(viewer.current);
      if (fixed.opaque || fixed.cutout) {
        viewer.invalidate();
        console.info(`[albedo] transparence corrigee : ${fixed.opaque} opaque, ${fixed.cutout} en seuil`);
      }
    });

    setTitle(label);
    showStats(stats);
    showDimensions();
    paintOrientation();
    paintParts();
    paintSaveButtons();
    $("btn-export").disabled = false;
    $("btn-snapshot").disabled = false;
    paintShotPreview();
    // The cut is expressed against the model's own extent, so a new one has to
    // recompute where the plane actually falls.
    viewer.setClipping({});
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

/**
 * How big the thing actually is.
 *
 * A viewer that never says a size leaves the user guessing whether a model
 * arrived in metres, centimetres or inches, which is the first thing that goes
 * wrong when a file moves between packages.
 */
function showDimensions() {
  const box = viewer.boxHelper.box;
  if (!viewer.current || box.isEmpty()) {
    $("dimensions").textContent = "—";
    return;
  }
  const n = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(3));
  const x = box.max.x - box.min.x;
  const y = box.max.y - box.min.y;
  const z = box.max.z - box.min.z;
  $("dimensions").textContent = `${n(x)} × ${n(y)} × ${n(z)} unités`;
}

function showStats(stats, extra) {
  const n = (v) => v.toLocaleString("fr-FR");
  const parts = [];
  // A point cloud carries points, not triangles; saying "0 tri" about one
  // describes nothing.
  if (stats.triangles || !stats.points) parts.push(`${n(stats.triangles)} tri`, `${stats.meshes} mesh`);
  if (stats.points) parts.push(`${n(stats.points)} pts`);
  parts.push(`${stats.materials} mat`, `${stats.textures} tex`);
  if (extra) parts.push(extra);
  $("stats").textContent = parts.join(" · ");
}

/** Open a path coming from the OS (dialog, "Open with", drag & drop). */
/** The file on disk the viewport is showing, when there is one. */
let openedPath = null;

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
  openedPath = path;
  paintSaveButtons();
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

// --- headless thumbnail ---------------------------------------------------

/**
 * Wait for the maps to be decoded.
 *
 * A texture is bound the moment it starts loading, so rendering right away
 * would catch a model with black skin. There is no frame loop to wait on in a
 * headless run, hence the poll and the deadline.
 */
async function texturesSettled(deadline = 8000) {
  const maps = [];
  viewer.current?.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) maps.push(v);
      }
    }
  });
  const start = performance.now();
  while (performance.now() - start < deadline) {
    const ready = maps.every(
      (t) => t.image && (t.image.width || t.image.data || t.mipmaps?.length)
    );
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

/**
 * One model in, one PNG out, then the process ends.
 *
 * This goes through the ordinary open path on purpose: texture discovery,
 * material normalisation and framing are what make a thumbnail look like the
 * model rather than like a grey blob.
 */
async function renderThumbnail({ path, size }) {
  try {
    await openPath(path);
    if (!viewer.current) throw new Error("modèle illisible");
    await texturesSettled();
    const data = viewer.snapshot(size, { transparent: true });
    await tauri.core.invoke("write_thumbnail", { data });
  } catch (e) {
    await tauri.core.invoke("thumbnail_failed", { message: String(e?.message || e) });
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

/** Which material the inspector has open, by uuid. */
let selectedMaterial = null;

/**
 * Choose a material, from the panel or from the model.
 *
 * Both routes end here so the two can never disagree about what is selected:
 * clicking a surface ticks its row, and clicking its row rings the surface.
 * @param {string|null} uuid
 */
function selectMaterial(uuid) {
  const next = uuid && uuid !== selectedMaterial ? uuid : null;
  if (next === selectedMaterial) return;
  selectedMaterial = next;
  paintMaterialList();
  // With the handles out, picking is aiming them rather than asking about
  // matter, so the pane stays put and the gizmo moves to what was just chosen.
  if (editMode) {
    setEditMode(editMode);
    return;
  }
  // Picking a surface is a question about its matter, so show the answer
  if (next) showPane("matter");
}

function highlightSelection() {
  if (!selectedMaterial || !viewer.current) {
    viewer.highlight(null);
    return;
  }
  viewer.highlight(channels.usersOf(selectedMaterial).meshes);
}

/** Ask for an image file, through the shell when there is one. */
async function pickImage() {
  if (tauri) {
    const picked = await tauri.dialog.open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tga"] }],
    });
    if (!picked) return null;
    return { url: tauri.core.convertFileSrc(picked), name: picked.split(/[\\/]/).pop() };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.tga";
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      resolve(f ? { url: URL.createObjectURL(f), name: f.name } : null);
    });
    input.click();
  });
}

const textureLabel = (tex) => {
  if (!tex) return "aucune";
  if (tex.name) return tex.name;
  const src = (tex.image && tex.image.src) || "";
  // Packaged formats hand over their images with no name and a blob URL
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return "(intégrée)";
  try {
    return decodeURIComponent(src.split(/[?#]/)[0].split("/").pop());
  } catch (_) {
    return "(image)";
  }
};

const textureSize = (tex) =>
  tex && tex.image && tex.image.width ? `${tex.image.width}×${tex.image.height}` : "—";

/** Where the picture came from, in full, for the tooltip. */
const textureSource = (tex) => {
  const src = (tex?.image && tex.image.src) || tex?.userData?.src || "";
  // A packaged format hands over a decoded bitmap with no address of any kind,
  // which says something true: the picture came from inside the file.
  if (!src) return tex?.image ? "intégrée au fichier" : "source inconnue";
  if (src.startsWith("blob:") || src.startsWith("data:")) return "intégrée au fichier";
  try {
    return decodeURIComponent(src.replace(/^https?:\/\/asset\.localhost\//i, ""));
  } catch (_) {
    return src;
  }
};

/**
 * A stamp of the texture itself.
 *
 * A name and a size do not tell you whether the roughness map is the one you
 * think. Compressed formats hold no drawable image, so they simply have no
 * stamp rather than a wrong one.
 */
function texturePreview(tex) {
  const image = tex?.image;
  if (!image) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 36;
    canvas.height = 36;
    canvas.getContext("2d").drawImage(image, 0, 0, 36, 36);
    return canvas.toDataURL("image/png");
  } catch (_) {
    return null;
  }
}

/** Take one map out of the render, and put it back. */
function toggleMap(material, slot) {
  material.userData.hiddenMaps ||= {};
  const parked = material.userData.hiddenMaps;
  if (parked[slot]) {
    material[slot] = parked[slot];
    delete parked[slot];
  } else {
    parked[slot] = material[slot];
    material[slot] = null;
  }
  material.needsUpdate = true;
  channels.refresh();
}

async function swapTexture(uuid, slot) {
  const picked = await pickImage();
  if (!picked) return;
  const { material } = channels.usersOf(uuid);
  if (!material) return;
  try {
    await replaceMap(material, slot, picked.url, picked.name);
    // The channel views hold copies built from the old material
    channels.refresh();
    showStats(viewer.stats());
    paintMaterialList();
  } catch (e) {
    $("stats").title = `Texture illisible : ${picked.name}`;
    console.warn("[albedo] remplacement de texture:", e);
  }
}

/** The maps a material carries, and a way to put another one in their place. */
function textureBlock(uuid) {
  const { material } = channels.usersOf(uuid);
  const box = document.createElement("div");
  box.className = "maps";
  if (!material) return box;

  const parked = material.userData.hiddenMaps || {};
  const present = MAP_SLOTS.filter(([slot]) => material[slot] || parked[slot]);
  // With no map at all the albedo slot is still offered: trying one out is the
  // fastest way to tell a missing texture from a black one.
  const slots = present.length ? present : [["map", "Albedo"]];

  for (const [slot, label] of slots) {
    const hidden = !!parked[slot];
    const tex = material[slot] || parked[slot];
    const row = document.createElement("div");
    row.className = "map-row" + (hidden ? " muted" : "");

    const stamp = document.createElement("span");
    stamp.className = "map-stamp";
    const preview = texturePreview(tex);
    if (preview) {
      const img = document.createElement("img");
      img.src = preview;
      img.alt = "";
      stamp.appendChild(img);
    }

    const names = document.createElement("span");
    names.className = "map-names";
    const role = document.createElement("span");
    role.className = "map-role";
    role.textContent = label;
    const name = document.createElement("span");
    name.className = "map-name";
    name.textContent = textureLabel(tex);
    const source = textureSource(tex);
    name.title = `${textureLabel(tex)}\n${source}`;
    const where = document.createElement("span");
    where.className = "map-source";
    where.textContent = source;
    where.title = source;
    names.append(role, name, where);

    const size = document.createElement("span");
    size.className = "map-size mono";
    size.textContent = textureSize(tex);

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "seg eye" + (hidden ? "" : " active");
    eye.title = hidden ? "Remettre dans le rendu" : "Retirer du rendu";
    eye.innerHTML = hidden
      ? '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.4 5.3A9.8 9.8 0 0112 5c5 0 9 4.5 9 7a12 12 0 01-2.4 3.3M6.3 6.9A12.6 12.6 0 003 12c0 2.5 4 7 9 7 1.2 0 2.3-.2 3.3-.7"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="2.6"/></svg>';
    eye.disabled = !tex;
    eye.addEventListener("click", () => {
      toggleMap(material, slot);
      paintMaterialList();
    });

    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "seg";
    swap.textContent = tex ? "Remplacer" : "Choisir";
    swap.addEventListener("click", () => swapTexture(uuid, slot));

    row.append(stamp, names, size, eye, swap);
    box.appendChild(row);
  }

  const slider = (label, value, min, max, step, apply) => {
    const field = document.createElement("label");
    field.className = "field";
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", () => {
      apply(Number(input.value));
      material.needsUpdate = true;
      channels.refresh();
    });
    field.append(name, input);
    box.appendChild(field);
  };

  // Only the settings this material actually has: an occlusion strength means
  // nothing without an occlusion map.
  if (material.aoMap) {
    slider("Intensité AO", material.aoMapIntensity ?? 1, 0, 2, 0.05, (v) => {
      material.aoMapIntensity = v;
    });
  }

  if (material.isMeshPhysicalMaterial) {
    // Thickness is a distance, so its range follows the model rather than a
    // number that would mean nothing on a teapot and everything on a building.
    const span = viewer.boxHelper.box.isEmpty()
      ? 1
      : viewer.boxHelper.box.max.distanceTo(viewer.boxHelper.box.min);
    slider("Transmission", material.transmission ?? 0, 0, 1, 0.01, (v) => {
      material.transmission = v;
    });
    slider("IOR", material.ior ?? 1.5, 1, 2.5, 0.01, (v) => {
      material.ior = v;
    });
    slider("Épaisseur", material.thickness ?? 0, 0, span / 2, span / 200, (v) => {
      material.thickness = v;
    });
    slider("Rugosité", material.roughness ?? 0.5, 0, 1, 0.01, (v) => {
      material.roughness = v;
    });
  }

  // Presets repair what an exporter lost. They are not a list of material
  // types: the file decides what a thing is, and each of these can be undone.
  const presets = document.createElement("div");
  presets.className = "map-row";
  const label = document.createElement("span");
  label.className = "map-role";
  label.textContent = "Préréglage";
  const group = document.createElement("div");
  group.className = "segment";
  for (const [name, text] of [
    ["verre", "Verre"],
    ["liquide", "Liquide"],
    ["metal", "Métal"],
    ["irise", "Irisé"],
    ["verni", "Verni"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg";
    b.textContent = text;
    b.addEventListener("click", () => {
      const bounds = viewer.boxHelper.box;
      const next = applyPreset(material, name, {
        span: bounds.isEmpty() ? 1 : bounds.max.distanceTo(bounds.min),
      });
      channels.swapMaterial(uuid, next);
      selectedMaterial = next.uuid;
      paintMaterialList();
    });
    group.appendChild(b);
  }
  presets.append(label, group);
  box.appendChild(presets);

  if (channels.isSubstitute(uuid)) {
    const back = document.createElement("div");
    back.className = "map-row";
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "seg";
    revert.textContent = "Rétablir le matériau du fichier";
    revert.addEventListener("click", () => {
      const original = channels.restoreMaterial(uuid);
      if (original) selectedMaterial = original.uuid;
      paintMaterialList();
    });
    back.appendChild(revert);
    box.appendChild(back);
  }
  return box;
}

/**
 * One row per material, so a painted body and glossy eyes can be shown the way
 * each was authored.
 */
function paintMaterialList() {
  const holder = $("materials");
  const list = viewer.current ? channels.materials() : [];
  $("materials-section").hidden = list.length === 0;
  $("matter-empty").hidden = list.length > 0;
  holder.textContent = "";

  for (const { uuid, name, textured, alphaLost, invisible, deadVertexColors, hidden } of list) {
    const row = document.createElement("div");
    row.className = "mat-row";

    // Defects the file declares but cannot deliver, named rather than hidden
    const defect = alphaLost
      ? "transparence déclarée, aucune source d'alpha. La carte a été perdue à l'export ; " +
        "le fichier ne contient plus de quoi la retrouver, donc elle s'affiche pleine. « Masqué » l'écarte."
      : invisible
        ? "opacité nulle : ce matériau ne peut rien dessiner. Volontaire sur une géométrie " +
          "de service, sinon c'est un réglage tombé dans le mauvais champ, ce qui arrive au " +
          "verre réfractif dont l'opacité n'est pas un taux de couverture."
        : deadVertexColors
          ? "couleurs par sommet entièrement nulles, elles auraient multiplié la texture par zéro " +
            "et noirci le maillage. Elles sont ignorées ; le fichier, lui, reste défectueux."
          : null;

    // Clicking the name opens its textures and rings the meshes it covers: a
    // list of names never says which part of the model each one is.
    const label = document.createElement("button");
    label.type = "button";
    label.className = "mat-name";
    label.textContent = defect ? `${name} ⚠` : name;
    label.classList.toggle("warn", !!defect);
    label.classList.toggle("selected", uuid === selectedMaterial);
    label.title = defect ? `${name} : ${defect}` : textured ? `${name} (texturé)` : name;
    label.addEventListener("click", () => selectMaterial(uuid));

    const group = document.createElement("div");
    group.className = "segment";
    for (const [mode, text] of [["shaded", "PBR"], ["unlit", "Unlit"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg";
      b.textContent = text;
      const active = channels.channelFor({ uuid }, currentChannel === "unlit" ? "unlit" : "shaded");
      b.classList.toggle("active", !hidden && active === mode);
      b.addEventListener("click", () => {
        channels.setMaterialHidden(uuid, false);
        channels.setMaterialMode(uuid, mode);
        paintMaterialList();
      });
      group.appendChild(b);
    }
    // Nothing here repairs a broken material, but a slab across a face can at
    // least be taken out of the way while the rest is inspected.
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "seg";
    hide.textContent = "Masqué";
    hide.title = "Retirer ce matériau de la vue";
    hide.classList.toggle("active", hidden);
    hide.addEventListener("click", () => {
      channels.setMaterialHidden(uuid, !hidden);
      paintMaterialList();
    });
    group.appendChild(hide);

    row.append(label, group);
    holder.appendChild(row);
    if (uuid === selectedMaterial) holder.appendChild(textureBlock(uuid));
  }
  highlightSelection();
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

// Every display choice is remembered: a viewer that forgets the grid is off
// makes the user turn it off again at each launch.
$("opt-wireframe").addEventListener("change", (e) => {
  channels.setWireframe(e.target.checked);
  prefs.set("wireframe", e.target.checked);
});
$("opt-grid").addEventListener("change", (e) => {
  viewer.setGrid(e.target.checked);
  prefs.set("grid", e.target.checked);
});
$("opt-bounds").addEventListener("change", (e) => {
  viewer.setBounds(e.target.checked);
  prefs.set("bounds", e.target.checked);
});
$("opt-skeleton").addEventListener("change", (e) => {
  viewer.setSkeleton(e.target.checked);
  prefs.set("skeleton", e.target.checked);
});
$("opt-exposure").addEventListener("input", (e) => {
  viewer.setExposure(Number(e.target.value));
  prefs.set("exposure", Number(e.target.value));
});

// --- cross section --------------------------------------------------------

function setClipping(axis, remember = true) {
  viewer.setClipping({ axis: axis || undefined, on: !!axis });
  for (const [id, a] of [["clip-off", null], ["clip-x", "x"], ["clip-y", "y"], ["clip-z", "z"]]) {
    $(id).classList.toggle("active", a === axis);
  }
  if (remember) prefs.set("clipAxis", axis);
}
for (const [id, axis] of [["clip-off", null], ["clip-x", "x"], ["clip-y", "y"], ["clip-z", "z"]]) {
  $(id).addEventListener("click", () => setClipping(axis));
}
$("clip-at").addEventListener("input", (e) => {
  viewer.setClipping({ at: Number(e.target.value) });
  prefs.set("clipAt", Number(e.target.value));
});

// --- export ---------------------------------------------------------------

/**
 * Write the loaded model back out as a binary glTF.
 *
 * The point of reading twenty formats is lost if none of them can leave again:
 * a NIF from 2003 or a binary USD crate becomes a file any modern tool opens.
 * The scene furniture is left out, only what was loaded is written.
 */
async function exportModel({ overwrite = false } = {}) {
  if (!viewer.current) return;
  const note = $("export-note");
  note.textContent = "Export en cours…";
  try {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    // The group, not the object inside it. The orientation buttons and the
    // handles both write to the group, so exporting the object alone wrote out
    // a model still lying on its side after it had been stood up.
    const result = await new GLTFExporter().parseAsync(viewer.root, {
      binary: true,
      animations: viewer.clips || [],
      // Skinned models need their bones, and three drops them otherwise
      includeCustomExtensions: true,
    });
    const bytes = new Uint8Array(result);
    const name = ($("file-name").textContent || "modele").replace(/\.[^.]+$/, "") + ".glb";

    if (tauri) {
      const path = overwrite
        ? openedPath
        : await tauri.dialog.save({
            defaultPath: name,
            filters: [{ name: "glTF binaire", extensions: ["glb"] }],
          });
      if (!path) {
        note.textContent = "";
        return;
      }
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      note.textContent = `Écrit : ${path.split(/[\\/]/).pop()} (${(bytes.length / 1048576).toFixed(1)} Mo)`;
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      note.textContent = `${name} (${(bytes.length / 1048576).toFixed(1)} Mo)`;
    }
  } catch (e) {
    note.textContent = `Export impossible : ${e.message || e}`;
    console.warn("[albedo] export glTF:", e);
  }
}

$("btn-export").addEventListener("click", exportModel);

/**
 * Save the current view as a PNG.
 *
 * The same square render the shell asks for, with a clear background, so a
 * model can be dropped into a document without a screenshot tool and without
 * the overlays that would come with one.
 */
async function saveSnapshot() {
  if (!viewer.current) return;
  const note = $("export-note");
  try {
    const url = viewer.snapshot(1024, { transparent: true });
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const name = ($("file-name").textContent || "albedo").replace(/\.[^.]+$/, "") + ".png";
    if (tauri) {
      const path = await tauri.dialog.save({
        defaultPath: name,
        filters: [{ name: "Image PNG", extensions: ["png"] }],
      });
      if (!path) return;
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      note.textContent = `Écrit : ${path.split(/[\\/]/).pop()}`;
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      note.textContent = name;
    }
  } catch (e) {
    note.textContent = `Image impossible : ${e.message || e}`;
    console.warn("[albedo] image:", e);
  }
}

$("btn-snapshot").addEventListener("click", saveSnapshot);

// --- photo ----------------------------------------------------------------
//
// The thumbnail path re-frames the model into a square, which is right for an
// icon and wrong for a picture: what the user framed is what the file should
// hold. This keeps the camera and only changes the size of the sensor.

const shot = { width: 1920, height: 1080 };
let shotTimer = null;

function shotOptions() {
  return {
    width: shot.width,
    height: shot.height,
    transparent: $("shot-alpha").checked,
    grid: $("shot-grid").checked,
    stand: $("shot-stand").checked,
  };
}

/**
 * Follow the camera while the photo pane is open.
 *
 * The preview is a render, so it is not made on every frame: the debounce means
 * nothing happens while the view is being moved, and one picture is made when
 * it settles. Off the pane, nothing is made at all.
 */
let shotFraming = 0;
function watchShotFraming() {
  const pane = document.querySelector('.pane[data-pane="photo"]');
  if (!pane?.classList.contains("active") || !viewer.current) return;
  const m = viewer.camera.matrixWorld.elements;
  const signature = m[12] + m[13] * 3 + m[14] * 7 + m[0] * 11 + m[5] * 13;
  if (Math.abs(signature - shotFraming) < 1e-6) return;
  shotFraming = signature;
  paintShotPreview();
}

/** A small render of the very same call, so the framing is never a guess. */
function paintShotPreview() {
  clearTimeout(shotTimer);
  shotTimer = setTimeout(() => {
    if (!viewer.current) return;
    const wide = shot.width >= shot.height;
    const preview = { ...shotOptions() };
    const side = 260;
    preview.width = wide ? side : Math.round((side * shot.width) / shot.height);
    preview.height = wide ? Math.round((side * shot.height) / shot.width) : side;
    try {
      $("shot-preview").src = viewer.photo(preview);
    } catch (e) {
      console.warn("[albedo] aperçu photo:", e);
    }
  }, 90);
}

function setShotSize(width, height, remember = true) {
  shot.width = Math.max(64, Math.min(8192, Math.round(width)));
  shot.height = Math.max(64, Math.min(8192, Math.round(height)));
  $("shot-width").value = String(shot.width);
  $("shot-height").value = String(shot.height);
  $("shot-note").textContent = `${shot.width} × ${shot.height}, cadrage de la vue`;
  if (remember) {
    prefs.set("shotWidth", shot.width);
    prefs.set("shotHeight", shot.height);
  }
  paintShotPreview();
}

/** Keep the height and give the picture the asked-for shape. */
function setShotRatio(ratio, id) {
  for (const other of ["shot-view", "shot-11", "shot-169", "shot-43"]) {
    $(other).classList.toggle("active", other === id);
  }
  const box = viewer.renderer.getSize(new (Object.getPrototypeOf(viewer.boxHelper.box.min).constructor)());
  const base = ratio === null ? box.x / box.y : ratio;
  setShotSize(Math.round(shot.height * base), shot.height);
}

$("shot-view").addEventListener("click", () => setShotRatio(null, "shot-view"));
$("shot-11").addEventListener("click", () => setShotRatio(1, "shot-11"));
$("shot-169").addEventListener("click", () => setShotRatio(16 / 9, "shot-169"));
$("shot-43").addEventListener("click", () => setShotRatio(4 / 3, "shot-43"));

for (const [id, times] of [["shot-x1", 1], ["shot-x2", 2], ["shot-x4", 4]]) {
  $(id).addEventListener("click", () => {
    const box = viewer.renderer.getSize(
      new (Object.getPrototypeOf(viewer.boxHelper.box.min).constructor)()
    );
    setShotSize(box.x * times, box.y * times);
  });
}

for (const id of ["shot-width", "shot-height"]) {
  $(id).addEventListener("change", () =>
    setShotSize(Number($("shot-width").value), Number($("shot-height").value))
  );
}
for (const id of ["shot-alpha", "shot-grid", "shot-stand"]) {
  $(id).addEventListener("change", () => {
    prefs.set(
      { "shot-alpha": "shotAlpha", "shot-grid": "shotGrid", "shot-stand": "shotStand" }[id],
      $(id).checked
    );
    paintShotPreview();
  });
}

$("shot-save").addEventListener("click", async () => {
  if (!viewer.current) return;
  const note = $("shot-note");
  try {
    const url = viewer.photo(shotOptions());
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    const name = ($("file-name").textContent || "albedo").replace(/\.[^.]+$/, "") + ".png";
    if (tauri) {
      const path = await tauri.dialog.save({
        defaultPath: name,
        filters: [{ name: "Image PNG", extensions: ["png"] }],
      });
      if (!path) return;
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      note.textContent = `Écrit : ${path.split(/[\\/]/).pop()} (${(bytes.length / 1048576).toFixed(1)} Mo)`;
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      note.textContent = name;
    }
  } catch (e) {
    note.textContent = `Photo impossible : ${e.message || e}`;
    console.warn("[albedo] photo:", e);
  }
});

// --- inspector tabs -------------------------------------------------------

/**
 * One subject at a time.
 *
 * Eight sections stacked in a narrow column meant scrolling past the camera to
 * reach the stand. The panes hold exactly the same controls; only one is on
 * screen, and which one is remembered.
 */
function showPane(name, remember = true) {
  // The preview is a render; it is only worth making while it is on screen
  if (name === "photo") paintShotPreview();
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.pane === name);
  }
  for (const pane of document.querySelectorAll(".pane")) {
    pane.classList.toggle("active", pane.dataset.pane === name);
  }
  if (remember) prefs.set("pane", name);
}
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showPane(tab.dataset.pane));
}

// --- camera ---------------------------------------------------------------

$("opt-fov").addEventListener("input", (e) => {
  const deg = Number(e.target.value);
  viewer.setFov(deg);
  $("fov-value").textContent = `${deg}°`;
  prefs.set("fov", deg);
});

function setProjection(kind, remember = true) {
  viewer.setProjection(kind);
  $("proj-persp").classList.toggle("active", kind === "perspective");
  $("proj-ortho").classList.toggle("active", kind === "orthographic");
  if (remember) prefs.set("projection", kind);
}
$("proj-persp").addEventListener("click", () => setProjection("perspective"));
$("proj-ortho").addEventListener("click", () => setProjection("orthographic"));

// --- environment and stand ------------------------------------------------

async function pickFile(name, extensions) {
  if (tauri) {
    const picked = await tauri.dialog.open({ multiple: false, filters: [{ name, extensions }] });
    return picked || null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = extensions.map((e) => `.${e}`).join(",");
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      resolve(f ? URL.createObjectURL(f) : null);
    });
    input.click();
  });
}

const fileLabel = (path) => (path || "").split(/[\\/]/).pop() || path;

async function useEnvironment(kind, path, remember = true) {
  let source = path;
  if (kind === "image" && !source) {
    source = await pickFile("Panoramas", ["hdr", "exr", "png", "jpg", "jpeg", "webp"]);
    if (!source) return;
  }
  const url = kind === "image" ? (tauri ? tauri.core.convertFileSrc(source) : source) : null;
  const ok = await viewer.setEnvironment(kind, url);
  if (!ok) {
    $("env-file").textContent = "Panorama illisible";
    return;
  }
  for (const [id, k] of [["env-studio", "studio"], ["env-gradient", "gradient"], ["env-image", "image"]]) {
    $(id).classList.toggle("active", k === kind);
  }
  $("env-file").textContent =
    kind === "image" ? fileLabel(source) : kind === "gradient" ? "Dégradé interne" : "Aucun panorama";
  // The stops only mean something while the gradient is what is shown
  $("gradient-editor").hidden = kind !== "gradient";
  // Replacing, removing and framing only exist once there is an image to act on
  $("env-image-tools").hidden = kind !== "image";
  $("env-framing").hidden = kind !== "image";
  // The studio probe is the lighting: asking whether it lights would be odd
  $("env-lighting").closest("label").hidden = kind === "studio";
  if (!remember) return;
  prefs.set("environment", kind);
  // A blob URL from the browser fallback would not survive a restart
  if (kind === "image" && tauri) prefs.set("environmentPath", source);
}

$("env-studio").addEventListener("click", () => useEnvironment("studio"));
$("env-gradient").addEventListener("click", () => useEnvironment("gradient"));
$("env-image").addEventListener("click", () => {
  // Already showing a panorama: the button is how another one is chosen, so it
  // must ask again rather than put the same file back.
  const remembered = viewer.envKind === "image" ? null : prefs.get("environmentPath");
  useEnvironment("image", remembered);
});
$("env-replace").addEventListener("click", () => useEnvironment("image", null));
$("env-clear").addEventListener("click", () => {
  prefs.set("environmentPath", null);
  useEnvironment("studio");
});
$("env-background").addEventListener("change", (e) => {
  viewer.showEnvBackground = e.target.checked;
  viewer.applyBackground();
  prefs.set("environmentBackground", e.target.checked);
});

// --- gradient ---------------------------------------------------------------

/**
 * The backdrop gradient, edited stop by stop.
 *
 * Two colours are the floor: a gradient needs somewhere to go. Positions are
 * kept as written rather than sorted in place, so dragging one past another
 * does not reshuffle the rows under the cursor.
 */
/**
 * Redraw what the stops describe, without touching the controls themselves.
 *
 * Rebuilding the rows on every input event tore the very slider out from under
 * the cursor, which the browser reads as the end of the drag: the value jumped
 * on the first click and would not follow. Only adding or removing a stop
 * changes how many rows there are, so only that rebuilds them.
 */
function refreshGradient(remember = true) {
  const stops = prefs.get("gradientStops");
  const hue = prefs.get("gradientHue");
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  // The very function the texture uses, so the strip cannot promise a colour
  // the background will not show.
  $("gradient-strip").style.background = `linear-gradient(to bottom, ${sorted
    .map((s) => `${shiftHue(s.color, hue)} ${Math.round(s.at * 100)}%`)
    .join(", ")})`;
  $("hue-value").textContent = `${hue}°`;
  viewer.setGradient(stops, hue);
  if (remember) {
    prefs.set("gradientStops", stops);
    prefs.set("gradientHue", hue);
  }
}

function paintGradient(remember = true) {
  const stops = prefs.get("gradientStops");
  const holder = $("gradient-stops");
  holder.textContent = "";

  stops.forEach((stop, index) => {
    const row = document.createElement("div");
    row.className = "map-row";

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.value = stop.color;
    swatch.className = "swatch";
    swatch.addEventListener("input", () => {
      stop.color = swatch.value;
      refreshGradient();
    });

    const at = document.createElement("input");
    at.type = "range";
    at.min = "0";
    at.max = "1";
    at.step = "0.01";
    at.value = String(stop.at);
    // The one slider with nothing to state: where the stop sits is drawn in the
    // strip right above it, at the size of the strip rather than of a number.
    at.dataset.novalue = "";
    at.title = "Position de la couleur dans le dégradé";
    at.addEventListener("input", () => {
      stop.at = Number(at.value);
      refreshGradient();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "seg";
    remove.textContent = "×";
    remove.title = "Retirer cette couleur";
    remove.disabled = stops.length <= 2;
    remove.addEventListener("click", () => {
      stops.splice(index, 1);
      paintGradient();
    });

    row.append(swatch, at, remove);
    holder.appendChild(row);
  });

  refreshGradient(remember);
}

$("gradient-add").addEventListener("click", () => {
  const stops = prefs.get("gradientStops");
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  const last = sorted[sorted.length - 1];
  stops.push({ color: last ? last.color : "#1b1f28", at: 0.5 });
  paintGradient();
});

$("grad-hue").addEventListener("input", (e) => {
  prefs.set("gradientHue", Number(e.target.value));
  refreshGradient();
});

$("bg-brightness").addEventListener("input", (e) => {
  viewer.setBackgroundBrightness(Number(e.target.value));
  prefs.set("backgroundBrightness", Number(e.target.value));
});

// Framing the panorama: how much of it is seen, which way it faces, how sharp
$("env-zoom").addEventListener("input", (e) => {
  const zoom = Number(e.target.value);
  $("zoom-value").textContent = `${zoom.toFixed(1)}×`;
  viewer.setFraming({ zoom });
  prefs.set("environmentZoom", zoom);
});
$("env-rotation").addEventListener("input", (e) => {
  const rotation = Number(e.target.value);
  $("rot-value").textContent = `${rotation}°`;
  viewer.setFraming({ rotation });
  prefs.set("environmentRotation", rotation);
});
$("env-blur").addEventListener("input", (e) => {
  const blur = Number(e.target.value);
  viewer.setFraming({ blur });
  prefs.set("environmentBlur", blur);
});
$("env-lighting").addEventListener("change", (e) => {
  viewer.setEnvironmentLighting(e.target.checked);
  prefs.set("environmentLighting", e.target.checked);
});
$("env-intensity").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  $("env-intensity-value").textContent = value.toFixed(1);
  viewer.setEnvironmentIntensity(value);
  prefs.set("environmentIntensity", value);
});
$("key-light").addEventListener("change", (e) => {
  viewer.setKeyLight(e.target.checked);
  prefs.set("keyLight", e.target.checked);
});
$("key-power").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  $("key-power-value").textContent = value.toFixed(1);
  viewer.setKeyLightPower(value);
  prefs.set("keyLightPower", value);
});
$("key-colour").addEventListener("input", (e) => {
  viewer.setKeyLightColour(e.target.value);
  prefs.set("keyLightColour", e.target.value);
});

// --- the stand --------------------------------------------------------------

function setGizmoMode(mode) {
  for (const [id, m] of [
    ["giz-move", "translate"],
    ["giz-rotate", "rotate"],
    ["giz-scale", "scale"],
    ["giz-off", null],
  ]) {
    $(id).classList.toggle("active", m === mode);
  }
  viewer.setGizmo(mode, (placing) => {
    // A placing chosen by hand replaces the automatic fit, and is remembered
    viewer.pedestalTransform = placing;
    prefs.set("pedestalTransform", placing);
  });
}

for (const [id, mode] of [
  ["giz-move", "translate"],
  ["giz-rotate", "rotate"],
  ["giz-scale", "scale"],
  ["giz-off", null],
]) {
  $(id).addEventListener("click", () => setGizmoMode(mode));
}

function setStandShading(mode, remember = true) {
  viewer.setPedestalShading(mode);
  $("stand-pbr").classList.toggle("active", mode !== "unlit");
  $("stand-unlit").classList.toggle("active", mode === "unlit");
  if (remember) prefs.set("pedestalShading", mode);
}
$("stand-pbr").addEventListener("click", () => setStandShading("shaded"));
$("stand-unlit").addEventListener("click", () => setStandShading("unlit"));

$("pedestal-refit").addEventListener("click", () => {
  prefs.set("pedestalTransform", null);
  viewer.setPedestalTransform(null);
});

async function usePedestal(path, remember = true) {
  try {
    const url = tauri ? tauri.core.convertFileSrc(path) : path;
    const { object } = await loadModel(url, {
      renderer: viewer.renderer,
      resolveSibling: tauri ? siblingResolver(path) : undefined,
    });
    normalizeMaterials(object);
    fixColorSpaces(object);
    viewer.setPedestal(object);
    viewer.setPedestalTransform(prefs.get("pedestalTransform"));
    setStandShading(prefs.get("pedestalShading") || "shaded", false);
    $("pedestal-file").textContent = fileLabel(path);
    $("btn-pedestal").textContent = "Retirer le socle";
    $("pedestal-tools").hidden = false;
    if (remember && tauri) prefs.set("pedestal", path);
  } catch (e) {
    $("pedestal-file").textContent = "Socle illisible";
    console.warn("[albedo] socle:", e);
  }
}

function dropPedestal() {
  viewer.clearPedestal();
  $("pedestal-file").textContent = "Aucun socle";
  $("btn-pedestal").textContent = "Choisir un socle";
  $("pedestal-tools").hidden = true;
  setGizmoMode(null);
  prefs.set("pedestal", null);
  prefs.set("pedestalTransform", null);
}

$("btn-pedestal").addEventListener("click", async () => {
  if (viewer.pedestal) {
    dropPedestal();
    return;
  }
  const picked = await pickFile("Modèles 3D", SUPPORTED);
  if (picked) usePedestal(picked);
});

// --- remembered state -----------------------------------------------------

/**
 * The one look every thumbnail is drawn under.
 *
 * Fixed on purpose, and deliberately not the user's: two people, or the shell
 * and the library, have to get the same picture of the same file, and the cache
 * key has no room to say which look produced it.
 */
function neutralLook() {
  viewer.setExposure(1);
  viewer.setEnvironmentIntensity(1);
  viewer.envLighting = true;
  viewer.setKeyLight(true);
  viewer.setKeyLightPower(1.6);
  viewer.setKeyLightColour("#ffffff");
  viewer.setEnvironment("studio");
  viewer.setClipping({ on: false });
}

/** Put the saved settings back, without writing them out again as we go. */
function applyPrefs() {
  const p = prefs.all();
  showPane(p.pane, false);
  $("shot-alpha").checked = p.shotAlpha;
  $("shot-grid").checked = p.shotGrid;
  $("shot-stand").checked = p.shotStand;
  setShotSize(p.shotWidth, p.shotHeight, false);
  $("clip-at").value = String(p.clipAt);
  viewer.setClipping({ at: p.clipAt });
  setClipping(p.clipAxis, false);
  $("opt-grid").checked = p.grid;
  viewer.setGrid(p.grid);
  $("opt-bounds").checked = p.bounds;
  viewer.setBounds(p.bounds);
  $("opt-skeleton").checked = p.skeleton;
  viewer.setSkeleton(p.skeleton);
  $("opt-wireframe").checked = p.wireframe;
  channels.setWireframe(p.wireframe);
  $("opt-exposure").value = String(p.exposure);
  viewer.setExposure(p.exposure);
  $("opt-fov").value = String(p.fov);
  $("fov-value").textContent = `${p.fov}°`;
  viewer.setFov(p.fov);
  if (p.projection !== "perspective") setProjection(p.projection, false);
  $("env-background").checked = p.environmentBackground;
  viewer.showEnvBackground = p.environmentBackground;
  $("env-lighting").checked = p.environmentLighting;
  viewer.envLighting = p.environmentLighting;
  $("env-intensity").value = String(p.environmentIntensity);
  $("env-intensity-value").textContent = Number(p.environmentIntensity).toFixed(1);
  viewer.setEnvironmentIntensity(p.environmentIntensity);
  $("key-light").checked = p.keyLight;
  viewer.setKeyLight(p.keyLight);
  $("key-power").value = String(p.keyLightPower);
  $("key-power-value").textContent = Number(p.keyLightPower).toFixed(1);
  viewer.setKeyLightPower(p.keyLightPower);
  $("key-colour").value = p.keyLightColour;
  viewer.setKeyLightColour(p.keyLightColour);
  $("grad-hue").value = String(p.gradientHue);
  $("bg-brightness").value = String(p.backgroundBrightness);
  viewer.setBackgroundBrightness(p.backgroundBrightness);
  $("env-zoom").value = String(p.environmentZoom);
  $("zoom-value").textContent = `${Number(p.environmentZoom).toFixed(1)}×`;
  $("env-rotation").value = String(p.environmentRotation);
  $("rot-value").textContent = `${p.environmentRotation}°`;
  $("env-blur").value = String(p.environmentBlur);
  viewer.setFraming({
    zoom: p.environmentZoom,
    rotation: p.environmentRotation,
    blur: p.environmentBlur,
  });
  paintGradient(false);
  if (p.environment !== "studio") useEnvironment(p.environment, p.environmentPath, false);
  else viewer.applyBackground();
  if (p.pedestal) usePedestal(p.pedestal, false);
  // Setting `value` fires no input event, so the readouts would still be
  // showing the markup's defaults and quietly disagreeing with the sliders.
  refreshSliderValues();
}

/** The tuning of a device outlives the session that found it. */
function deviceSnapshot() {
  const s = nav.settings;
  return {
    padSensitivity: s.pad.sensitivity,
    padDeadzone: s.pad.deadzone,
    padInvertY: s.pad.invertY,
    spaceTranslation: s.space.translation,
    spaceRotation: s.space.rotation,
    spaceLockRoll: s.space.lockRoll,
    spaceInvert: { ...s.space.invert },
  };
}

function restoreDevices() {
  const d = prefs.get("devices") || {};
  const s = nav.settings;
  if (d.padSensitivity !== undefined) s.pad.sensitivity = d.padSensitivity;
  if (d.padDeadzone !== undefined) s.pad.deadzone = d.padDeadzone;
  if (d.padInvertY !== undefined) s.pad.invertY = d.padInvertY;
  if (d.spaceTranslation !== undefined) s.space.translation = d.spaceTranslation;
  if (d.spaceRotation !== undefined) s.space.rotation = d.spaceRotation;
  if (d.spaceLockRoll !== undefined) s.space.lockRoll = d.spaceLockRoll;
  if (d.spaceInvert) Object.assign(s.space.invert, d.spaceInvert);
}

const TURNTABLE_SPEED = 0.5; // radians per second, a full turn in about twelve
function toggleTurntable(on) {
  const spinning = on ?? viewer.spin === 0;
  viewer.spin = spinning ? TURNTABLE_SPEED : 0;
  $("btn-turntable").classList.toggle("active", spinning);
  $("btn-turntable").setAttribute("aria-pressed", String(spinning));
  viewer.invalidate();
}
$("btn-turntable").addEventListener("click", () => toggleTurntable());

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

/** Ask for a model, through the shell when there is one. */
async function openFile() {
  if (tauri) {
    const picked = await tauri.dialog.open({
      multiple: false,
      filters: [{ name: "Modèles 3D", extensions: SUPPORTED }],
    });
    if (picked) openPath(picked);
    return;
  }
  browserPicker.click();
}

// Two ways in, and neither may be the only one: the empty state's link goes
// away with the first model, so the chrome carries the same action for good.
$("btn-open").addEventListener("click", openFile);
$("btn-open-file").addEventListener("click", openFile);

// --- browser fallback -----------------------------------------------------
// Running `npm run dev` alone (no Tauri shell) stays useful for UI work.
const browserPicker = document.createElement("input");
browserPicker.type = "file";
browserPicker.accept = SUPPORTED.map((e) => `.${e}`).join(",");
browserPicker.addEventListener("change", () => {
  const f = browserPicker.files && browserPicker.files[0];
  if (f) open(URL.createObjectURL(f) + "#." + f.name.split(".").pop(), f.name);
});

// The webview's own menu has no business here. Reload, print, save image and
// inspect are offers about a web page, and Albedo is not one: half of them do
// nothing useful and the rest are ways to lose what is on screen. The canvas
// was already clear of it, since the orbit controls refuse the event to keep
// right drag for the camera, which is exactly why it only ever showed up over
// the library and the inspector.
//
// Text fields keep theirs. Cut, copy and paste on a search box or a tag field
// is what every native window does, and taking it away would be its own kind of
// wrong. Nothing else on screen is editable.
const TEXT_ENTRY = new Set(["text", "search", "number", "url", "email", "tel", "password"]);
window.addEventListener("contextmenu", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return void e.preventDefault();
  // A slider and a checkbox are inputs too, and neither has anything to paste
  const typed = el instanceof HTMLInputElement && TEXT_ENTRY.has(el.type);
  if (!typed && el.tagName !== "TEXTAREA" && !el.isContentEditable) e.preventDefault();
}, true); // capture: a handler below that stops propagation must not reopen it

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

  // A headless render short circuits everything else: this process exists to
  // produce one image for the shell and then stop.
  const job = await tauri.core.invoke("thumbnail_job").catch(() => null);
  if (job) {
    headless = true;
    renderThumbnail(job);
  } else {
    // A file passed on the command line ("Open with…")
    const startup = await tauri.core.invoke("startup_file").catch(() => null);
    if (startup) openPath(startup);
    tauri.event.listen("open-file", (e) => e.payload && openPath(e.payload));
  }
}

// A thumbnail is a file's identity card, not a picture of one session.
//
// The headless process ran the same startup as the window, so it inherited
// whatever exposure, environment and lighting the user happened to be using:
// pictures came out at one and a half stops over, lit by whichever panorama was
// loaded that day. Worse, the cache key says nothing about any of it, so a
// picture taken under one look was served for ever, and the shell and the
// library, asking at different moments for different sizes, ended up holding
// two different pictures of one file.
if (headless) neutralLook();
else {
  restoreDevices();
  applyPrefs();
}

// Dev hook: drive the app from the console while building the UI
if (import.meta.env && import.meta.env.DEV) {
  window.__albedo = { viewer, channels, nav, open, applyChannel, prefs };
}

// --- HUD, shortcuts -------------------------------------------------------

const hud = wireHud({
  viewer,
  nav,
  tauri,
  onSettings: () => prefs.set("devices", deviceSnapshot()),
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

/**
 * The asset manager, brought in the first time it is asked for.
 *
 * Its module, stylesheet and texture decoders are one lazy chunk, so a viewer
 * that is only ever used to look at one file never pays for any of it.
 */
let library = null;
async function toggleLibrary() {
  if (!library) {
    const { createLibrary } = await import("./library/index.js");
    library = createLibrary({ tauri, prefs, onOpen: (path) => openPath(path) });
    // The preview strip loads into this very viewer, so nothing is duplicated
    library.show();
    return;
  }
  library.toggle();
}
$("btn-library").addEventListener("click", toggleLibrary);


// --- post-processing ------------------------------------------------------

/**
 * The effect chain, brought up the first time one is switched on.
 *
 * Every control writes through to the same place, so restoring a saved set on
 * launch and moving a slider by hand take the identical path. Nothing is loaded
 * until a box is ticked: a viewer showing one untouched model must not pay for
 * a composer it never renders through.
 */
const POST_CONTROLS = [
  ["ao", "on", "ao-on"], ["ao", "radius", "ao-radius"], ["ao", "intensity", "ao-intensity"],
  ["bloom", "on", "bloom-on"], ["bloom", "strength", "bloom-strength"],
  ["bloom", "radius", "bloom-radius"], ["bloom", "threshold", "bloom-threshold"],
  ["dof", "on", "dof-on"], ["dof", "focus", "dof-focus"],
  ["dof", "aperture", "dof-aperture"], ["dof", "maxblur", "dof-maxblur"],
  ["grade", "on", "grade-on"], ["grade", "contrast", "grade-contrast"],
  ["grade", "saturation", "grade-saturation"], ["grade", "temperature", "grade-temperature"],
  ["grade", "vignette", "grade-vignette"], ["grade", "grain", "grade-grain"],
  ["grade", "aberration", "grade-aberration"], ["grade", "sharpen", "grade-sharpen"],
  ["aa", "on", "aa-on"],
];

let postPending = null;
async function setPost(group, key, value) {
  const saved = { ...(prefs.get("post") || {}) };
  saved[group] = { ...(saved[group] || {}), [key]: value };
  prefs.set("post", saved);
  // One chain, even if three sliders move before it has finished loading
  postPending ||= viewer.effects();
  const fx = await postPending;
  fx.set(group, key, value);
  viewer.invalidate();
}

for (const [group, key, id] of POST_CONTROLS) {
  const el = $(id);
  if (!el) continue;
  const isCheck = el.type === "checkbox";
  el.addEventListener(isCheck ? "change" : "input", () =>
    setPost(group, key, isCheck ? el.checked : Number(el.value))
  );
}

// Restore what was left on, and only then: a saved set that is entirely off
// must not drag the chain in at launch.
{
  const saved = prefs.get("post");
  const wanted = saved && Object.values(saved).some((g) => g && g.on);
  for (const [group, key, id] of POST_CONTROLS) {
    const value = saved?.[group]?.[key];
    if (value === undefined || !$(id)) continue;
    if ($(id).type === "checkbox") $(id).checked = !!value;
    else $(id).value = String(value);
  }
  if (wanted) {
    postPending = viewer.effects();
    postPending.then((fx) => {
      fx.apply(saved);
      viewer.invalidate();
    });
  }
}


// --- custom lights --------------------------------------------------------

/**
 * The light rig.
 *
 * A light is placed by bearing and height around the subject rather than by
 * coordinates, so it stays where it was put when the next model is a different
 * size. Selecting one draws its helper, which is the only way to tell where a
 * directional light is coming from without moving it and watching.
 */
let selectedLight = null;

const LIGHT_FIELDS = [
  ["intensity", "light-power", "light-power-value", (v) => v.toFixed(1)],
  ["azimuth", "light-azimuth", "light-azimuth-value", (v) => `${v | 0}°`],
  ["elevation", "light-elevation", "light-elevation-value", (v) => `${v | 0}°`],
  ["distance", "light-distance", "light-distance-value", (v) => `${v.toFixed(1)}×`],
  ["angle", "light-angle", "light-angle-value", (v) => `${v | 0}°`],
  ["penumbra", "light-penumbra", "light-penumbra-value", (v) => v.toFixed(2)],
];

function saveLights() {
  prefs.set("lights", viewer.lightState());
}

function paintLights() {
  const list = $("lights-list");
  list.textContent = "";
  for (const entry of viewer.lights) {
    const row = document.createElement("div");
    row.className = "mat-row";

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = entry.enabled;
    on.title = "Allumer ou éteindre";
    on.addEventListener("change", () => {
      viewer.setLight(entry.id, { enabled: on.checked });
      saveLights();
    });

    const name = document.createElement("button");
    name.type = "button";
    name.className = "mat-name";
    name.style.cursor = "pointer";
    name.textContent = `${entry.name} · ${{ directional: "dir", point: "pt", spot: "proj" }[entry.kind]}`;
    name.addEventListener("click", () => selectLight(entry.id));

    const swatch = document.createElement("span");
    swatch.style.cssText = `width:12px;height:12px;border-radius:3px;background:${entry.colour};border:1px solid var(--line)`;

    row.append(on, name, swatch);
    if (selectedLight === entry.id) row.style.background = "rgba(255,255,255,0.06)";
    list.appendChild(row);
  }
  $("light-editor").hidden = selectedLight === null;
}

function selectLight(id) {
  selectedLight = viewer.lights.some((l) => l.id === id) ? id : null;
  viewer.showLightHelper(selectedLight);
  const entry = viewer.lights.find((l) => l.id === selectedLight);
  if (entry) {
    for (const [key, input, label, format] of LIGHT_FIELDS) {
      $(input).value = String(entry[key]);
      $(label).textContent = format(entry[key]);
    }
    $("light-colour").value = entry.colour;
    $("light-cone").hidden = entry.kind !== "spot";
  }
  paintLights();
}

$("light-add").addEventListener("click", () => {
  const entry = viewer.addLight($("light-kind").value);
  selectLight(entry.id);
  saveLights();
});

$("light-remove").addEventListener("click", () => {
  if (selectedLight === null) return;
  viewer.removeLight(selectedLight);
  selectedLight = null;
  selectLight(null);
  saveLights();
});

for (const [key, input, label, format] of LIGHT_FIELDS) {
  $(input).addEventListener("input", (e) => {
    if (selectedLight === null) return;
    const value = Number(e.target.value);
    $(label).textContent = format(value);
    viewer.setLight(selectedLight, { [key]: value });
    saveLights();
  });
}

$("light-colour").addEventListener("input", (e) => {
  if (selectedLight === null) return;
  viewer.setLight(selectedLight, { colour: e.target.value });
  paintLights();
  saveLights();
});

{
  const saved = prefs.get("lights");
  if (saved?.length) {
    viewer.applyLights(saved);
    paintLights();
  }
}



// --- orientation ----------------------------------------------------------

/**
 * Quarter turns on each axis.
 *
 * A converter that guesses the wrong up axis hands over a model on its side or
 * upside down, and the file itself never says which happened. Six buttons and a
 * reset settle it in one click, which is cheaper than asking anyone to re-export.
 */
function paintOrientation() {
  const o = viewer.orientation();
  const parts = [["X", o.x], ["Y", o.y], ["Z", o.z]].filter(([, v]) => v !== 0);
  $("orient-value").textContent = parts.length
    ? parts.map(([a, v]) => `${a} ${v > 180 ? v - 360 : v}°`).join(" · ")
    : "Aucune rotation";
}

// Named for what they do to the model rather than for the axis they turn it
// about. Nobody looking at a model on its side is thinking in axes; they are
// thinking "tip it forward". The axis stays in the tooltip for anyone who is.
for (const [axis, quarters, label, what] of [
  ["x", 1, "Basculer avant", "Bascule le modèle vers l'avant, quart de tour sur X"],
  ["x", -1, "Basculer arrière", "Bascule le modèle vers l'arrière, quart de tour sur X"],
  ["y", 1, "Pivoter gauche", "Fait pivoter le modèle sur lui-même, quart de tour sur Y"],
  ["y", -1, "Pivoter droite", "Fait pivoter le modèle sur lui-même, quart de tour sur Y"],
  ["z", 1, "Coucher gauche", "Couche le modèle sur le côté, quart de tour sur Z"],
  ["z", -1, "Coucher droite", "Couche le modèle sur le côté, quart de tour sur Z"],
]) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = what;
  b.addEventListener("click", () => {
    viewer.turnModel(axis, quarters);
    paintOrientation();
    showDimensions();
  });
  $("orient-buttons").appendChild(b);
}

$("orient-reset").addEventListener("click", () => {
  viewer.resetOrientation();
  paintOrientation();
  showDimensions();
});

// --- edit mode ------------------------------------------------------------

/**
 * Three handles instead of six axis buttons.
 *
 * The buttons are exact and stay, but they ask the question in the wrong
 * language: someone looking at a model lying on its side is not thinking about
 * which axis to turn about. A gizmo is the answer every modelling tool gives,
 * and the keys are the ones those tools use, so the hands already know them.
 *
 * The keys are modal on purpose. G, R and S mean grid, roll and nothing at all
 * outside this mode, and they mean move, turn and scale inside it. That is how
 * Blender resolves the same collision, and it means no shortcut had to be given
 * up to gain three.
 *
 * `editMode` and `selectedPart` are declared at the top of this file; opening a
 * file clears the edit mode, and opening can happen before this line is reached.
 */

/**
 * What the handles act on.
 *
 * The whole model unless exactly one surface is picked, which is the case that
 * can be answered without inventing anything: attaching to one mesh needs no
 * pivot and no reparenting. A material covering several meshes has no single
 * transform to offer, so that falls back to the model and says so.
 */
function editTarget() {
  if (!viewer.current) return null;
  // A chosen object wins: with several files in the scene, moving one of them
  // is the whole point, and it is a more useful answer than a surface.
  if (selectedPart && viewer.parts.includes(selectedPart)) return selectedPart.object;
  const meshes = selectedMaterial ? channels.usersOf(selectedMaterial).meshes : [];
  return meshes.length === 1 ? meshes[0] : viewer.root;
}

function editTargetName() {
  const target = editTarget();
  if (!target || target === viewer.root) return "la scène entière";
  if (selectedPart && target === selectedPart.object) return selectedPart.name || "l'objet choisi";
  return target.name || "la surface choisie";
}

function paintEditTarget() {
  $("edit-target").textContent = `Cible : ${editTargetName()}`;
}

/**
 * What the scene is made of.
 *
 * Only shown once there is more than one thing in it: a single opened file
 * needs no list to tell it apart from the others.
 */
function paintParts() {
  const list = $("parts-list");
  list.textContent = "";
  if (viewer.parts.length < 2) return;
  for (const entry of viewer.parts) {
    const row = document.createElement("div");
    row.className = "mat-row";

    const name = document.createElement("button");
    name.type = "button";
    name.className = "mat-name" + (selectedPart === entry ? " active" : "");
    name.style.textAlign = "left";
    name.textContent = entry.name || "(sans nom)";
    name.title = "Viser cet objet avec les poignées";
    name.addEventListener("click", () => {
      selectedPart = selectedPart === entry ? null : entry;
      selectMaterial(null);
      paintParts();
      if (editMode) setEditMode(editMode);
      else paintEditTarget();
    });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "seg";
    drop.textContent = "×";
    drop.title = "Retirer de la scène";
    // The first entry is the file that was opened, and removing it would leave
    // a window that says it is showing a file it no longer holds.
    drop.disabled = entry === viewer.parts[0];
    drop.addEventListener("click", () => {
      if (selectedPart === entry) selectedPart = null;
      viewer.removePart(entry);
      channels.reset();
      applyChannel(currentChannel);
      paintParts();
      paintMaterialList();
      showStats(viewer.stats());
      if (editMode) setEditMode(editMode);
      toast(`${entry.name || "Objet"} retiré`);
    });

    row.append(name, drop);
    list.appendChild(row);
  }
}

function setEditMode(mode) {
  if (mode && !viewer.current) return;
  editMode = mode || null;
  const target = editMode ? editTarget() : null;
  viewer.setGizmo(editMode, null, target);
  viewer.setGizmoSnap(false);
  for (const [id, value] of [
    ["edit-off", null], ["edit-translate", "translate"],
    ["edit-rotate", "rotate"], ["edit-scale", "scale"],
  ]) {
    $(id).classList.toggle("active", editMode === value);
  }
  paintEditTarget();
  if (editMode) {
    const label = { translate: "Déplacer", rotate: "Tourner", scale: "Échelle" }[editMode];
    toast(`${label} · ${editTargetName()} · Maj pour les crans`);
  } else {
    paintOrientation();
    showDimensions();
  }
}

for (const [id, mode] of [
  ["edit-off", null], ["edit-translate", "translate"],
  ["edit-rotate", "rotate"], ["edit-scale", "scale"],
]) {
  $(id).addEventListener("click", () => setEditMode(mode));
}

/**
 * Write the corrected model back.
 *
 * Two buttons rather than one dialog with a choice in it, because the two are
 * not the same risk. Writing beside the original costs nothing; replacing it
 * cannot be undone, so it says what it is about to destroy and only offers
 * itself when the file it would replace is one this program can actually write.
 * A NIF or a USDZ leaves as glTF, and quietly putting glTF bytes in a file
 * named .nif would be worse than refusing.
 */
function paintSaveButtons() {
  const has = !!viewer.current;
  const over = $("save-over");
  const canOverwrite = has && !!openedPath && WRITABLE.test(openedPath);
  $("save-transform").disabled = !has;
  $("part-import").disabled = !has || !tauri;
  over.disabled = !canOverwrite;
  over.title = canOverwrite
    ? `Remplacer ${openedPath.split(/[\\/]/).pop()}, sans retour possible`
    : openedPath
      ? "Albedo écrit du glTF ; ce fichier est dans un autre format, passe par Enregistrer sous"
      : "Aucun fichier sur le disque";
}

/**
 * Bring another file in beside the one already open.
 *
 * The same loader and the same corrections as a plain open, because an
 * imported model is not a lesser one: it gets its materials normalised, its
 * colour spaces fixed and its textures found exactly as the first did.
 */
async function importPart(path) {
  if (!tauri || !viewer.current) return;
  setBusy(true);
  try {
    const url = tauri.core.convertFileSrc(path);
    const name = path.split(/[\\/]/).pop();
    const findTextures = async (names) => {
      const found = await tauri.core.invoke("find_textures", { modelPath: path, names });
      return (found || []).map((f) => ({ name: f.name, url: tauri.core.convertFileSrc(f.path) }));
    };
    const { object } = await loadModel(url, {
      renderer: viewer.renderer,
      findTextures,
      resolveSibling: siblingResolver(path),
    });
    normalizeMaterials(object);
    fixColorSpaces(object);
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    const entry = viewer.addPart(object, name);
    selectedPart = entry;
    // The scene changed underneath the channel copies and the material list
    channels.reset();
    applyChannel(currentChannel);
    paintParts();
    paintMaterialList();
    showStats(viewer.stats());
    showDimensions();
    if (editMode) setEditMode(editMode);
    else paintEditTarget();
    toast(`${name} importé · E pour le placer`);
  } catch (e) {
    console.error("[albedo] import :", e);
    toast(`Import impossible : ${e?.message || e}`);
  } finally {
    setBusy(false);
  }
}

$("part-import").addEventListener("click", async () => {
  if (!viewer.current) return;
  const picked = await tauri?.dialog?.open({
    multiple: false,
    filters: [{ name: "Modèles 3D", extensions: SUPPORTED }],
  });
  if (picked) await importPart(picked);
});

$("save-transform").addEventListener("click", async () => {
  $("save-note").textContent = "";
  await exportModel();
  $("save-note").textContent = $("export-note").textContent;
});

$("save-over").addEventListener("click", async () => {
  if (!openedPath) return;
  const name = openedPath.split(/[\\/]/).pop();
  const ok = await (tauri?.dialog?.confirm
    ? tauri.dialog.confirm(`Remplacer ${name} ? L'original sera perdu.`, {
        title: "Écraser le fichier",
        kind: "warning",
      })
    : Promise.resolve(window.confirm(`Remplacer ${name} ? L'original sera perdu.`)));
  if (!ok) return;
  await exportModel({ overwrite: true });
  $("save-note").textContent = $("export-note").textContent;
  toast("Fichier réécrit, sa vignette suivra");
});

// Held, not toggled: the same key that snaps in every other tool
window.addEventListener("keydown", (e) => {
  if (editMode && e.key === "Shift") viewer.setGizmoSnap(true);
});
window.addEventListener("keyup", (e) => {
  if (editMode && e.key === "Shift") viewer.setGizmoSnap(false);
});

// --- picking --------------------------------------------------------------

/**
 * Click a part of the model to select it.
 *
 * The pointer is also how the camera is turned, so a click is only a click when
 * it barely moved: dragging to orbit past a mesh must not select it. A hit
 * selects the material that surface actually uses, which for a mesh carrying
 * several is the one the triangle belongs to, not the first in the list.
 * Clicking nothing clears the selection, since that is what pointing at empty
 * space means.
 */
{
  const stage = $("view");
  let down = null;

  stage.addEventListener("pointerdown", (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });

  stage.addEventListener("pointerup", (e) => {
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    // Fly mode holds the pointer for looking around; a click there is not a pick
    if (moved > 4 || nav.mode !== "orbit") return;

    const box = stage.getBoundingClientRect();
    const hit = viewer.pick(
      ((e.clientX - box.left) / box.width) * 2 - 1,
      -((e.clientY - box.top) / box.height) * 2 + 1
    );
    if (!hit) {
      selectMaterial(null);
      return;
    }
    const material = materialOfHit(hit);
    selectMaterial(material ? material.uuid : null);
  });
}

/**
 * Which material a ray actually landed on.
 *
 * The rendered material is not always the authored one: an inspection channel
 * swaps every material for a flat stand-in, and the panel lists the originals.
 * The mesh remembers what it came with, so the answer is looked up there.
 */
function materialOfHit(hit) {
  const mesh = hit.object;
  const source = channels.original.get(mesh) ?? mesh.material;
  if (!Array.isArray(source)) return source;
  const group = hit.face?.materialIndex ?? 0;
  return source[group] ?? source[0];
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
  if (library?.isOpen && e.code !== "KeyB") return;
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
      toast(document.body.classList.contains("clean") ? "Interface masquée · H" : "Interface visible");
      break;
    case "KeyF":
      if (e.ctrlKey || e.altKey) return;
      e.preventDefault();
      viewer.frameCurrent();
      toast("Cadré · 100 %");
      break;
    case "F11":
      e.preventDefault();
      hud.toggleFullscreen();
      break;
    // The toast lives here rather than in applyChannel, which also runs on every
    // model load and on restoring a preference: neither is news.
    case "Digit1": applyChannel("shaded"); toast(labelOfChannel("shaded")); break;
    case "Digit2": applyChannel("albedo"); toast(labelOfChannel("albedo")); break;
    case "Digit3": applyChannel("normalMap"); toast(labelOfChannel("normalMap")); break;
    case "Digit4": applyChannel("roughness"); toast(labelOfChannel("roughness")); break;
    case "Digit5": applyChannel("uv"); toast(labelOfChannel("uv")); break;
    case "KeyO":
      // The same key opens a file with the modifier and orbits without it
      if (e.ctrlKey) {
        e.preventDefault();
        openFile();
      } else {
        hud.setMode("orbit");
        toast("Orbite");
      }
      break;
    case "KeyV":
      hud.setMode("fly");
      toast("Vol · Échap pour sortir");
      break;
    // Fly holds the mouse, so leaving it needs a key that is never a movement
    // one. Escape usually never reaches us, the webview eats it to release the
    // pointer, which the navigation already reads as the way out; this covers
    // the case where the capture was refused and fly mode has the keys only.
    case "Escape":
      if (editMode) setEditMode(null);
      else hud.setMode("orbit");
      break;
    // G, R and S belong to the edit mode while it is on, and to the grid, the
    // roll and nothing at all while it is off. Modal, as in every tool that
    // has more to do than it has letters.
    case "KeyE":
      if (nav.mode === "orbit") setEditMode(editMode ? null : "translate");
      break;
    case "KeyG":
      if (editMode) {
        setEditMode("translate");
        break;
      }
      $("opt-grid").checked = !$("opt-grid").checked;
      viewer.setGrid($("opt-grid").checked);
      toast($("opt-grid").checked ? "Grille affichée" : "Grille masquée");
      break;
    case "KeyS":
      if (editMode) setEditMode("scale");
      break;
    case "KeyT":
      if (nav.mode === "orbit") {
        toggleTurntable();
        toast(viewer.spin ? "Rotation continue" : "Rotation arrêtée");
      }
      break;
    case "KeyU":
      toggleUnlit();
      toast(currentChannel === "unlit" ? "Unlit" : "PBR");
      break;
    case "KeyB":
      e.preventDefault();
      toggleLibrary();
      break;
    case "KeyR":
      if (editMode) {
        setEditMode("rotate");
        break;
      }
      nav.resetRoll();
      toast("Roulis remis à plat");
      break;
    case "KeyW":
      if (!e.ctrlKey && nav.mode === "orbit") {
        $("opt-wireframe").checked = !$("opt-wireframe").checked;
        channels.setWireframe($("opt-wireframe").checked);
        toast($("opt-wireframe").checked ? "Fil de fer" : "Fil de fer coupé");
      }
      break;
    default:
      break;
  }
});

// Last, so every restored preference and every saved effect setting is already
// in the inputs and the first number shown is the one in force.
wireSliderValues($("inspector"));
paintSaveButtons();
