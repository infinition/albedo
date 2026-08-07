import { Viewer, shiftHue } from "./viewer/viewer.js";
import { loadModel, SUPPORTED } from "./viewer/loaders.js";
import { ChannelView, CHANNELS } from "./viewer/channels.js";
import { applyFoundTextures } from "./viewer/textures.js";
import {
  normalizeMaterials,
  fixColorSpaces,
  ensureAoUv,
  ignoreDeadVertexColors,
  replaceMap,
  toPhysical,
  MAP_SLOTS,
} from "./viewer/materials.js";
import { createPrefs } from "./prefs.js";
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
  // The lens can be dragged as well as slid, and the panel must agree
  onFov: (fov) => {
    $("opt-fov").value = String(Math.round(fov));
    $("fov-value").textContent = `${Math.round(fov)}°`;
    prefs.set("fov", Math.round(fov));
  },
  // Shift and drag turns the environment when the environment is the light
  onEnvRotate: (deg) => {
    $("env-rotation").value = String(deg);
    $("rot-value").textContent = `${deg}°`;
    prefs.set("environmentRotation", deg);
  },
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
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    const stats = viewer.setModel(object, animations);
    nav.calibrate(viewer.boxHelper.box);
    channels.reset();
    selectedMaterial = null;
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

  const present = MAP_SLOTS.filter(([slot]) => material[slot]);
  // With no map at all the albedo slot is still offered: trying one out is the
  // fastest way to tell a missing texture from a black one.
  const slots = present.length ? present : [["map", "Albedo"]];

  for (const [slot, label] of slots) {
    const tex = material[slot];
    const row = document.createElement("div");
    row.className = "map-row";

    const role = document.createElement("span");
    role.className = "map-role";
    role.textContent = label;

    const name = document.createElement("span");
    name.className = "map-name";
    name.textContent = textureLabel(tex);
    name.title = textureLabel(tex);

    const size = document.createElement("span");
    size.className = "map-size mono";
    size.textContent = textureSize(tex);

    const swap = document.createElement("button");
    swap.type = "button";
    swap.className = "seg";
    swap.textContent = tex ? "Remplacer" : "Choisir";
    swap.addEventListener("click", () => swapTexture(uuid, slot));

    row.append(role, name, size, swap);
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
  } else {
    // A standard material cannot transmit light whatever its settings, so the
    // repair of a lost refraction has to start by changing what it is.
    const glass = document.createElement("button");
    glass.type = "button";
    glass.className = "seg";
    glass.textContent = "En faire du verre";
    glass.title = "Convertir en matériau physique, transmission et IOR réglables";
    glass.addEventListener("click", () => {
      const box = viewer.boxHelper.box;
      const physical = toPhysical(material, {
        span: box.isEmpty() ? 1 : box.max.distanceTo(box.min),
      });
      channels.swapMaterial(uuid, physical);
      selectedMaterial = physical.uuid;
      paintMaterialList();
    });
    const row = document.createElement("div");
    row.className = "map-row";
    row.appendChild(glass);
    box.appendChild(row);
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
    label.addEventListener("click", () => {
      selectedMaterial = selectedMaterial === uuid ? null : uuid;
      paintMaterialList();
    });

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

/** Put the saved settings back, without writing them out again as we go. */
function applyPrefs() {
  const p = prefs.all();
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

  // A headless render short circuits everything else: this process exists to
  // produce one image for the shell and then stop.
  const job = await tauri.core.invoke("thumbnail_job").catch(() => null);
  if (job) {
    renderThumbnail(job);
  } else {
    // A file passed on the command line ("Open with…")
    const startup = await tauri.core.invoke("startup_file").catch(() => null);
    if (startup) openPath(startup);
    tauri.event.listen("open-file", (e) => e.payload && openPath(e.payload));
  }
}

restoreDevices();
applyPrefs();

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
    // Fly holds the mouse, so leaving it needs a key that is never a movement
    // one. Escape usually never reaches us, the webview eats it to release the
    // pointer, which the navigation already reads as the way out; this covers
    // the case where the capture was refused and fly mode has the keys only.
    case "Escape": hud.setMode("orbit"); break;
    case "KeyG":
      $("opt-grid").checked = !$("opt-grid").checked;
      viewer.setGrid($("opt-grid").checked);
      break;
    case "KeyT":
      if (nav.mode === "orbit") toggleTurntable();
      break;
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
