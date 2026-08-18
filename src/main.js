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
import { selection, decorId, decorKey } from "./selection.js";
import { adopt, nameFromFile, renameNode } from "./naming.js";
import { createTabs } from "./ui/tabs.js";
import { setLang, initLang, applyStatic, currentLang, num, t } from "./i18n/index.js";
import { cycle, isPressed, setPressed } from "./ui/toggle.js";

const $ = (id) => document.getElementById(id);

// The language the browser says, or the one the last session chose, applied to
// every static string before anything else paints.
initLang();
applyStatic();

function paintLangButton() {
  const b = $("btn-lang");
  b.textContent = currentLang() === "fr" ? "EN" : "FR";
  b.title = currentLang() === "fr" ? t("lang.toEn") : t("lang.toFr");
  b.setAttribute("aria-label", currentLang() === "fr" ? "English" : "Français");
}
$("btn-lang").addEventListener("click", () => {
  setLang(currentLang() === "fr" ? "en" : "fr");
  paintLangButton();
});
paintLangButton();

/**
 * The Retopo mode, declared here and wired at the bottom.
 *
 * Split on purpose. `showStats` refreshes it whenever the triangle count moves
 * and runs long before the wiring does, so the binding has to exist from the
 * first line; the wiring needs `hud` and the viewer, which do not exist until
 * much later.
 */
let retopo = null;
/** The Groupes mode, declared and wired the same way and for the same reason. */
let groups = null;
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
/** True while the handles are aimed at the centre of rotation, not the model. */
let pivotEditing = false;
/** True while a transform field has the caret, so repainting leaves it alone. */
let typingTransform = false;

/**
 * What was moved, and where it was before.
 *
 * A pose rather than a command: three vectors copied off the object are enough
 * to put it back exactly, they cost nothing to keep, and they do not care
 * whether the change came from a handle, an axis button, a typed field or a
 * reset. A log of operations would have to know about each of those, and would
 * be wrong the first time one of them grew an option.
 */
const history = { past: [], future: [], limit: 80 };
let pendingPose = null;

/*
 * --- documents ------------------------------------------------------------
 *
 * One open model per tab, all of them resident.
 *
 * The viewer draws one scene, so exactly one document is attached to it at a
 * time and the rest sit in their holders: the objects, their materials and their
 * textures, alive but out of the graph. Switching is a detach and an attach, not
 * a load, which is what makes it instant and what makes an unsaved edit survive
 * a trip to another tab and back.
 *
 * The cost is stated rather than hidden: five tabs on heavy models is five
 * models in memory, on an application whose own notes say meshes are held whole
 * and twice over while a job runs. That is what tabs mean, and it is the answer
 * chosen deliberately over reloading on every switch, which would have had to
 * serialise unsaved work to avoid throwing away the very thing tabs exist to
 * protect.
 *
 * What belongs to a document: its objects, its camera, its channel state, its
 * pose history, its selection, its path and whether it is modified. What belongs
 * to the viewer and is shared by all of them: the lights, the grid, the stand,
 * the environment, the exposure, and the wireframe overlay. The rule is whether
 * it would still be true of the file after an export.
 */

let docSeq = 0;
/** Every open model, in strip order. */
const documents = [];
/** The one attached to the viewer. Null only before the first document. */
let activeDoc = null;
let tabs = null;

function makeDocument({ title = "", path = null, preview = false } = {}) {
  const doc = {
    id: ++docSeq,
    title,
    path,
    idle: !path,
    dirty: false,
    /**
     * A tab you are only looking through.
     *
     * There is at most one, and the next model looked at takes its place instead
     * of opening a tab of its own. That is what makes clicking through a folder
     * of two hundred assets possible at all: without it, browsing a library
     * costs one tab per curiosity and the strip becomes the thing you have to
     * manage instead of the models.
     *
     * It stops being a preview the moment it stops being a look: any change that
     * would survive an export, and opening the retopology mode on it, which is a
     * statement that this model is what you came for.
     */
    preview,
    /** Viewer state while put aside; null while this document is the live one. */
    held: null,
    /** Channel state while put aside; null while live. */
    channelState: null,
    /** Look settings while put aside; null while live. */
    viewState: null,
    /** Pose history, which is about this model and no other. */
    history: { past: [], future: [], limit: 80 },
    selection: [],
    retopo: null,
    groups: null,
  };
  documents.push(doc);
  return doc;
}

function paintTabs() {
  tabs?.paint(documents, activeDoc?.id ?? null);
}

/**
 * This tab is no longer something you are merely looking through.
 *
 * Called from every route that turns looking into working: a change that would
 * survive an export, opening the retopology mode, and asking for the file
 * explicitly rather than selecting it in the grid.
 */
function promoteDocument(doc = activeDoc) {
  if (!doc?.preview) return;
  doc.preview = false;
  paintTabs();
}

/** The one tab being looked through, if there is one. */
const previewDocument = () => documents.find((d) => d.preview) || null;

/**
 * A square snapshot of the viewport, for the tab strip.
 *
 * Taken from the live canvas rather than rendered afresh, so a tab shows *what
 * you were looking at* when you left it: your angle, your channel, your framing.
 * A synthetic three quarter view would be prettier and would lie about which tab
 * is which the moment you turn a model around.
 *
 * The read happens in the same synchronous block as the render. Without
 * `preserveDrawingBuffer` the browser may discard the buffer at the next paint,
 * and asking for it permanently would tax every frame of every session to serve
 * a forty pixel square taken three times an hour.
 */
function snapThumb() {
  const gl = viewer.renderer;
  if (!gl || !viewer.current) return null;
  try {
    gl.render(viewer.scene, viewer.camera);
    const src = gl.domElement;
    const side = Math.min(src.width, src.height);
    if (!side) return null;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 40;
    // Cropped from the centre rather than squashed: a wide viewport squeezed
    // into a square turns every model into the same tall smear.
    cv.getContext("2d").drawImage(
      src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, 40, 40
    );
    return cv.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * The look settings, per document: how *this* scene is shown.
 *
 * Everything in here is a property of the picture rather than of the
 * application, which is the line this list is drawn along. A second model opened
 * beside the first starts from the defaults — its own lights, its own backdrop,
 * its own effects — because inheriting a rig somebody built for another asset is
 * inheriting a set of decisions that were never about this one.
 *
 * The preferences still exist and still matter: they are what a *session* starts
 * from. What they stopped being is what every scene shares.
 */
function captureViewState() {
  return {
    channel: currentChannel,
    wireframe: $("opt-wireframe").checked,
    wireOnly: wireOnlyOn,
    wireDark: $("opt-wire-dark").checked,
    flat: channels.flat,
    grid: $("opt-grid").checked,
    bounds: $("opt-bounds").checked,
    skeleton: $("opt-skeleton").checked,
    lightsAlwaysVisible: $("opt-lights-visible").checked,
    exposure: Number($("opt-exposure")?.value || 0),
    environment: viewer.envKind,
    environmentPath: prefs?.get?.("environmentPath") ?? null,
    envBackground: viewer.showEnvBackground,
    envLighting: viewer.envLighting,
    envIntensity: viewer.scene.environmentIntensity ?? 1,
    bgBrightness: Number($("bg-brightness")?.value ?? 1),
    // How the panorama is framed, which for an HDR is a lighting decision and
    // not merely a look: its rotation decides which way the key comes from. It
    // was the one part of the environment the document did not carry, so
    // switching tabs and back put the sun somewhere else.
    framing: { ...(viewer.framing || {}) },
    backdrop: { ...(viewer.backdrop || {}) },
    backdropPath: prefs?.get?.("backdropPath") ?? null,
    backgroundColour: `#${viewer.solidBackground.getHexString()}`,
    lights: viewer.lightState(),
    // The stand travels with the scene it was chosen for: a plinth picked to sit
    // a figurine on has nothing to say about the next file.
    pedestal: prefs?.get?.("pedestal") ?? null,
    pedestalTransform: viewer.pedestalPlacing(),
    // The whole effects stack, which used to be one global set shared by every
    // tab: grading a photograph in one left the next model graded.
    post: structuredClone(postState),
  };
}

/** Put a document's look back, without touching the persistent defaults. */
async function restoreViewState(s) {
  if (!s) return;
  applyChannel(s.channel);
  await setWireframe(s.wireframe, false);
  await setWireOnly(s.wireOnly, false);
  channels.setFlat(s.flat);
  $("opt-wire-dark").checked = s.wireDark;
  wire?.setColour(!s.wireDark);
  setGrid(s.grid, false);
  $("opt-bounds").checked = s.bounds;
  viewer.setBounds(s.bounds);
  $("opt-skeleton").checked = s.skeleton;
  viewer.setSkeleton(s.skeleton);
  $("opt-lights-visible").checked = !!s.lightsAlwaysVisible;
  viewer.setAlwaysShowLights(!!s.lightsAlwaysVisible);
  $("opt-exposure").value = String(s.exposure);
  viewer.setExposure(s.exposure);
  $("bg-colour").value = s.backgroundColour || "#14161a";
  viewer.setBackgroundColour(s.backgroundColour || "#14161a");
  if (s.backdrop) {
    viewer.setBackdrop(s.backdrop);
    $("backdrop-zoom").value = String(s.backdrop.zoom ?? 1);
    $("backdrop-x").value = String(s.backdrop.x ?? 0);
    $("backdrop-y").value = String(s.backdrop.y ?? 0);
    $("backdrop-blur").value = String(s.backdrop.blur ?? 0);
  }
  if (s.environment === "picture") await useEnvironment("picture", s.backdropPath, false);
  else if (s.environment !== "studio") await useEnvironment(s.environment, s.environmentPath, false);
  else await viewer.setEnvironment("studio");
  viewer.showEnvBackground = s.envBackground;
  $("env-background").checked = s.envBackground !== false;
  viewer.setEnvironmentLighting(s.envLighting);
  viewer.setEnvironmentIntensity(s.envIntensity);
  $("env-intensity").value = String(s.envIntensity);
  $("bg-brightness").value = String(s.bgBrightness ?? 1);
  viewer.setBackgroundBrightness(s.bgBrightness ?? 1);
  if (s.framing) {
    viewer.setFraming(s.framing);
    $("env-zoom").value = String(s.framing.zoom ?? 1);
    $("env-rotation").value = String(s.framing.rotation ?? 0);
    $("env-blur").value = String(s.framing.blur ?? 0);
  }
  paintEnvControls();
  // No `setKeyLight`/`setKeyLightPower`/`setKeyLightColour` here any more. They
  // wrote to light zero from three fields `captureViewState` never wrote, so
  // they were three calls acting on `undefined` — and `applyLights` on the very
  // next line rebuilds every light from scratch anyway, so even when they
  // happened to do something, they did it to an object about to be replaced.
  viewer.applyLights(s.lights || []);
  if (s.pedestal) {
    await usePedestal(s.pedestal, false);
    if (s.pedestalTransform) viewer.setPedestalTransform(s.pedestalTransform);
  } else {
    viewer.clearPedestal();
  }
  await applyPost(s.post);
  paintViewbar();
  paintLights();
}

/** A new scene starts from the default look, not the one left behind. */
async function resetViewSettings() {
  applyChannel("shaded");
  await setWireframe(false, false);
  await setWireOnly(false, false);
  channels.setFlat(false);
  // The one line here that is not a constant, and deliberately. Everything
  // else in this function is a look the *document* starts from; the floor is a
  // setting the *session* starts from, which is what "on or off by default"
  // means, and a literal `true` here was quietly overruling it on every new tab.
  setGrid(prefs.get("grid") !== false, false);
  $("opt-bounds").checked = false;
  viewer.setBounds(false);
  $("opt-skeleton").checked = false;
  viewer.setSkeleton(false);
  $("opt-lights-visible").checked = false;
  viewer.setAlwaysShowLights(false);
  $("opt-exposure").value = "1";
  viewer.setExposure(1);
  await viewer.setEnvironment("studio");
  viewer.setEnvironmentIntensity(1);
  $("env-intensity").value = "1";
  $("bg-brightness").value = "1";
  viewer.setBackgroundBrightness(1);
  viewer.showEnvBackground = true;
  $("env-background").checked = true;
  viewer.setFraming({ zoom: 1, rotation: 0, blur: 0 });
  $("env-zoom").value = "1";
  $("env-rotation").value = "0";
  $("env-blur").value = "0";
  viewer.setBackdrop({ zoom: 1, x: 0, y: 0, blur: 0 });
  for (const [id, v] of [["backdrop-zoom", "1"], ["backdrop-x", "0"], ["backdrop-y", "0"], ["backdrop-blur", "0"]]) {
    $(id).value = v;
  }
  $("bg-colour").value = "#14161a";
  viewer.setBackgroundColour("#14161a");
  paintBackdropPanes("studio");
  // Empty, which `applyLights` reads as "give me the standard rig": one key
  // light, where the standard rig puts it.
  viewer.applyLights([]);
  viewer.clearPedestal();
  await applyPost(structuredClone(POST_DEFAULTS));
  paintViewbar();
  paintLights();
}

/** Take the live document out of the viewer and into its own holder. */
function parkActive() {
  if (!activeDoc) return;
  // Before the detach, while there is still something on screen to photograph.
  activeDoc.thumb = snapThumb() || activeDoc.thumb;
  activeDoc.held = viewer.detachModel();
  activeDoc.channelState = channels.snapshot();
  activeDoc.viewState = captureViewState();
  activeDoc.path = openedPath;
  activeDoc.dirty = sceneDirty;
  activeDoc.history.past = history.past;
  activeDoc.history.future = history.future;
  activeDoc.selection = [...selection.ids].map((id) => [id, selection.kindOf(id)]);
  activeDoc.selectedPart = selectedPart;
  activeDoc.retopo = retopo?.saveState?.() ?? activeDoc.retopo;
  activeDoc.groups = groups?.saveState?.() ?? activeDoc.groups;
}

/** Put a document back in the viewer and point every panel at it. */
function adoptDocument(doc) {
  activeDoc = doc;
  channels.adopt(doc.channelState);
  viewer.attachModel(doc.held);
  openedPath = doc.path;
  sceneDirty = doc.dirty;
  history.past = doc.history.past;
  history.future = doc.history.future;
  selectedPart = doc.selectedPart && viewer.parts.includes(doc.selectedPart)
    ? doc.selectedPart
    : null;
  selection.set(doc.selection || []);
  retopo?.loadState?.(doc.retopo);
  groups?.loadState?.(doc.groups);
  void restoreViewState(doc.viewState);

  // Everything that reads the scene has to be told it changed, because nothing
  // was loaded and none of the usual load-time repaints will fire.
  currentTitle = doc.title;
  const kind = /\.([a-z0-9]+)$/i.exec(doc.title);
  $("file-tris").hidden = !kind;
  $("file-kind").hidden = !kind;
  if (kind) $("file-kind").textContent = kind[1];
  applyChannel(currentChannel);
  $("empty").classList.toggle("hidden", !!viewer.current);
  showStats(viewer.stats());
  showDimensions();
  paintOrientation();
  paintParts();
  paintSaveButtons();
  paintMaterialList();
  paintShotPreview();
  paintHistory();
  paintTransform();
  paintEditTarget();
  outliner?.reset();
  $("tree").textContent = viewer.current ? viewer.sceneTree() : "";
  buildAnimationUi(viewer.clips || []);
  $("btn-export").disabled = !viewer.current;
  $("btn-export-obj").disabled = !viewer.current;
  $("btn-export-stl").disabled = !viewer.current;
  retopo?.refresh();
  paintTabs();
}

function switchTo(id) {
  if (activeDoc?.id === id) return;
  const next = documents.find((d) => d.id === id);
  if (!next) return;
  parkActive();
  adoptDocument(next);
}

/**
 * A new tab, empty, ready to be composed in.
 *
 * Empty is a real state rather than a placeholder: the import button and a drop
 * both add to whatever is in the scene, so a tab with nothing in it is exactly
 * where you start when the thing you want is several files put together.
 */
function newDocument({ activate = true, preview = false } = {}) {
  parkActive();
  const doc = makeDocument({ preview });
  // An empty holder rather than null, so `adoptDocument` has the same shape to
  // work with whether the tab has ever held anything or not.
  doc.thumb = snapThumb() || doc.thumb;
  doc.held = viewer.detachModel();
  doc.channelState = channels.snapshot();
  channels.reset();
  doc.channelState = channels.snapshot();
  if (activate) {
    adoptDocument(doc);
    void resetViewSettings();
  } else paintTabs();
  return doc;
}

async function closeDocument(id) {
  const doc = documents.find((d) => d.id === id);
  if (!doc) return;

  /*
   * Ask about the tab being closed, not about the one on screen.
   *
   * `confirmDiscard` reads the live scene's flag, which is the wrong question
   * when the cross being clicked belongs to a tab that is parked. Bringing it
   * forward first is also the honest thing: nobody should be asked to decide
   * about work they cannot see.
   */
  if (doc.dirty || (doc === activeDoc && sceneDirty)) {
    if (doc !== activeDoc) switchTo(id);
    if (!(await confirmDiscard(t("dlg.docModified").replace("{name}", doc.title || t("tabs.untitled"))))) return;
  }

  const index = documents.indexOf(doc);
  const wasActive = doc === activeDoc;
  documents.splice(index, 1);

  if (wasActive) {
    // Park it so its objects are in a holder to release, then take up the
    // neighbour on the right, the way every tab strip does.
    doc.thumb = snapThumb() || doc.thumb;
    doc.held = viewer.detachModel();
    doc.channelState = channels.snapshot();
    activeDoc = null;
  }
  /*
   * What the other tabs still point at.
   *
   * Two models that reference the same image file share one texture object, so
   * releasing this document's textures without asking the others would leave a
   * parked tab with a black surface when it came back. The live scene protects
   * itself; the parked ones have to be named.
   */
  // The document is already out of the list, so `viewer.alsoKeep` naturally
  // names every tab that is left and nothing else.
  viewer.releaseHeld(doc.held);
  channels.releaseSnapshot(doc.channelState);
  doc.held = null;
  doc.channelState = null;

  if (!documents.length) {
    // Never no tabs at all: an application with an empty strip has nowhere to
    // drop a file, and the empty state is a tab like any other.
    channels.reset();
    adoptDocument(makeDocument());
    setTitle("Albedo", true);
    return;
  }
  if (wasActive) adoptDocument(documents[Math.min(index, documents.length - 1)]);
  else paintTabs();
}

/**
 * Whether the scene holds work that leaving would throw away.
 *
 * A viewer does not need this. The moment it grew handles, texture replacement,
 * material presets, imported objects and a retopology engine, it stopped being
 * one: clicking a file in the library replaced everything with no question
 * asked, and there was no way to know afterwards what had been there.
 *
 * Only changes that would survive an export count. Hiding a material, unplugging
 * a map, choosing a channel or moving the camera are ways of *looking* and are
 * deliberately not tracked: a confirmation that fires because someone toggled
 * the grid is a confirmation people learn to dismiss without reading, which is
 * worse than none.
 */
let sceneDirty = false;

function markDirty() {
  sceneDirty = true;
  // A change is the end of a preview: what you are looking at has become what
  // you are working on, and the next model looked at must not take its place.
  if (activeDoc) activeDoc.preview = false;
  // The tab shows it, so the flag and the dot cannot disagree.
  if (activeDoc && !activeDoc.dirty) {
    activeDoc.dirty = true;
  }
  paintTabs();
}

function clearDirty() {
  sceneDirty = false;
  if (activeDoc && activeDoc.dirty) {
    activeDoc.dirty = false;
    paintTabs();
  }
}

/**
 * Ask before throwing the scene away.
 *
 * Returns true when it is fine to go ahead. The shell's own dialog when there is
 * one, because a webview `confirm` in a Tauri window looks like a web page in a
 * way nothing else in this application does.
 */
async function confirmDiscard(what = null) {
  if (!sceneDirty) return true;
  const question = `${what || t("dlg.sceneModified")}\n${t("dlg.discardAsk")}`;
  /*
   * `ask` with its own labels rather than `confirm` with Ok and Cancel.
   *
   * "Ok" on a warning about losing work says nothing about which way it goes.
   *
   * Both plugin functions go through `plugin:dialog|message` underneath and
   * compare the pressed button against the label they asked for, which is worth
   * knowing twice over: the permission the capability set needs is
   * `dialog:allow-message`, not the `dialog:allow-confirm` that was listed and
   * would have failed in the built application and nowhere else; and a stub that
   * answers with a boolean instead of a label always reads as a refusal.
   */
  if (tauri?.dialog?.ask) {
    return !!(await tauri.dialog
      .ask(question, {
        title: "Albedo",
        kind: "warning",
        okLabel: t("dlg.discardOk"),
        cancelLabel: t("dlg.discardCancel"),
      })
      .catch((e) => {
        // A dialog that cannot open must not become a silent yes.
        console.warn("[albedo] confirmation impossible :", e);
        return false;
      }));
  }
  return window.confirm(question);
}

/** Field, what it reads, which axis, and what to multiply by to show it. */
const XFORM = [
  ["tx", "position", "x", 1], ["ty", "position", "y", 1], ["tz", "position", "z", 1],
  ["rx", "rotation", "x", 180 / Math.PI], ["ry", "rotation", "y", 180 / Math.PI], ["rz", "rotation", "z", 180 / Math.PI],
  ["sx", "scale", "x", 1], ["sy", "scale", "y", 1], ["sz", "scale", "z", 1],
];

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
function toast(text, ms) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  /*
   * Long enough to read, and no longer.
   *
   * Eleven hundred milliseconds is right for "Copié" and wrong for a loader
   * error, which is the longest thing this ever says and the one message you
   * actually have to read. Roughly forty milliseconds a character past the
   * short ones, capped so a very long message still goes away on its own.
   */
  const hold = ms ?? Math.min(6000, Math.max(1100, 700 + text.length * 42));
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), hold);
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

const labelOfChannel = (id) => {
  const c = CHANNELS.find((c) => c.id === id);
  return c ? t(c.labelKey) : id;
};
const viewer = new Viewer($("view"));
const channels = new ChannelView(viewer);

/*
 * The strip, and the first tab, before anything can want either.
 *
 * `setTitle` paints the strip and runs long before the rest of the wiring, and
 * the empty state is a document like any other, so both exist from here on.
 * The module is a plain import rather than a lazy one: it is a hundred lines and
 * a handful of nodes, and there is no session in which the strip is not needed.
 */
tabs = createTabs({
  host: $("tabs-strip"),
  onActivate: switchTo,
  onClose: closeDocument,
  onKeep: (id) => promoteDocument(documents.find((d) => d.id === id)),
  onNew: () => {
    newDocument();
    setTitle("Albedo", true);
    toast(t("toast.newTab"));
  },
});
activeDoc = makeDocument({ title: "Albedo" });
paintTabs();

/*
 * What the parked tabs still point at, asked for at every release.
 *
 * Any load replaces the live scene and releases what it held, and any close
 * releases a holder. Both would happily free a texture another tab shares, and
 * the failure is silent until that tab comes forward with a black surface. The
 * viewer asks; here is the only place that knows the answer.
 */
/*
 * Refit a previewed model when the strip it lives in changes width.
 *
 * The camera frames once, at load, against whatever the canvas measured then.
 * Open the panel or drag the splitter afterwards and the framing is a leftover
 * from a box that no longer exists: a model sized for half the window rattling
 * around in a third of it, or clipped by it.
 *
 * Only while previewing. A preview is browsing, so refitting is what you want;
 * a document you are working in has a camera you placed on purpose, and moving
 * it because a panel moved would be the tool overruling you.
 *
 * Debounced to the end of the gesture: reframing on every pixel of a drag fights
 * the drag, and the answer only matters once it stops.
 */
let refitTimer = null;
window.addEventListener("resize", () => {
  if (!activeDoc?.preview || !viewer.current) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    if (activeDoc?.preview && viewer.current) viewer.frameCurrent();
  }, 140);
});

/*
 * The view toolbar relays; it does not reimplement.
 *
 * Every control here already exists and already works: `applyChannel`, the lazy
 * wireframe controller, the two checkboxes in the panel. A second implementation
 * of any of them would be a second thing to keep in step, and the one you are
 * not looking at is always the one that has drifted. So the bar forwards, and
 * reads its own state back from what it forwarded to.
 */
for (const b of document.querySelectorAll("[data-vb-ch]")) {
  b.addEventListener("click", () => {
    // Clay cycles: lit clay, then the same gray without the light, then back.
    // The unlit state is where the wireframe reads best, and that is the thing
    // the clay button is for, so it is one button, not two.
    let id = b.dataset.vbCh;
    // Clay is one button over two channels: lit grey and unlit grey. Clicking it
    // from anywhere else arrives on the lit one, and clicking it again flips.
    if (id === "clay") id = cycle(["clay", "clayUnlit"], currentChannel);
    applyChannel(id);
    paintViewbar();
  });
}

$("vb-wire").addEventListener("click", async () => {
  const on = !isPressed($("vb-wire"));
  // Through the panel's own checkbox, so the two can never disagree about
  // whether the lines are on.
  $("opt-wireframe").checked = on;
  await setWireframe(on);
  paintViewbar();
});

/*
 * Lines only, as a mode of the overlay.
 *
 * It used to be `material.wireframe`, which replaced the surface with lines and
 * so fought the overlay and vanished on any channel that handed out a fresh
 * stand-in: on in the shaded view, off in the next channel over. As an overlay
 * uniform it survives every channel and takes the light or dark colour, and the
 * master switch (W) turns the whole thing off and back on in whatever style was
 * armed.
 */
let wireOnlyOn = false;
$("vb-wire-only").addEventListener("click", () => {
  const on = !isPressed($("vb-wire-only"));
  setWireOnly(on);
  toast(t(on ? "toast.wireOnlyOn" : "toast.facesRendered"));
});

$("vb-wire-dark").addEventListener("click", async () => {
  // The button is now "light": dark is the default, and this switches to light.
  const light = !isPressed($("vb-wire-dark"));
  $("opt-wire-dark").checked = !light;
  (await wakeWire())?.setColour(light);
  viewer.invalidate();
  paintViewbar();
});

/**
 * Lines only, through the overlay.
 *
 * "Only lines" implies lines: turning it on brings the master switch up with
 * it. The style is remembered rather than owned by the master, so W turns the
 * whole wire off and back on in whatever style was armed. The state lives here,
 * so the bar can repaint it, rather than on the materials, which is what made
 * the old version leak from one channel to the next.
 */
async function setWireOnly(on, remember = true) {
  wireOnlyOn = on;
  setPressed($("vb-wire-only"), on);
  if (on && !$("opt-wireframe").checked) await setWireframe(true, remember);
  // The uniform lives on the overlay, so the overlay has to exist before it can
  // be set: on a restore where the master is on but the overlay was never woken,
  // `channels.setWireOnly` would silently find no wire and set nothing.
  if (on) await wakeWire();
  channels.setWireOnly(on);
  if (remember) prefs.set("wireOnly", on);
  paintViewbar();
}

/**
 * One flat colour per face, or the smooth gradient.
 *
 * A toggle rather than a channel: the lit look stays lit, only the facets go
 * hard, which is what makes a wireframe view readable in the tools that show
 * one. It goes through the channel view so every material, stand-in included,
 * follows the switch.
 */
function setFlat(on, remember = true) {
  setPressed($("vb-flat"), on);
  channels.setFlat(on);
  if (remember) prefs.set("flat", on);
  paintViewbar();
}

$("vb-flat").addEventListener("click", () => {
  const on = !isPressed($("vb-flat"));
  setFlat(on);
  toast(on ? t("toast.flatOn") : t("toast.flatOff"));
});

/**
 * Read the bar's state back from the controls it drives.
 *
 * The active channel is read off the panel's own list rather than from
 * `currentChannel`, and that is not a style choice. `currentChannel` is a `let`
 * declared several hundred lines below, so reading it from a call made while the
 * module is still evaluating throws on the temporal dead zone, and that throw
 * *aborts the rest of the module*: every declaration after it never happens and
 * the application comes up half built, with no clue on screen as to why.
 * Reading the DOM has no such ordering, and the panel is the source of truth
 * anyway.
 */
/*
 * The view bar puts itself away when it is not in use.
 *
 * Fifteen seconds without a pointer on it or a click in it and it slides off to
 * the left, over five seconds, into a handle at the edge. Anything brings it
 * back at once, and that asymmetry is deliberate: waiting five seconds for a
 * control you have just reached for would be the tool making you watch an
 * animation.
 */
/*
 * The corner that gives the interface back while full screen.
 *
 * Watched here rather than in CSS because a hover zone cannot reveal a different
 * element, and the thing that must come back is the tab bar, which carries the
 * button that leaves. Ninety by sixty pixels: big enough to find by throwing the
 * mouse into the corner, small enough never to be crossed on the way somewhere
 * else.
 *
 * Without this the only exit is a keyboard shortcut, and a mode you can only
 * leave if you already know the shortcut is a trap rather than a mode.
 */
window.addEventListener("pointermove", (e) => {
  if (!document.body.classList.contains("immersive")) return;
  const inCorner = e.clientY < 60 && e.clientX > window.innerWidth - 90;
  document.body.classList.toggle("peeking-out", inCorner);
});

// The bar no longer hides on its own. It is one of three states, chosen by a
// discreet corner button: horizontal, vertical, or reduced to that button
// alone, floating. Hovering it brings the bar back, since a control that only
// shrinks is a control that traps.
//
// It opens reduced. The first thing anyone wants to see on launch is the model,
// not a strip of buttons across it, and the button that brings the bar back
// answers to a hover rather than to a click.
const ORIENTS = ["horizontal", "vertical", "reduced"];
let orientation = "reduced";

function setOrientation(next) {
  orientation = next;
  const bar = $("viewbar");
  bar.classList.toggle("vertical", next === "vertical");
  bar.classList.toggle("reduced", next === "reduced");
  $("viewbar-orient").setAttribute("data-orient", next);
}

$("viewbar-orient").addEventListener("click", () => {
  setOrientation(ORIENTS[(ORIENTS.indexOf(orientation) + 1) % ORIENTS.length]);
});
$("viewbar-orient").addEventListener("pointerenter", () => {
  if (orientation === "reduced") setOrientation("horizontal");
});

/**
 * Bring the bar back when something is picked in the viewport.
 *
 * It opens reduced, and picking a part of the model is the moment the tools
 * start being relevant: whoever clicks a mesh is working on it, not looking at
 * it. Turning and zooming are not that moment, and the pick handler has already
 * ruled them out — a drag of more than four pixels is an orbit, never a click.
 * Nor is clicking empty space, which puts a selection away.
 */
function revealBar() {
  if (orientation === "reduced") setOrientation("horizontal");
}

setOrientation(orientation);

function paintViewbar() {
  /*
   * The plate is repainted whole, not just the six buttons this file put in it.
   *
   * Retopo appends two more -- the atlas islands and the deviation heat map --
   * and those are not channels: they are painted over the shaded render, so the
   * channel underneath stays `shaded` and reading `#channels` would light the
   * wrong button. It says which of its own is showing in `data-view` on the
   * plate, and clears it as soon as a real channel is picked. Nothing here knows
   * what those two are, only that the plate may hold buttons it did not write.
   */
  const plate = $("vb-colour");
  const live = plate.dataset.view || document.querySelector("#channels .active")?.dataset.id;
  for (const b of plate.children) {
    // The clay button lights for both of its states: lit gray and unlit gray
    // are one button that cycles, not two channels the plate should split.
    const isClay = b.dataset.vbCh === "clay" && (live === "clay" || live === "clayUnlit");
    b.classList.toggle("active", isClay || (b.dataset.vbCh || b.dataset.colour) === live);
  }
  const on = setPressed($("vb-wire"), $("opt-wireframe").checked);
  // The light or dark choice only exists while there are lines to colour, so it
  // appears with them rather than sitting inert two thirds of the time.
  $("vb-wire-dark").hidden = !on;
  // The bar button is the light toggle: active when the lines are light.
  setPressed($("vb-wire-dark"), !$("opt-wire-dark").checked);
  // The lines only mode is the overlay's other half, lit only while the master
  // is on: the button says what is actually drawing, and the armed style comes
  // back with the master (W) instead of being forgotten.
  setPressed($("vb-wire-only"), wireOnlyOn && on);
  // Flat shading is a look, read from the channel view rather than from a
  // button that would have to remember its own state.
  setPressed($("vb-flat"), channels.flat);
  setPressed($("vb-grid"), $("opt-grid").checked);
}

viewer.alsoKeep = () => {
  const keep = new Set();
  for (const doc of documents) {
    if (doc === activeDoc) continue;
    for (const t of viewer.texturesHeldBy(doc.held)) keep.add(t);
  }
  return keep;
};

// The HUD needs the navigation and the navigation fires HUD actions, so the
// handlers are filled in once both exist.
const actions = {};
let lastFovToast = -1;
const nav = new Navigation(viewer, {
  onAction: (a) => actions[a]?.(),
  onDevice: showDevice,
  // The lens can be dragged as well as slid, and the panel must agree
  onFov: (fov) => {
    const deg = Math.round(fov);
    $("opt-fov").value = String(deg);
    $("fov-value").textContent = `${deg}°`;
    // The panel is usually shut while the lens is being dragged, and the drag
    // is the one gesture where the number is the whole point. Announced only
    // when the whole degree changes, not on every pointer move, so the toast
    // stays readable instead of flashing the same number a hundred times.
    if (deg !== lastFovToast) {
      lastFovToast = deg;
      toast(t("toast.fov").replace("{deg}", deg));
    }
    prefs.set("fov", deg);
  },
  // The wheel is the other handle on the travel pace, and the panel must agree
  onSpeed: (scale) => {
    paintFlySpeed(scale);
    toast(t("toast.flySpeed").replace("{scale}", flySpeedLabel(scale)));
    prefs.set("devices", deviceSnapshot());
  },
  // Shift and drag turns the environment when the environment is the light
  onEnvRotate: (deg) => {
    $("env-rotation").value = String(deg);
    $("rot-value").textContent = `${deg}°`;
    toast(t("toast.envRotationDeg").replace("{deg}", deg));
    prefs.set("environmentRotation", deg);
  },
  onLightRotate: (entry) => {
    if (decorSelection.type === "light" && decorSelection.id === entry.id) {
      updateLightControls(entry);
    }
    paintDecorTree();
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
    if (percent !== null) toast(t("toast.zoomPercent").replace("{percent}", percent));
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
/** Saved settings, null until the deferred load below assigns it. */
let prefs = null;

/**
 * The startup work that used to gate this module.
 *
 * `createPrefs` and the shell block further down each round trip the backend
 * once at module scope. Everything between here and there registered its
 * listeners only after both resolved, so a backend that was slow or dead left
 * a complete looking window with nothing wired to it. Both now finish in the
 * background: every listener attaches at once, and the few pieces that need a
 * result chain on this promise instead of on the whole module.
 */
const shellReady = (async () => {
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

  prefs = await createPrefs(tauri);
})().catch((e) => console.error("[albedo] démarrage différé:", e));

/** True when this process exists only to draw one thumbnail and stop. */
let headless = false;

const setBusy = (on) => {
  const el = $("loading");
  el.hidden = !on;
  if (!on) {
    el.classList.remove("determinate");
    el.style.removeProperty("--p");
  }
};

/**
 * How far the file has been read, when the loader can say.
 *
 * `loadModel` has always handed a fraction out and nobody took it, so the strip
 * along the top ran the same looping sweep for a two megabyte GLB and for a
 * three hundred megabyte FBX: motion, and no answer to the one question you ask
 * while you wait.
 *
 * It goes back to the sweep at the end rather than sitting full: reading the
 * bytes is the part that can be measured, and parsing them, building the
 * materials and framing the result all happen after the last byte arrives. A
 * bar stuck at 100% for four seconds reads as a hang.
 */
const setProgress = (fraction) => {
  const el = $("loading");
  if (el.hidden) return;
  if (!(fraction > 0) || fraction >= 1) {
    el.classList.remove("determinate");
    return;
  }
  el.classList.add("determinate");
  el.style.setProperty("--p", `${(fraction * 100).toFixed(1)}%`);
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
  pivotEditing = false;
  // The poses name objects that are about to be released; keeping them would
  // mean an undo that puts a freed mesh back into a scene it no longer belongs to.
  history.past.length = 0;
  history.future.length = 0;
  pendingPose = null;
  // A segmentation is a partition of one particular model's triangles. Carrying
  // it into the next one would paint this model with the last one's answer, and
  // the ids would land on whatever triangles happen to sit at those indices.
  groups?.forget?.();
  setEditMode(null);
  try {
    const { object, animations, info } = await loadModel(url, {
      renderer: viewer.renderer,
      onProgress: setProgress,
      findTextures,
      resolveSibling,
    });
    // Phong/Lambert under an IBL turns into a white veil: unify on PBR first
    normalizeMaterials(object);
    fixColorSpaces(object);
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    const stats = viewer.setModel(object, animations, label || "");
    // A file is allowed to call two of its meshes the same thing, and plenty
    // do. The outliner cannot, and neither can anything that names a result
    // after its source: two rows reading `Cube` are two rows you cannot tell
    // apart, and a low poly made from "the second one" has nothing to say.
    adopt(viewer.root, object);
    // A single mesh called `mesh_0` is the exporter shrugging. The file has a
    // name, and it is the one every derived name will be built from.
    nameFromFile(viewer.root, object, label || "");
    /*
     * The veil comes down here, the instant there is something behind it.
     *
     * It used to be lifted further along, after the channels, the wireframe and
     * the transparency pass. Anything throwing in between left the model on
     * screen with "Dépose un modèle" floating over it, swallowing every click:
     * visible and untouchable. That has now happened twice from two unrelated
     * causes, which is the definition of a bad place to put it.
     *
     * A model in the scene is the whole condition for hiding it. Whatever else
     * goes wrong afterwards is a problem with a message, not a reason to keep
     * the door shut.
     */
    $("empty").classList.add("hidden");
    nav.calibrate(viewer.boxHelper.box);
    channels.reset();
    selection.clear();
    clearDirty();
    // A new model needs its own geometry prepared before it can draw lines.
    await setWireframe($("opt-wireframe").checked, false);
    applyChannel(currentChannel);
    $("opt-skeleton").checked = viewer.skeletons.visible;

    /*
     * The tab's picture, for the model that just arrived.
     *
     * Capturing only when a tab is parked was not enough, and the gap showed
     * exactly where it mattered most: a preview tab is *reused in place* and
     * never parked, so it kept the first model's snapshot for every model after
     * it. The strip showed one thing and the tab held another, which is worse
     * than showing nothing.
     *
     * On the next frame, because the camera is framed and the channel applied
     * during this one, and a photograph taken before either is a photograph of
     * the wrong thing.
     */
    requestAnimationFrame(() => {
      if (!activeDoc || !viewer.current) return;
      const shot = snapThumb();
      if (!shot) return;
      activeDoc.thumb = shot;
      paintTabs();
    });

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
    forgetChannelThumbs();
    paintSaveButtons();
    $("btn-export").disabled = false;
    $("btn-export-obj").disabled = false;
    $("btn-export-stl").disabled = false;

    paintShotPreview();
    // The cut is expressed against the model's own extent, so a new one has to
    // recompute where the plane actually falls.
    viewer.setClipping({});
    $("tree").textContent = viewer.sceneTree();
    paintMaterialList();
    // A different model: different portraits, different branches, and nothing
    // worth keeping open from the last one.
    outliner?.reset();
    $("empty").classList.add("hidden");
    buildAnimationUi(animations);
    if (info?.warnings?.length) console.warn("[albedo]", info.warnings);
  } catch (e) {
    console.error(e);
    setTitle(t("toast.failed").replace("{e}", e.message || e), true);
  } finally {
    setBusy(false);
  }
}

/**
 * What the active document is called.
 *
 * Held here rather than read back out of the strip. The name is used to propose
 * an export file name, and reading it out of a tab would mean reading back
 * whatever the strip decided to truncate it to.
 */
let currentTitle = "Albedo";

function setTitle(label, idle = false) {
  currentTitle = label;
  if (activeDoc) {
    activeDoc.title = label;
    activeDoc.idle = idle;
  }
  const kind = /\.([a-z0-9]+)$/i.exec(label);
  const badge = $("file-kind");
  badge.hidden = !kind;
  if (kind) badge.textContent = kind[1];
  paintTabs();
}

/** What a file that has just been written is called, and how big it came out. */
function writtenNote(path, bytes) {
  return t("note.writtenSized")
    .replace("{file}", fileLabel(path))
    .replace("{size}", (bytes / 1048576).toFixed(1));
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
  $("dimensions").textContent = t("pane.units")
    .replace("{x}", n(x)).replace("{y}", n(y)).replace("{z}", n(z));
}

/**
 * Triangles in the short form people actually say out loud.
 *
 * 845, 102.2k, 2.4M. The full figure lives in the status line; this one sits
 * beside the file name because it is the number every decision in this
 * application is taken against, and a budget you have to go and look up is a
 * budget you stop checking.
 */
function shortCount(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function showStats(stats, extra) {
  const n = num;
  const count = stats.triangles || stats.points || 0;
  $("file-tris").hidden = !count;
  if (count) {
    $("file-tris").textContent = `${shortCount(count)} ${stats.points && !stats.triangles ? "pts" : "tri"}`;
    $("file-tris").title = t(stats.points && !stats.triangles ? "pane.ptsCountTitle" : "pane.trisCountTitle").replace("{n}", n(count));
  }
  const parts = [];
  // A point cloud carries points, not triangles; saying "0 tri" about one
  // describes nothing.
  if (stats.triangles || !stats.points) parts.push(`${n(stats.triangles)} tri`, `${stats.meshes} mesh`);
  if (stats.points) parts.push(`${n(stats.points)} pts`);
  parts.push(`${stats.materials} mat`, `${stats.textures} tex`);
  if (extra) parts.push(extra);
  $("stats").textContent = parts.join(" · ");
  // The Retopo panel is a budget expressed against the triangle count, so it is
  // wrong the moment this number moves. Only if the panel was ever opened.
  retopo?.refresh();
}

/** Open a path coming from the OS (dialog, "Open with", drag & drop). */
/** The file on disk the viewport is showing, when there is one. */
let openedPath = null;

async function openPath(path, { force = false, keepLibrary = false } = {}) {
  if (!tauri) return;
  /*
   * The one funnel every route to a new model goes through: the library, a drop,
   * "Open with", the file picker. Asking here rather than at each of them is
   * what makes it impossible to add a fifth route that forgets to ask.
   *
   * The preview strip is the exception, and it gets a refusal rather than a
   * question. Selecting a card is browsing, not opening, so a dialog on every
   * card would be one people dismiss without reading; and loading anyway is the
   * very thing being complained about. A modified scene simply does not get
   * previewed over, and the strip goes on showing what it showed.
   */
  /*
   * Where the model lands, and it is three different answers.
   *
   * **Already open**: its tab comes forward. Nobody wants two tabs of one file,
   * and a folder browsed twice would otherwise fill the strip with duplicates.
   *
   * **Selected in the library**: the preview tab, which is the one tab you are
   * looking *through* rather than working in. The next model selected takes its
   * place. Without this, browsing two hundred assets costs two hundred tabs and
   * the strip becomes the thing being managed instead of the models.
   *
   * **Asked for explicitly**: a tab of its own, or the preview tab promoted if
   * it already holds that very file, because asking for what you are looking at
   * is exactly how a look becomes a piece of work.
   */
  const already = documents.find((d) => d.path === path);
  if (already && already !== activeDoc) {
    switchTo(already.id);
    if (!keepLibrary) promoteDocument(already);
    return;
  }
  if (already === activeDoc && already) {
    if (!keepLibrary) promoteDocument(already);
    return;
  }

  if (keepLibrary) {
    // Browsing. Reuse the preview tab, or make one; never touch a tab that is
    // being worked in, which is the whole complaint this answers.
    const spare = previewDocument();
    if (spare) {
      if (spare !== activeDoc) switchTo(spare.id);
    } else if (viewer.current || sceneDirty || documents.length > 1) {
      newDocument({ preview: true });
    } else {
      // The untouched first tab is already a tab nobody is working in.
      if (activeDoc) activeDoc.preview = true;
    }
  } else if (!force && (viewer.current || sceneDirty)) {
    newDocument();
  }
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
  /*
   * The document learns its own path now rather than when it is next parked.
   *
   * It used to be written only in `parkActive`, so the live tab's `path` stayed
   * null while it was the one on screen. Asking "is this file already open" then
   * missed the tab you were looking at, and asking for the file you were
   * previewing opened a second tab of it beside the first.
   */
  if (activeDoc) activeDoc.path = path;
  if (!keepLibrary) promoteDocument();
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
    showStats(
      viewer.stats(),
      t("toast.texturesFound").replace("{n}", applied).replace("{roles}", roles.join(", "))
    );
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
  // The bar follows from here, the one place a channel actually changes.
  queueMicrotask(paintViewbar);
  currentChannel = id;
  channels.apply(id);
  for (const b of $("channels").children) b.classList.toggle("active", b.dataset.id === id);
}

/*
 * There is no PBR / Unlit pair here any more, and its removal is the fix for a
 * failure that looked like nothing at all.
 *
 * The two buttons were the same choice the Couleur group in the view bar makes
 * with seven. One of them had already been deleted from `index.html`, leaving
 * these four lines pointing at an element that does not exist, so
 * `$("mode-pbr").addEventListener` threw *while the module was still being
 * evaluated*. A module that throws at the top level stops there: everything
 * below this line was simply never run, which is every listener in the second
 * half of this file. Open a file, the library, Retopo, any keyboard shortcut,
 * the drop handler -- none of them were ever attached. The window came up
 * looking complete and no button in it did anything.
 *
 * Nothing on screen said so, and clicking every button in the page reports
 * nothing either, because a button with no listener throws no error. The one
 * place it was visible was the console, on the very first line.
 */
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
 * Choose a material, from the panel, from the tree or from the model.
 *
 * Every route ends in the one selection so they can never disagree: clicking a
 * surface ticks its row in the tree, and clicking that row rings the surface.
 * @param {string|null} uuid
 * @param {boolean} add ctrl-click, which adds instead of replacing
 */
function selectMaterial(uuid, add = false) {
  selection.choose(uuid, "material", add);
  // With the handles out, picking is aiming them rather than asking about
  // matter, so the pane stays put and the gizmo moves to what was just chosen.
  if (editMode) {
    setEditMode(editMode);
    return;
  }
  // Picking a surface is a question about its matter, so show the answer,
  // unless the panel is already showing a pane that says something about the
  // selection, in which case moving it under the pointer is the surprise.
  if (selection.material && !SELECTION_PANES.has(currentPane())) showPane("matter");
}

/** Panes that already answer a question about what is selected. */
const SELECTION_PANES = new Set(["matter", "scene", "retopo", "groups", "object"]);

/**
 * Everything that has to be repainted when the selection moves.
 *
 * One subscription rather than a call after each of the dozen places that
 * change it: the list that forgets to repaint is the one nobody notices until a
 * row stays lit on a material that is no longer chosen.
 *
 * A pinned part is cleared here too. It used to survive every later pick made
 * anywhere else, because only the parts list itself ever unset it: choosing a
 * mesh in the tree, or a surface in the viewport, changed `selection` and left
 * `selectedPart` exactly as it was, so `editTarget` kept answering with the old
 * part and the handles never moved. The parts list still gets its pin, by
 * setting it back *after* it clears the selection below.
 */
selection.subscribe(() => {
  selectedPart = null;
  paintMaterialList();
  paintTree();
  retopo?.onSelection?.();
  followDecorSelection();
  paintTransformPanel();
  if (editMode) setEditMode(editMode);
});

/**
 * The panel follows the row that was just clicked.
 *
 * The decor panel used to hold its own idea of what was selected, in
 * `decorSelection`, set only by its own list. Clicking a light anywhere else
 * changed nothing, which was tolerable while "anywhere else" did not exist and
 * is not now that the lights are rows of the same list as the meshes.
 *
 * One direction only: `selection` decides, this reads. The reverse — the panel
 * writing back into the selection — is what would make the two disagree again,
 * and there is nothing it could say that the click had not already said.
 */
function followDecorSelection() {
  const picked = selection.primary;
  /*
   * Nothing selected means nothing to act on, so the handles go.
   *
   * They used to survive an empty selection: clicking off a model left a gizmo
   * standing in the middle of the viewport, attached to whatever had been
   * chosen last, ready to move something the person had just stopped pointing
   * at. Every kind of handle at once — the object's, the stand's, a light's, the
   * fog's — because "which one is out" is not a question anybody should have to
   * answer before clicking on empty space.
   */
  if (!picked) {
    if (editMode) setEditMode(null);
    setGizmoMode(null);
    setLightGizmoMode(null);
    viewer.showLightHelper(null);
    viewer.setFogState({ selected: false });
    viewer.setGizmo(null);
    paintTransformPanel();
    return;
  }
  const key = decorKey(picked.id);
  if (picked.kind === "light") selectDecorItem({ type: "light", id: Number(key) });
  else if (picked.kind === "stand") selectDecorItem({ type: "pedestal" });
  else if (picked.kind === "bg") selectDecorItem({ type: "background", kind: key });
  else if (picked.kind === "fog") {
    // The fog's look is set in the Effets card, so that is where choosing it
    // goes — but its *place* is set here, with the same handles as everything
    // else that has one.
    viewer.showLightHelper(null);
    viewer.setFogState({ selected: true });
    viewer.setGizmo("translate", null, viewer.fogHandle());
    showPane("effects");
    return;
  } else {
    viewer.setFogState({ selected: false });
    return;
  }
  viewer.setFogState({ selected: false });
  // The parameters of the thing just chosen, without a second click on a tab to
  // go and find them.
  showPane("decor");
}

function highlightSelection() {
  const uuid = selection.material;
  if (!uuid || !viewer.current) {
    viewer.highlight(null);
    return;
  }
  viewer.highlight(channels.usersOf(uuid).meshes);
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
  if (!tex) return t("pane.textureNone");
  if (tex.name) return tex.name;
  const src = (tex.image && tex.image.src) || "";
  // Packaged formats hand over their images with no name and a blob URL
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return t("pane.textureEmbedded");
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
  if (!src) return tex?.image ? t("pane.textureInFile") : t("pane.textureUnknownSource");
  if (src.startsWith("blob:") || src.startsWith("data:")) return t("pane.textureInFile");
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
    markDirty();
    // The channel views hold copies built from the old material
    channels.refresh();
    showStats(viewer.stats());
    paintMaterialList();
  } catch (e) {
    $("stats").title = t("pane.textureUnreadableTitle").replace("{name}", picked.name);
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
  const slots = present.length ? present : [["map", "map.albedo"]];

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
    role.textContent = t(label);
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
    eye.title = hidden ? t("map.putBack") : t("map.takeOut");
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

  /*
   * The four numbers that decide whether a surface can be read at all.
   *
   * They were in Retopo's own panel, on a tab of its own, which is one of the
   * places the interface had split in two: the maps were listed here and the
   * strength of those maps was set somewhere else, in a panel that only existed
   * while a mode was open. One material, one place.
   *
   * Turning the normal down to nothing is the point of the third one: it is how
   * you find out whether the shape you are judging is geometry or a picture of
   * geometry, and that is the question that decides a triangle budget.
   */
  const NUMBERS = [
    [t("map.metalness"), "metalness", 0, 1, 0.01],
    [t("map.roughness"), "roughness", 0, 1, 0.01],
    [t("map.normal"), "normalScale", 0, 2, 0.05],
    [t("map.emissive"), "emissiveIntensity", 0, 4, 0.05],
  ];
  for (const [label, key, min, max, step] of NUMBERS) {
    if (!(key in material) || material[key] === undefined || material[key] === null) continue;
    // normalScale is a Vector2 where the others are numbers, so it is read and
    // written through the one axis that matters rather than assumed to be one.
    const vector = key === "normalScale";
    slider(label, vector ? material[key].x : material[key], min, max, step, (v) => {
      if (vector) material[key].set(v, v);
      else material[key] = v;
    });
  }

  // Only the settings this material actually has: an occlusion strength means
  // nothing without an occlusion map.
  if (material.aoMap) {
    slider(t("mat.aoIntensity"), material.aoMapIntensity ?? 1, 0, 2, 0.05, (v) => {
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
    slider(t("mat.thickness"), material.thickness ?? 0, 0, span / 2, span / 200, (v) => {
      material.thickness = v;
    });
  }

  // Presets repair what an exporter lost. They are not a list of material
  // types: the file decides what a thing is, and each of these can be undone.
  const presets = document.createElement("div");
  presets.className = "map-row";
  const label = document.createElement("span");
  label.className = "map-role";
  label.textContent = t("mat.preset");
  const group = document.createElement("div");
  group.className = "segment";
  for (const [name, text] of [
    ["verre", "mat.presetGlass"],
    ["liquide", "mat.presetLiquid"],
    ["metal", "mat.presetMetal"],
    ["irise", "mat.presetIridescent"],
    ["verni", "mat.presetVarnish"],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg";
    b.textContent = t(text);
    b.dataset.i18n = text;
    b.addEventListener("click", () => {
      const bounds = viewer.boxHelper.box;
      const next = applyPreset(material, name, {
        span: bounds.isEmpty() ? 1 : bounds.max.distanceTo(bounds.min),
      });
      channels.swapMaterial(uuid, next);
      markDirty();
      // The substitute takes the selection with it, so the panel goes on showing
      // the surface you were working on rather than emptying itself.
      selection.set([[next.uuid, "material"]]);
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
    revert.textContent = t("mat.revert");
    revert.dataset.i18n = "mat.revert";
    revert.addEventListener("click", () => {
      const original = channels.restoreMaterial(uuid);
      markDirty();
      if (original) selection.set([[original.uuid, "material"]]);
      else paintMaterialList();
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

  for (const {
    uuid, name, textured, alphaLost, invisible, deadVertexColors, hidden, triangles, map, color,
  } of list) {
    const row = document.createElement("div");
    row.className = "mat-row";

    // Defects the file declares but cannot deliver, named rather than hidden
    const defect = alphaLost
      ? t("mat.defectAlpha")
      : invisible
        ? t("mat.defectInvisible")
        : deadVertexColors
          ? t("mat.defectDeadColours")
          : null;

    // Clicking the name opens its textures and rings the meshes it covers: a
    // list of names never says which part of the model each one is.
    const label = document.createElement("button");
    label.type = "button";
    label.className = "mat-name";
    label.textContent = defect ? `${name} ⚠` : name;
    label.classList.toggle("warn", !!defect);
    label.classList.toggle("selected", selection.has(uuid));
    label.title = defect
      ? `${name} : ${defect}`
      : textured
        ? t("mat.texturedTitle").replace("{name}", name)
        : name;
    label.addEventListener("click", (e) => selectMaterial(uuid, e.ctrlKey || e.metaKey));

    /*
     * A square of the material itself, before its name.
     *
     * A list of names says nothing about what each one covers: "Material.003"
     * and "lambert2" are the two most common names in the world and neither
     * describes a surface. The base colour map answers it at a glance, and a
     * flat swatch of the diffuse colour answers it for materials that have no
     * map at all — which is the case the name is least likely to help with.
     */
    const chip = document.createElement("span");
    chip.className = "mat-chip";
    if (map?.image) {
      // The decoded image, drawn small. Reusing the texture's own image avoids
      // decoding a second copy of something already in memory, which on a model
      // with a dozen 4K maps is the difference between instant and not.
      const cv = document.createElement("canvas");
      cv.width = cv.height = 28;
      const g = cv.getContext("2d");
      try {
        // The checker goes *into* the canvas, under the image, rather than into
        // the stylesheet: an inline background-image beats a stylesheet one, so
        // a CSS checker behind an inline texture would never be seen at all.
        for (let y = 0; y < 28; y += 7) {
          for (let x = 0; x < 28; x += 7) {
            g.fillStyle = ((x + y) / 7) % 2 ? "#23272f" : "#1a1d23";
            g.fillRect(x, y, 7, 7);
          }
        }
        g.drawImage(map.image, 0, 0, 28, 28);
        chip.style.backgroundImage = `url(${cv.toDataURL()})`;
        chip.classList.add("has-map");
      } catch {
        // A compressed or data texture has no drawable image. The swatch below
        // is the fallback rather than an empty square pretending to be one.
        chip.style.background = color || "#3a3f48";
      }
    } else {
      chip.style.background = color || "#3a3f48";
    }
    chip.title = textured ? t("mat.baseColour") : t("mat.flatColour");

    // How many triangles this material is responsible for. In the inspector it
    // is a curiosity; in Retopo it is the number that says where a budget will
    // actually go, and which material is worth hiding before a restricted run.
    const count = document.createElement("span");
    count.className = "mat-count";
    count.textContent = triangles ? num(triangles) : "";
    count.title = triangles ? t("pane.trisCountTitle").replace("{n}", num(triangles)) : "";

    /*
     * One button for the mode, not two.
     *
     * A segment holding PBR and Unlit spends the width of both on a choice with
     * two positions, on every row, in a column 276 pixels wide — so the names,
     * which are the only thing telling one row from another, were squeezed to
     * eight characters and an ellipsis. One button showing where it currently is
     * says the same thing and gives the width back.
     */
    const group = document.createElement("div");
    group.className = "mat-tools";
    const mode = channels.channelFor({ uuid }, currentChannel === "unlit" ? "unlit" : "shaded");
    const lit = document.createElement("button");
    lit.type = "button";
    lit.className = "mat-mode" + (mode === "unlit" ? " unlit" : "");
    lit.textContent = mode === "unlit" ? "Unlit" : "PBR";
    lit.title =
      mode === "unlit"
        ? t("mat.unlitTitle")
        : t("mat.pbrTitle");
    lit.addEventListener("click", () => {
      channels.setMaterialHidden(uuid, false);
      channels.setMaterialMode(uuid, mode === "unlit" ? "shaded" : "unlit");
      paintMaterialList();
    });
    group.appendChild(lit);

    // Nothing here repairs a broken material, but a slab across a face can at
    // least be taken out of the way while the rest is inspected. The same eye as
    // the outliner's, because it is the same act on the same thing.
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "tree-eye" + (hidden ? " off" : "");
    hide.textContent = hidden ? "◌" : "◉";
    hide.title = hidden ? t("mat.showAgain") : t("mat.hideFromView");
    hide.addEventListener("click", () => {
      channels.setMaterialHidden(uuid, !hidden);
      paintMaterialList();
    });
    group.appendChild(hide);

    row.classList.toggle("muted", hidden);
    row.append(chip, label, count, group);
    holder.appendChild(row);
    if (uuid === selection.material) holder.appendChild(textureBlock(uuid));
  }
  highlightSelection();
}

function stepChannel(delta) {
  const i = CHANNELS.findIndex((c) => c.id === currentChannel);
  const next = (i + delta + CHANNELS.length) % CHANNELS.length;
  applyChannel(CHANNELS[next].id);
}

/**
 * Each channel gets a colour, and it is the colour of the thing it shows.
 *
 * Thirteen buttons in one grey is thirteen buttons you read. A normal map is
 * violet because that is what a normal map looks like; roughness and metalness
 * are the two ends of a grey scale; emissive is the colour of light. Once the
 * association is made, the grid is aimed at rather than read.
 */
const CHANNEL_TINT = {
  shaded: "#ffffff",
  unlit: "#ffd9a0",
  albedo: "#ff9f7a",
  normalMap: "#8f9dff",
  roughness: "#c8ccd4",
  metalness: "#9fd8ff",
  ao: "#8a8f99",
  emissive: "#ffe066",
  opacity: "#7ee0c0",
  normalGeom: "#b08cff",
  uv: "#6ad4ff",
  clay: "#c9a98a",
  clayUnlit: "#a8917a",
};

for (const c of CHANNELS) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.id = c.id;
  b.style.setProperty("--tint", CHANNEL_TINT[c.id] || "#9aa6b8");
  const img = document.createElement("img");
  img.className = "channel-thumb";
  img.alt = "";
  const label = document.createElement("span");
  label.textContent = t(c.labelKey);
  b.append(img, label);
  b.addEventListener("click", () => applyChannel(c.id));
  /*
   * Hovering shows the channel on the model itself.
   *
   * The tile is twenty-eight pixels, which is enough to tell one channel from
   * another and nowhere near enough to *read* one: whether a roughness map is
   * usable, whether a normal map is inverted, whether the UVs are a mess are all
   * questions about the model at full size. So the pointer applies it to the
   * viewport for as long as it stays, and the previous one comes back when it
   * leaves — a look costs no click and no undo.
   */
  b.addEventListener("pointerenter", () => peekChannel(c.id));
  b.addEventListener("pointerleave", () => peekChannel(null));
  // A pointer never arrives on a touch screen or from the keyboard.
  b.addEventListener("focus", () => peekChannel(c.id));
  b.addEventListener("blur", () => peekChannel(null));
  $("channels").appendChild(b);
}
// The channel list is built once but its words change with the language.
window.addEventListener("i18n", () => {
  for (const b of $("channels").children) {
    const c = CHANNELS.find((x) => x.id === b.dataset.id);
    if (c) b.querySelector("span").textContent = t(c.labelKey);
  }
  paintViewbar();
  outliner?.paint();
  // Lists and readouts built in code rather than written in the markup:
  // `applyStatic` cannot reach a string that was set once with `textContent`.
  paintOrientation();
  showDimensions();
  paintMaterialList();
  paintParts();
  updateDecorSelectedLabel();
  paintSaveButtons();
  void refreshShellState();
});
applyChannel("shaded");

/**
 * Show a channel on the model while the pointer is over its tile.
 *
 * Only the picture changes: `channels.apply` rather than `applyChannel`, so the
 * toolbar, the panel, the wireframe and `currentChannel` are all left alone. A
 * peek that edited the state would be a click, and leaving the tile would have
 * to undo something rather than simply stop.
 *
 * `null` puts back whatever is actually chosen — read at that moment rather than
 * remembered on entry, so clicking a tile while hovering it leaves the new
 * channel on instead of reverting to the one before.
 */
let peeking = null;

function peekChannel(id) {
  if (!viewer.current) return;
  if (id === peeking) return;
  peeking = id;
  channels.apply(id || currentChannel);
  viewer.invalidate();
}

/**
 * A preview of the model per channel, all thirteen.
 *
 * Each one swaps a stand-in material onto every mesh, renders offscreen at
 * thirty-two pixels, and swaps back — so drawing all of them in the same breath
 * as the load is thirteen material passes between dropping a file and seeing it.
 * They are drawn *after* the load instead, one per turn of the event loop, which
 * costs the same total and none of it before the model is on screen.
 *
 * On a timer rather than on `requestAnimationFrame`. This is work, not
 * animation: rendering here is on demand, so there is no frame to hang it off,
 * and rAF stops firing altogether in a background tab — a load in a tab nobody
 * is looking at would come back to thirteen blank tiles that never fill.
 *
 * Cancelled and restarted on the next load: they are pictures of a model that is
 * no longer there.
 */
let thumbRun = 0;

function paintChannelThumbs() {
  const run = ++thumbRun;
  const ids = CHANNELS.map((c) => c.id);
  const step = () => {
    // A newer load, or a closed document.
    if (run !== thumbRun || !viewer.current) return;
    // A peek is in progress: a preview drawn now would be a picture of the peek
    // on every remaining tile. Wait it out rather than racing it.
    if (peeking) {
      setTimeout(step, 120);
      return;
    }
    const id = ids.shift();
    if (!id) return;
    const button = $("channels").querySelector(`[data-id="${id}"]`);
    if (button) {
      channels.apply(id);
      button.querySelector(".channel-thumb")?.setAttribute("src", viewer.preview(32));
    }
    if (ids.length) setTimeout(step, 0);
    else {
      channels.apply(currentChannel);
      viewer.invalidate();
    }
  };
  setTimeout(step, 0);
}

/** A new model: blank every tile, then fill them again behind the first frame. */
function forgetChannelThumbs() {
  thumbRun++;
  for (const b of $("channels").children) {
    b.querySelector(".channel-thumb")?.removeAttribute("src");
  }
  if (viewer.current) paintChannelThumbs();
}

// --- display toggles ------------------------------------------------------

// Every display choice is remembered: a viewer that forgets the grid is off
// makes the user turn it off again at each launch.
/**
 * The wireframe overlay, fetched the first time anyone asks for lines.
 *
 * Lazy for a reason that is not only startup weight: preparing a geometry for
 * the overlay un-indexes it, which triples its vertex buffer and cannot be
 * undone. A session that never switches the wireframe on never pays either
 * cost, and the module is not in the startup bundle at all, which matters here
 * more than usual, this executable also being the Explorer thumbnail provider.
 */
let wire = null;
let wireArriving = null;

async function wakeWire() {
  if (wire) return wire;
  if (wireArriving) return wireArriving;
  wireArriving = import("./viewer/wire.js")
    .then((m) => {
      const uniforms = m.makeWireUniforms();
      wire = {
        uniforms,
        patch: (material) => m.patchWire(material, uniforms),
        // Idempotent: a geometry already carrying the attributes is left alone,
        // so a result's quad mask survives the switch being flicked.
        prepare: (object) => m.prepareWire(object),
        setColour: (light) => m.setWireColor(uniforms, light),
        // Geometry and materials in one call, with the data a run produced.
        // Retopo is the only caller that has any: the mask, the chart ids and
        // the per vertex deviation all come out of the engine.
        apply: (object, mask, charts, dev) =>
          m.applyWire(object, uniforms, mask, charts, dev),
        // One group id per superface, as a small texture. Groupes calls this on
        // every move of its slider, which is why it is a lookup rather than a
        // vertex attribute: see `setGroupLut`.
        setGroupLut: (labels) => m.setGroupLut(uniforms, labels),
        setSide: m.setSide,
      };
      wire.setColour(!$("opt-wire-dark").checked);
      // The channel view is what decides which material a mesh draws with, so it
      // is what has to know: otherwise every inspection channel hands out a
      // stand-in nobody patched and the lines vanish without a word.
      channels.useWire(wire);
      return wire;
    })
    .finally(() => {
      wireArriving = null;
    });
  return wireArriving;
}

/**
 * Turn the lines on or off, from wherever the ask came from.
 *
 * One function, so the checkbox, the `W` key and Retopo's bar cannot disagree
 * about what is on screen.
 */
/*
 * Which ask is the current one.
 *
 * Switching *on* has to wait for a module and then prepare every geometry;
 * switching *off* is an assignment. So two quick toggles finished out of order:
 * the off ran to completion while the on was still awaiting, then the on's
 * continuation resumed and turned the lines back on over a box that read
 * unticked. A counter, checked after every await, is what makes the last ask win
 * rather than the fastest one.
 */
let wireAsk = 0;

async function setWireframe(on, remember = true) {
  const ask = ++wireAsk;
  $("opt-wireframe").checked = on;
  $("opt-wire-dark-row").hidden = !on;
  if (on) {
    const w = await wakeWire();
    if (ask !== wireAsk) return;
    for (const part of viewer.parts || []) w.prepare(part.object);
    // Re-hand the materials so the ones already on the meshes go through the
    // patch. Without this the lines only appear after the next channel change.
    channels.apply(currentChannel);
  }
  channels.setWireframe(on);
  retopo?.onWireframe?.(on);
  if (remember) prefs.set("wireframe", on);
  paintViewbar();
}

$("opt-wireframe").addEventListener("change", (e) => setWireframe(e.target.checked));
$("opt-wire-dark").addEventListener("change", (e) => {
  wire?.setColour(!e.target.checked);
  viewer.invalidate();
  prefs.set("wireDark", e.target.checked);
});
/**
 * Show the floor, or do not, from any of the three places that ask.
 *
 * The pane's chip, the button in the bar and Maj+G are one switch with three
 * handles, so the state lives here and all three read it back through
 * `paintViewbar`. Written three times over, the bar would have gone on saying
 * the floor was there after the keyboard had taken it away.
 */
function setGrid(on, remember = true) {
  $("opt-grid").checked = on;
  // The copy in the Apparence card, next to the colour the grid is drawn in.
  // Written here rather than kept in step by hand, because a second checkbox
  // for one state is only tolerable while it cannot disagree with the first.
  const alt = $("opt-grid-default");
  if (alt) alt.checked = on;
  viewer.setGrid(on);
  if (remember) prefs.set("grid", on);
  paintViewbar();
}

$("opt-grid").addEventListener("change", (e) => setGrid(e.target.checked));
$("opt-grid-default")?.addEventListener("change", (e) => setGrid(e.target.checked));
$("vb-grid").addEventListener("click", () => {
  const on = !isPressed($("vb-grid"));
  setGrid(on);
  toast(t(on ? "toast.gridShown" : "toast.gridHidden"));
});
$("opt-bounds").addEventListener("change", (e) => {
  viewer.setBounds(e.target.checked);
  prefs.set("bounds", e.target.checked);
});
$("opt-skeleton").addEventListener("change", (e) => {
  viewer.setSkeleton(e.target.checked);
  prefs.set("skeleton", e.target.checked);
});
$("opt-lights-visible").addEventListener("change", (e) => {
  viewer.setAlwaysShowLights(e.target.checked);
  prefs.set("lightsAlwaysVisible", e.target.checked);
});

/**
 * The accent, which is a preference of the application and not of a scene.
 *
 * Written to the root element rather than to `body`, so it is in scope for
 * everything — including the markup a lazily-loaded mode builds and parks in a
 * detached div. One attribute, one custom property, and every highlight in the
 * stylesheet already reads it.
 */
const ACCENTS = new Set(["cyan", "orange", "green", "white", "custom"]);

function setAccent(name, remember = true) {
  const accent = ACCENTS.has(name) ? name : "cyan";
  const root = document.documentElement;
  root.dataset.accent = accent;
  // A custom hue is written as an inline property, which beats the attribute
  // rules; the named ones clear it so the stylesheet is back in charge.
  if (accent === "custom") root.style.setProperty("--accent", $("accent-colour").value);
  else root.style.removeProperty("--accent");
  $("accent-custom-row").hidden = accent !== "custom";
  const box = document.querySelector(`#accent-chips input[value="${accent}"]`);
  if (box) box.checked = true;
  if (remember) prefs.set("accent", accent);
}

for (const box of document.querySelectorAll("#accent-chips input")) {
  box.addEventListener("change", () => setAccent(box.value));
}
$("accent-colour").addEventListener("input", (e) => {
  $("accent-custom-chip").style.setProperty("--tint", e.target.value);
  prefs.set("accentColour", e.target.value);
  setAccent("custom");
});

/**
 * The three surfaces somebody judging colour is entitled to set.
 *
 * The interface, because a tinted chrome tints the judgement of what it frames.
 * The floor, because its two greys were written into the grid twice and rebuilt
 * from scratch on every reframe. And the backdrop — which is the *same state* as
 * the picker under Fonds rather than a copy of it: it belongs to the scene, so
 * that is where it lives, and it is reachable here because this is where a
 * person comes to change how things look.
 */
function setUiColour(hex, remember = true) {
  document.documentElement.style.setProperty("--ui", hex);
  $("ui-colour").value = hex;
  if (remember) prefs.set("uiColour", hex);
}
$("ui-colour").addEventListener("input", (e) => setUiColour(e.target.value));
$("ui-colour-reset").addEventListener("click", () => setUiColour("#1c1c1c"));

function setGridColour(hex, remember = true) {
  viewer.setGridColour(hex);
  $("grid-colour").value = hex;
  if (remember) prefs.set("gridColour", hex);
}
$("grid-colour").addEventListener("input", (e) => setGridColour(e.target.value));
$("grid-colour-reset").addEventListener("click", () => setGridColour("#3a4150"));

// One state, two doors. Each writes the viewer and repaints the other, so the
// two pickers cannot come to disagree about the colour they both name.
$("canvas-colour").addEventListener("input", (e) => {
  $("bg-colour").value = e.target.value;
  viewer.setBackgroundColour(e.target.value);
  prefs.set("backgroundColour", e.target.value);
});
$("opt-exposure").addEventListener("input", (e) => {
  viewer.setExposure(Number(e.target.value));
  prefs.set("exposure", Number(e.target.value));
});
// A preference rather than a scene setting: it is about how you like to work,
// so it follows you into the next model rather than being saved with this one.
$("opt-dim-select").addEventListener("change", (e) => {
  viewer.setDimOnSelect(e.target.checked);
  prefs.set("dimOnSelect", e.target.checked);
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
async function exportModel(format = "glb", { overwrite = false } = {}) {
  if (!viewer.current) return;
  const note = $("export-note");
  note.textContent = "Export en cours…";
  try {
    const stem = (currentTitle || "modele").replace(/\.[^.]+$/, "");
    let bytes;
    let ext;
    let mime;

    if (format === "obj") {
      const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
      bytes = new TextEncoder().encode(new OBJExporter().parse(viewer.root));
      ext = "obj";
      mime = "text/plain";
    } else if (format === "stl") {
      const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
      const result = new STLExporter().parse(viewer.root, { binary: true });
      bytes = new Uint8Array(result.buffer);
      ext = "stl";
      mime = "model/stl";
    } else {
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const { withoutWireAttributes } = await import("./viewer/wire.js");
      // The group, not the object inside it. The orientation buttons and the
      // handles both write to the group, so exporting the object alone wrote out
      // a model still lying on its side after it had been stood up.
      //
      // And without the wireframe overlay's attributes. They are shader
      // scaffolding, written out as the custom semantics `_ABARY`, `_AEDGES`,
      // `_ACHART` and `_ADEV`; a reader is entitled to refuse a file over a
      // semantic it does not know, and some do. Every glb this application wrote
      // after the wireframe had once been switched on carried all four.
      bytes = new Uint8Array(
        await withoutWireAttributes(viewer.root, () =>
          new GLTFExporter().parseAsync(viewer.root, {
            binary: true,
            animations: viewer.clips || [],
            // Skinned models need their bones, and three drops them otherwise
            includeCustomExtensions: true,
          })
        )
      );
      ext = "glb";
      mime = "model/gltf-binary";
    }
    const name = `${stem}.${ext}`;

    if (tauri) {
      const path = overwrite
        ? openedPath
        : await tauri.dialog.save({
            defaultPath: name,
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
          });
      if (!path) {
        note.textContent = "";
        return;
      }
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      clearDirty();
      note.textContent = writtenNote(path, bytes.length);
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      clearDirty();
      note.textContent = `${name} (${(bytes.length / 1048576).toFixed(1)} Mo)`;
    }
  } catch (e) {
    note.textContent = `Export impossible : ${e.message || e}`;
    console.warn(`[albedo] export ${format}:`, e);
  }
}

$("btn-export").addEventListener("click", () => exportModel("glb"));
$("btn-export-obj").addEventListener("click", () => exportModel("obj"));
$("btn-export-stl").addEventListener("click", () => exportModel("stl"));

// --- copy and paste between documents -------------------------------------
// A mesh (with its material) travels as a GLB held in memory, so it can cross
// from one open file to another without touching disk. The same exporter that
// writes a file writes the clipboard, so a pasted mesh is byte for byte what
// an export would have produced.
let clipboardGLB = null;

async function copySelection() {
  if (!viewer.current) return;
  const target = selectedPart?.object || viewer.root;
  try {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const { withoutWireAttributes } = await import("./viewer/wire.js");
    // Same reason as the export: what goes on the clipboard is read back by
    // `paste`, and carrying the overlay's custom semantics through a round trip
    // is carrying them into whatever the paste is dropped into.
    const result = await withoutWireAttributes(target, () =>
      new GLTFExporter().parseAsync(target, { binary: true })
    );
    clipboardGLB = new Uint8Array(result);
    toast(t("toast.copied"));
  } catch (e) {
    console.warn("[albedo] copie :", e);
    toast(t("toast.copyFailed"));
  }
}

async function pasteClipboard() {
  if (!clipboardGLB || !viewer.current) return;
  setBusy(true);
  try {
    const url =
      URL.createObjectURL(new Blob([clipboardGLB], { type: "model/gltf-binary" })) + "#.glb";
    const { object } = await loadModel(url, { renderer: viewer.renderer });
    URL.revokeObjectURL(url);
    normalizeMaterials(object);
    fixColorSpaces(object);
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    const entry = viewer.addPart(object, t("toast.pastedName"));
    markDirty();
    selectedPart = entry;
    channels.absorb();
    if ($("opt-wireframe").checked) await setWireframe(true, false);
    applyChannel(currentChannel);
    paintParts();
    paintMaterialList();
    paintTree();
    showStats(viewer.stats());
    showDimensions();
    toast(t("toast.pasted"));
  } catch (e) {
    console.warn("[albedo] collage :", e);
    toast(t("toast.pasteFailed"));
  } finally {
    setBusy(false);
  }
}

$("part-copy").addEventListener("click", copySelection);
$("part-paste").addEventListener("click", pasteClipboard);

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
  $("shot-note").textContent = t("pane.shotNote")
    .replace("{w}", shot.width)
    .replace("{h}", shot.height);
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
    const name = (currentTitle || "albedo").replace(/\.[^.]+$/, "") + ".png";
    if (tauri) {
      const path = await tauri.dialog.save({
        defaultPath: name,
        filters: [{ name: t("dlg.pngImage"), extensions: ["png"] }],
      });
      if (!path) return;
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      // The work is on disk, so leaving no longer throws it away.
      clearDirty();
      note.textContent = writtenNote(path, bytes.length);
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

// --- the shared panel -----------------------------------------------------

/**
 * One subject at a time, and one navigation for every mode.
 *
 * The panes are attached to what is being looked at rather than to the mode
 * doing the looking: the list of materials in a model does not change according
 * to whether you are inspecting it or decimating it, so it is one tab and not
 * one per mode. A mode chooses which tab opens first and which action bar shows
 * underneath; it no longer owns a panel.
 */

/**
 * A saved pane name from before the panel became shared.
 *
 * Applied to the preference and nowhere else. Putting it inside `showPane` was a
 * quiet disaster: `scene` used to name the editing pane and now names the tree,
 * so every live call asking for the tree was silently redirected to Objet and
 * the Scène tab did nothing at all when clicked.
 */
const migratePane = (name) =>
  ({ render: "view", scene: "object", camera: "photo" })[name] || name;

/** Work only done while its own pane is on screen. */
const PANE_WAKE = {
  // The preview is a render; it is only worth making while it is visible.
  photo: () => paintShotPreview(),
  // Same reasoning, cheaper subject: the shell registration is two registry
  // reads across the bridge, and nobody needs the answer until they are looking
  // at the panel that shows it.
  object: () => refreshShellState(),
  // No `scene` entry any more: the list is not a pane, it is above them all, so
  // it is woken with the panel rather than with a tab.
};

function showPane(name, remember = true) {
  // A pane that is not there cannot be shown, and a saved preference naming one
  // must not leave the panel blank with every tab unlit.
  if (!document.querySelector(`div.pane[data-pane="${name}"]`)) name = "view";
  PANE_WAKE[name]?.();
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.pane === name);
  }
  for (const pane of document.querySelectorAll(".pane")) {
    pane.classList.toggle("active", pane.dataset.pane === name);
  }
  // A mode's own pane is not remembered: reopening the application into one
  // while the mode itself is shut would show controls that drive nothing.
  if (remember && name !== "retopo" && name !== "groups") prefs.set("pane", name);
}
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => showPane(tab.dataset.pane));
}

/** Which pane is on screen right now. */
const currentPane = () =>
  document.querySelector("div.pane.active")?.dataset.pane || "view";

/**
 * The outliner: everything in the scene, in one list, above the tabs.
 *
 * A module and a stylesheet rather than markup in the page, for the reason that
 * outranks the rest: this executable is also the Explorer thumbnail provider,
 * one process per file, and the list renders a portrait per row.
 *
 * It is no longer woken by a tab, because it no longer has one — it is on
 * screen whichever panel is open. So the guard is said out loud instead of
 * being inherited from the fact that a headless run never clicks anything: a
 * thumbnail job renders one file and exits, and must not build a list about it.
 */
let outliner = null;
let outlinerArriving = null;

function wakeTree() {
  if (outliner || outlinerArriving || headless) return;
  outlinerArriving = import("./ui/outliner.js")
    .then(({ createOutliner }) => {
      outliner = createOutliner({
        host: $("scene-tree"),
        viewer,
        channels,
        // Reused rather than reimplemented: picking a file, reading it and making
        // the incoming texture inherit the outgoing one's wrapping and transform
        // is an afternoon of work that already exists and is already debugged.
        swapTexture,
        onNotice: toast,
        actions: {
          addLight: () => {
            const entry = viewer.addLight("directional", {});
            saveLights();
            selection.choose(decorId("light", entry.id), "light");
          },
          pickPedestal: () => $("btn-pedestal")?.click(),
          removePedestal: () => dropPedestal(),
          setBackground: (kind) => useEnvironment(kind),
          setBackgroundVisible: (on) => {
            $("env-background").checked = on;
            viewer.showEnvBackground = on;
            viewer.applyBackground();
            prefs.set("environmentBackground", on);
          },
          onLightsChanged: () => saveLights(),
          onLightRenamed: () => saveLights(),
          // Framing what was just chosen. Not for a ctrl-click, which is
          // building a set rather than looking at one thing.
          focus: ({ object, point } = {}) => viewer.focusOn(object, { point }),
          setEnvLighting: (on) => {
            $("env-lighting").checked = on;
            viewer.setEnvironmentLighting(on);
          },
          fogState: () => ({
            on: !!postState.fog?.on,
            colour: postState.fog?.colour || "#aebdd0",
            density: postState.fog?.density ?? 0,
          }),
          setFog: (on) => {
            $("fog-on").checked = on;
            $("fog-on").dispatchEvent(new Event("change", { bubbles: true }));
          },
        },
      });
      $("outliner-all")?.addEventListener("click", () => outliner.reveal());
      $("outliner-isolate")?.addEventListener("click", () => outliner.isolate());
    })
    /*
     * A failure here is loud, because it is otherwise invisible.
     *
     * The catch used to log and stop. The application carries on perfectly well
     * without the list — every panel still works — so a typo in the outliner
     * left it simply absent, with one red line in a console nobody has open, and
     * the panel looking like a design choice rather than a fault. Same shape as
     * `onOpenChange` swallowing its errors, which is already in the pitfalls.
     */
    .catch((e) => {
      console.error("[albedo] arbre de scène :", e);
      toast(t("toast.treeFailed"), 4000);
      $("scene-tree").innerHTML = `<p class="hint tree-empty">${t("tree.buildFailed")}</p>`;
    })
    .finally(() => {
      outlinerArriving = null;
    });
}

/** Repaint the list, if it has ever been built. */
function paintTree() {
  outliner?.paint();
}

// --- camera ---------------------------------------------------------------

/**
 * The same lens in millimetres.
 *
 * Degrees are what the renderer wants and what nobody thinks in. A 24×36 frame
 * is 24mm tall, so the focal length is half of that over the tangent of half the
 * vertical field — one number said two ways, derived rather than stored, so
 * there is no second control to fall out of step with the first.
 */
function paintFocal(deg) {
  const mm = 12 / Math.tan((deg * Math.PI) / 360);
  $("focal-value").textContent = `${Math.round(mm)} mm`;
}

$("opt-fov").addEventListener("input", (e) => {
  const deg = Number(e.target.value);
  viewer.setFov(deg);
  $("fov-value").textContent = `${deg}°`;
  paintFocal(deg);
  prefs.set("fov", deg);
});

// Framing and levelling: two things the camera does to itself, next to the lens
// that decides what they frame and level.
$("cam-frame").addEventListener("click", () => {
  if (!viewer.current) return;
  viewer.frameCurrent();
  toast(t("toast.cropped"));
});
$("cam-reset-roll").addEventListener("click", () => {
  viewer.camera.up.set(0, 1, 0);
  viewer.controls?.update?.();
  viewer.invalidate();
  toast(t("toast.levelled"));
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

const PANORAMA_KINDS = ["hdr", "exr", "png", "jpg", "jpeg", "webp"];

/**
 * Which backdrop is lit up, and which set of its controls is on screen.
 *
 * One function for four sources, called from every route in — the segment, the
 * list, a restore, a document switch. Four `hidden` assignments scattered over
 * three call sites is how a control ends up visible for a source it has nothing
 * to say about.
 */
function paintBackdropPanes(kind = viewer.envKind || "studio") {
  for (const [id, k] of [
    ["env-studio", "studio"], ["env-gradient", "gradient"],
    ["env-image", "image"], ["env-picture", "picture"],
  ]) {
    $(id)?.classList.toggle("active", k === kind);
  }
  $("gradient-editor").hidden = kind !== "gradient";
  $("env-image-tools").hidden = kind !== "image";
  $("env-framing").hidden = kind !== "image";
  $("backdrop-editor").hidden = kind !== "picture";
  paintEnvControls(kind);
}

/**
 * Which of the backdrop's controls apply to the source in force.
 *
 * "Fond visible" is hidden for the studio, because it does nothing there.
 * `applyBackground` has three branches and the studio matches none of them:
 * ticked or not, it lands on the same solid colour. The studio *is* a probe with
 * no picture — that is what distinguishes it from the other two — so a control
 * asking whether to draw it was a switch between a thing and itself.
 *
 * "Éclaire la scène" stays for every source and now means something for all
 * three: the probe obeys it as of `applyLighting`.
 *
 * Called from wherever the panel can become visible rather than only from
 * `useEnvironment`. Switching *to* the studio ran that function; starting a
 * session already in it did not, so the dead control was on screen for exactly
 * the people who never changed the backdrop.
 */
function paintEnvControls(kind = viewer.envKind || "studio") {
  $("env-background").closest("label").hidden = kind === "studio";
  $("env-lighting").closest("label").hidden = false;
  /*
   * "Luminosité du fond" needs a backdrop made of pixels.
   *
   * `scene.backgroundIntensity` is read by exactly two shaders in three: the one
   * that draws a cube map and the one that draws a plane texture. A `Color`
   * background goes through `setClearColor` and never meets either, so the
   * slider is inert on the studio — which always draws the solid colour — and
   * equally inert on a gradient or an image whose backdrop has been switched
   * off, when the same solid colour is what is showing.
   */
  const drawsATexture = kind !== "studio" && viewer.showEnvBackground !== false;
  $("bg-brightness").closest("label").hidden = !drawsATexture;
  // And the same rule once more: with the environment switched off there is no
  // `scene.environment` for an intensity to scale.
  $("env-intensity").closest("label").hidden = viewer.envLighting === false;
}

/**
 * Switch what lights the scene and what sits behind it.
 *
 * `path` names a file to load. `ask` forces the picker, which is what the
 * Remplacer button wants and nothing else does.
 *
 * The order below is the whole of the fix for "it forgets my panorama": the
 * texture already in memory answers first, the saved path second, and the
 * picker only when neither can. Clicking Image used to go straight to the
 * picker every time, on the reasoning that a saved path may have moved — true,
 * but that is a reason to fall back to the picker when the load *fails*, not to
 * refuse to try.
 */
async function useEnvironment(kind, path, remember = true, { ask = false } = {}) {
  let source = path;
  let url = null;

  /*
   * The flat backdrop takes the same route as the panorama and stops short of
   * the lighting.
   *
   * Same order for finding a file — what is already loaded, then the saved path,
   * then the picker — because "it forgot my image" is the same complaint
   * whichever of the two is chosen.
   */
  if (kind === "picture") {
    const held = !ask && !source && viewer.backdropSource;
    if (!held) {
      if (!source && !ask) source = prefs.get("backdropPath") || null;
      if (!source) source = await pickFile("Images", ["png", "jpg", "jpeg", "webp", "bmp"]);
      if (!source) return;
      const link = tauri ? tauri.core.convertFileSrc(source) : source;
      if (!(await viewer.loadBackdrop(link))) {
        $("backdrop-file").textContent = t("pane.imageUnreadable");
        return;
      }
      if (remember && tauri) prefs.set("backdropPath", source);
    } else {
      viewer.envKind = "picture";
      viewer.composeBackdrop();
      viewer.applyLighting();
      source = prefs.get("backdropPath") || "";
    }
    $("backdrop-file").textContent = source ? fileLabel(source) : t("pane.imageLoaded");
    paintBackdropPanes(kind);
    if (remember) prefs.set("environment", kind);
    paintTree();
    return;
  }

  if (kind === "image") {
    const held = !ask && !source && viewer.panoramaSource;
    if (held) {
      // Still decoded and still held. `setEnvironment` re-adopts it with no url.
      source = prefs.get("environmentPath") || "";
    } else {
      if (!source && !ask) source = prefs.get("environmentPath") || null;
      if (!source) source = await pickFile(t("dlg.panoramas"), PANORAMA_KINDS);
      if (!source) return;
      url = tauri ? tauri.core.convertFileSrc(source) : source;
    }
  }

  const ok = await viewer.setEnvironment(kind, url);
  if (!ok) {
    // A remembered path that has moved or been deleted. Ask once, rather than
    // leaving the button dead with a message under it.
    if (kind === "image" && !ask) {
      const picked = await pickFile(t("dlg.panoramas"), PANORAMA_KINDS);
      if (picked) return useEnvironment("image", picked, remember);
    }
    $("env-file").textContent = t("pane.panoUnreadable");
    return;
  }
  $("env-file").textContent =
    kind === "image"
      ? fileLabel(source)
      : kind === "gradient"
        ? t("pane.gradientInternal")
        : t("pane.noPanorama");
  paintBackdropPanes(kind);
  if (!remember) return;
  prefs.set("environment", kind);
  // A blob URL from the browser fallback would not survive a restart
  if (kind === "image" && tauri) prefs.set("environmentPath", source);
}

$("env-studio").addEventListener("click", () => useEnvironment("studio"));
$("env-gradient").addEventListener("click", () => useEnvironment("gradient"));
// Whatever panorama is already there, without a question. The picker only
// appears when there is genuinely nothing to come back to.
$("env-image").addEventListener("click", () => useEnvironment("image", null));
$("env-picture").addEventListener("click", () => useEnvironment("picture", null));
$("backdrop-replace").addEventListener("click", () =>
  useEnvironment("picture", null, true, { ask: true })
);
$("backdrop-clear").addEventListener("click", () => {
  prefs.set("backdropPath", null);
  useEnvironment("studio");
});

/*
 * The picture's framing: across, up, how big, how soft.
 *
 * Written straight through to the viewer, which recomposes the canvas. There is
 * no cheaper path — the blur and the crop are drawing operations — but the
 * canvas is at most 2560 wide and a drag is a handful of them.
 */
for (const [id, key, unit] of [
  ["backdrop-zoom", "zoom", "×"], ["backdrop-x", "x", ""],
  ["backdrop-y", "y", ""], ["backdrop-blur", "blur", ""],
]) {
  $(id).addEventListener("input", (e) => {
    const value = Number(e.target.value);
    viewer.setBackdrop({ [key]: value });
    if (unit && $(`${id}-value`)) $(`${id}-value`).textContent = `${value.toFixed(1)}${unit}`;
    markDirty();
  });
}

$("bg-colour").addEventListener("input", (e) => {
  $("canvas-colour").value = e.target.value;
  viewer.setBackgroundColour(e.target.value);
  prefs.set("backgroundColour", e.target.value);
});
$("bg-colour-reset").addEventListener("click", () => {
  $("bg-colour").value = "#14161a";
  viewer.setBackgroundColour("#14161a");
  prefs.set("backgroundColour", "#14161a");
});
// Replacing is the one gesture that means "a different file", so it is the one
// that always asks.
$("env-replace").addEventListener("click", () => useEnvironment("image", null, true, { ask: true }));
$("env-clear").addEventListener("click", () => {
  prefs.set("environmentPath", null);
  useEnvironment("studio");
});
$("env-background").addEventListener("change", (e) => {
  viewer.showEnvBackground = e.target.checked;
  viewer.applyBackground();
  prefs.set("environmentBackground", e.target.checked);
  // Hiding the backdrop puts the solid colour back on screen, and the brightness
  // slider has nothing to act on again.
  paintEnvControls();
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
    at.title = t("pane.gradientStopTitle");
    at.addEventListener("input", () => {
      stop.at = Number(at.value);
      refreshGradient();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "seg";
    remove.textContent = "×";
    remove.title = t("pane.gradientRemoveTitle");
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
  paintEnvControls();
  // The list carries the same switch on its Environnement row.
  paintTree();
});
$("env-intensity").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  $("env-intensity-value").textContent = value.toFixed(1);
  viewer.setEnvironmentIntensity(value);
  prefs.set("environmentIntensity", value);
});

// --- the stand --------------------------------------------------------------

function setGizmoMode(mode) {
  for (const [id, m] of [
    ["giz-move", "translate"],
    ["giz-rotate", "rotate"],
    ["giz-scale", "scale"],
    ["giz-off", null],
  ]) {
    $(id)?.classList.toggle("active", m === mode);
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
  $(id)?.addEventListener("click", () => setGizmoMode(mode));
}

function setStandShading(mode, remember = true) {
  viewer.setPedestalShading(mode);
  $("stand-pbr")?.classList.toggle("active", mode !== "unlit");
  $("stand-unlit")?.classList.toggle("active", mode === "unlit");
  if (remember) prefs.set("pedestalShading", mode);
}
$("stand-pbr")?.addEventListener("click", () => setStandShading("shaded"));
$("stand-unlit")?.addEventListener("click", () => setStandShading("unlit"));

$("pedestal-refit")?.addEventListener("click", () => {
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
    $("btn-pedestal").textContent = t("pane.standDrop");
    $("btn-pedestal").dataset.i18n = "pane.standDrop";
    $("pedestal-tools").hidden = false;
    if (remember && tauri) prefs.set("pedestal", path);
    selectDecorItem({ type: "pedestal" }, { showHelper: remember });
    paintDecorTree();
  } catch (e) {
    $("pedestal-file").textContent = t("pane.standUnreadable");
    console.warn("[albedo] socle:", e);
  }
}

function dropPedestal() {
  viewer.clearPedestal();
  $("pedestal-file").textContent = t("pane.noStand");
  $("btn-pedestal").textContent = t("pane.standPick");
  $("btn-pedestal").dataset.i18n = "pane.standPick";
  $("pedestal-tools").hidden = true;
  setGizmoMode(null);
  prefs.set("pedestal", null);
  prefs.set("pedestalTransform", null);
  selectDecorItem({ type: "pedestal" });
  paintDecorTree();
}

$("pedestal-remove")?.addEventListener("click", () => dropPedestal());

$("btn-pedestal")?.addEventListener("click", async () => {
  if (viewer.pedestal) {
    dropPedestal();
    return;
  }
  const picked = await pickFile(t("dlg.models3d"), SUPPORTED);
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
  // The list is on screen whatever the pane, so it is built with the panel and
  // not with a tab. Here rather than at module scope because a headless
  // thumbnail run never reaches this function, which is the guard that keeps a
  // portrait-per-row list out of a one-file render process.
  wakeTree();
  showPane(migratePane(p.pane), false);
  $("shot-alpha").checked = p.shotAlpha;
  $("shot-grid").checked = p.shotGrid;
  $("shot-stand").checked = p.shotStand;
  setShotSize(p.shotWidth, p.shotHeight, false);
  $("clip-at").value = String(p.clipAt);
  viewer.setClipping({ at: p.clipAt });
  setClipping(p.clipAxis, false);
  $("opt-fov").value = String(p.fov);
  $("fov-value").textContent = `${p.fov}°`;
  paintFocal(p.fov);
  viewer.setFov(p.fov);
  if (p.projection !== "perspective") setProjection(p.projection, false);
  // Never read before: the checkbox stayed at the markup's unchecked default
  // (light lines) however dark the saved preference said, and `wakeWire` only
  // asks the checkbox, never `prefs`, when the wireframe first turns on.
  $("opt-wire-dark").checked = p.wireDark;
  wire?.setColour(!p.wireDark);
  $("opt-lights-visible").checked = p.lightsAlwaysVisible;
  viewer.setAlwaysShowLights(p.lightsAlwaysVisible);
  $("accent-colour").value = p.accentColour;
  $("accent-custom-chip").style.setProperty("--tint", p.accentColour);
  setAccent(p.accent, false);
  setUiColour(p.uiColour, false);
  setGridColour(p.gridColour, false);
  $("canvas-colour").value = p.backgroundColour || "#14161a";
  // Saved since the checkbox existed and never read back, so the grid came up
  // on at every launch whatever the last session had decided.
  setGrid(p.grid !== false, false);
  $("opt-dim-select").checked = !!p.dimOnSelect;
  viewer.setDimOnSelect(!!p.dimOnSelect);
  if (p.pedestal) usePedestal(p.pedestal, false);
  if (p.lights) viewer.applyLights(p.lights);
  // Setting `value` fires no input event, so the readouts would still be
  // showing the markup's defaults and quietly disagreeing with the sliders.
  refreshSliderValues();
  paintDecorTree();
  selectDecorItem({ type: "light", id: viewer.lights[0]?.id || 1 }, { showHelper: false });
}

/**
 * How the travel multiplier reads, at any size.
 *
 * It spans four orders of magnitude, so a fixed number of decimals is wrong at
 * one end or the other: ×0.01 needs two and ×100 needs none.
 */
function flySpeedLabel(scale) {
  return `×${scale >= 10 ? Math.round(scale) : scale.toFixed(scale < 1 ? 2 : 1)}`;
}

/**
 * Put the travel multiplier on the slider, which is logarithmic.
 *
 * The handle carries the exponent and the setting is ten to it, because the
 * useful range runs from a crawl to a hundred times the model's own pace and a
 * linear handle would spend nine tenths of its travel above ten.
 */
function paintFlySpeed(scale) {
  const el = $("fly-speed");
  if (el) el.value = String(Math.log10(scale));
  const out = $("fly-speed-value");
  if (out) out.textContent = flySpeedLabel(scale);
}

$("fly-speed")?.addEventListener("input", (e) => {
  // False: this handle has no need to be told what it just said.
  const scale = nav.setFlySpeed(10 ** Number(e.target.value), false);
  $("fly-speed-value").textContent = flySpeedLabel(scale);
  prefs.set("devices", deviceSnapshot());
});

/** The tuning of a device outlives the session that found it. */
function deviceSnapshot() {
  const s = nav.settings;
  return {
    flySpeed: s.flySpeed,
    padSensitivity: s.pad.sensitivity,
    padDeadzone: s.pad.deadzone,
    padInvertY: s.pad.invertY,
    spaceTranslation: s.space.translation,
    spaceRotation: s.space.rotation,
    spaceLockRoll: s.space.lockRoll,
    spaceInvert: { ...s.space.invert },
    spaceOn: { ...s.space.on },
    spaceGain: { ...s.space.gain },
  };
}

function restoreDevices() {
  const d = prefs.get("devices") || {};
  const s = nav.settings;
  if (d.flySpeed !== undefined) nav.setFlySpeed(d.flySpeed, false);
  paintFlySpeed(s.flySpeed);
  if (d.padSensitivity !== undefined) s.pad.sensitivity = d.padSensitivity;
  if (d.padDeadzone !== undefined) s.pad.deadzone = d.padDeadzone;
  if (d.padInvertY !== undefined) s.pad.invertY = d.padInvertY;
  if (d.spaceTranslation !== undefined) s.space.translation = d.spaceTranslation;
  if (d.spaceRotation !== undefined) s.space.rotation = d.spaceRotation;
  if (d.spaceLockRoll !== undefined) s.space.lockRoll = d.spaceLockRoll;
  if (d.spaceInvert) Object.assign(s.space.invert, d.spaceInvert);
  if (d.spaceOn) Object.assign(s.space.on, d.spaceOn);
  if (d.spaceGain) Object.assign(s.space.gain, d.spaceGain);
}

const TURNTABLE_SPEED = 0.5; // radians per second, a full turn in about twelve
function toggleTurntable(on) {
  const spinning = on ?? viewer.spin === 0;
  viewer.spin = spinning ? TURNTABLE_SPEED : 0;
  setPressed($("btn-turntable"), spinning);
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
  // The name is always on screen. It used to appear only when a file carried
  // two clips, on the reasoning that one clip is not a choice — true, and beside
  // the point: "which animation is this" is a question a single-clip file asks
  // just as loudly, and the answer was nowhere.
  select.hidden = false;
  select.disabled = playable.length < 2;
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
      filters: [{ name: t("dlg.models3d"), extensions: SUPPORTED }],
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

void shellReady.then(async () => {
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
      // Something was written on the user's behalf, so they are told which, and
      // where to undo it. Once, on the first launch of a machine that had none.
      tauri.event.listen("shell-enabled", () => {
        refreshShellState();
        toast(t("toast.shellEnabled"), 4000);
      });
    }
  }

  // A thumbnail is a file's identity card, not a picture of one session. The
  // headless process ran the same startup as the window, so it inherited
  // whatever exposure, environment and lighting the user happened to be using:
  // pictures came out at one and a half stops over, lit by whichever panorama
  // was loaded that day. Worse, the cache key says nothing about any of it, so
  // a picture taken under one look was served for ever, and the shell and the
  // library, asking at different moments for different sizes, ended up holding
  // two different pictures of one file.
  if (headless) neutralLook();
  else {
    restoreDevices();
    // The panel was wired before the settings existed; this is it looking again.
    hud.repaintDevices?.();
    applyPrefs();
  }
});

// Dev hook: drive the app from the console while building the UI.
//
// The exhaustive click test in `docs/RETOPO.md` runs through this: it has to be
// able to open a model, open the mode and reach the panes without a shell, and
// clicking everything is the check that catches the regressions reading the code
// never does.
if (import.meta.env && import.meta.env.DEV) {
  window.__albedo = {
    viewer, channels, nav, open, applyChannel, get prefs() { return prefs; },
    selection, showPane, toggleRetopo, toggleGroups, openPath, markDirty, clearDirty,
    importPart, newDocument, closeDocument, switchTo, documents,
    get dirty() {
      return sceneDirty;
    },
    get retopo() {
      return retopo;
    },
    // The shared overlay uniforms, so a click test can drive the group display
    // without going through a mode that needs the shell to be running.
    get wire() {
      return wire;
    },
    wakeWire,
    get groups() {
      return groups;
    },
    get tree() {
      return outliner;
    },
  };
}

// --- HUD, shortcuts -------------------------------------------------------

const hud = wireHud({
  viewer,
  nav,
  // A getter, not the value: `tauri` is null until the deferred startup above
  // finishes, and this wires at module scope, before that. The fullscreen
  // toggle reads it at click time and needs the shell handle then.
  tauri: () => tauri,
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
    library = createLibrary({
      tauri,
      prefs,
      /*
       * The library opens a file, unless it was opened *to import one*.
       *
       * Importing had one route: the system file dialog, which means knowing
       * where the asset lives on disk. The library is the thing that already
       * knows — it is a browsable, tagged, thumbnailed index of exactly these
       * files — and it was reachable for opening and not for importing, which is
       * the same act with a different destination.
       *
       * A flag rather than a second library: it is one screen, one scan and one
       * set of thumbnails, and standing a second copy of it up to answer a
       * slightly different question would be a second copy to keep in step.
       */
      onOpen: (path, options) => {
        if (!importing) return openPath(path, options);
        // A peek is a hover, not a choice: it must not import anything.
        if (options?.keepLibrary) return Promise.resolve();
        importing = false;
        library?.hide();
        return importPart(path);
      },
      // Whether there is something to come back to. The library opens beside a
      // loaded model rather than over it.
      hasModel: () => !!viewer.current,
      // Refit a preview when the strip changes shape under it. Only a preview:
      // a document being worked on has a camera someone chose.
      refit: () => {
        if (!viewer.current || !activeDoc?.preview) return;
        requestAnimationFrame(() => viewer.frame(viewer.sceneBox()));
      },
    });
    // The preview strip loads into this very viewer, so nothing is duplicated
    library.show();
    return;
  }
  library.toggle();
}
$("btn-library").addEventListener("click", toggleLibrary);

/**
 * Retopology: a mode, sharing the one panel with every other mode.
 *
 * It owned a panel of its own once, with seven tabs, two of which were Albedo's
 * panes borrowed for the duration. That gave a single model three competing
 * navigations. Now it fills one pane of the shared panel and keeps two things
 * that are genuinely its own: the shortcut bar over the viewport and the action
 * bar underneath. Its module and stylesheet are still one lazy chunk, fetched on
 * the first open and never at startup, which counts for more here than
 * elsewhere: this executable is also the Explorer thumbnail provider, one
 * process per file.
 */
async function toggleRetopo() {
  if (retopo) {
    retopo.toggle();
    return;
  }
  // The overlay comes first: the mode's curtain, its x-ray and its two data
  // views are all the same patched shader the wireframe uses, so the mode
  // cannot be built against a set of uniforms nobody else holds. Both are lazy
  // chunks, so this is one extra fetch on the first open and none after.
  const w = await wakeWire();
  const { createRetopo } = await import("./retopo/index.js");
  retopo = createRetopo({
    wire: w,
    tauri,
    viewer,
    importPart,
    onBusy: setBusy,
    toast,
    // When the model came off disk as glTF the engine opens that file itself,
    // rather than being handed a forty megabyte re-export across the bridge.
    sourcePath: () => openedPath,
    // For the scope control: it reads which materials are hidden, and it needs
    // the originals to match uuids against the channel view's stand-ins.
    channels,
    // The view controls in the mode's top bar drive the same channel state the
    // Vue pane does, so the two can never disagree about what is on screen.
    applyChannel,
    // The bar mirrors the one switch rather than owning a second one.
    setWireframe: (on) => setWireframe(on),
    setWireDark: (dark) => {
      $("opt-wire-dark").checked = dark;
      wire?.setColour(!dark);
      viewer.invalidate();
      prefs.set("wireDark", dark);
    },
    // A mode does not own a panel any more. What it gets is the right to say
    // which tab of the shared one comes forward, which is how a report reaches
    // the eye without a second surface being invented to carry it.
    showPane,
    onOpenChange: (on) => {
      /*
       * The bar stays. Retopo adds to it.
       *
       * This line used to read `$("viewbar").hidden = on`, because the mode put
       * up a second bar in the same corner carrying its own Couleur, its own
       * Calques and a Caméra group that had lost Libre and Rotation continue
       * along the way. Two bars meant two answers to "how am I looking at this",
       * and the mode's answer was the poorer one. Now the groups this mode adds
       * go into the slots of the one bar, and come back out on close.
       */
      setPressed($("btn-retopo"), on);
      if (on) {
        // Opening the mode opens the panel on the mode's own tab. The panel is
        // shared, so this is a change of subject rather than a second surface.
        hud.toggleInspector(true);
        showPane("retopo");
        widenPeekForRetopo();
      } else if (currentPane() === "retopo") {
        // The tab is going away with the mode, so the panel is sent back to
        // whichever pane was remembered rather than left showing nothing.
        showPane(migratePane(prefs.get("pane")));
      }
    },
  });
  retopo.show();
}
$("btn-retopo").addEventListener("click", () => {
  // Opening the engine on a model is a statement that this model is what you
  // came for, so the tab stops being one you were only looking through.
  promoteDocument();
  toggleRetopo();
});

/**
 * The Groupes mode, on the same lazy pattern as Retopo and the library.
 *
 * The overlay comes first for the same reason it does there: the group colours,
 * the tint and the outlines are all the one patched shader the wireframe uses,
 * so the mode cannot be built against a set of uniforms nobody else holds.
 */
async function toggleGroups() {
  if (groups) {
    groups.toggle();
    return;
  }
  const w = await wakeWire();
  const { createGroups } = await import("./groups/index.js");
  groups = createGroups({
    wire: w,
    tauri,
    viewer,
    onBusy: setBusy,
    toast,
    // It re-hands the materials after writing its attributes, so the ones
    // already on the meshes go through the wire patch and learn the uniforms.
    channels,
    showPane,
    markDirty,
    onOpenChange: (on) => {
      setPressed($("btn-groups"), on);
      if (on) {
        hud.toggleInspector(true);
        showPane("groups");
      } else if (currentPane() === "groups") {
        showPane(migratePane(prefs.get("pane")));
      }
    },
  });
  groups.show();
}
$("btn-groups").addEventListener("click", () => {
  promoteDocument();
  toggleGroups();
});


/**
 * Give Retopo room when it opens over the library, once, and then get out of
 * the way.
 *
 * The preview strip is sized for picking a model, not for judging a retopology:
 * at 460 pixels the panel alone is most of it and the model is a thumbnail. So
 * the mode nudges the split wider.
 *
 * A nudge and not a rule. It used to be `body.peeking.retopo-open { --peek: 50% }`
 * in the stylesheet, which beat the inline value the drag handle writes on the
 * root element, so the split froze at half and dragging it did nothing. Writing
 * the same property the handle writes leaves the handle in charge, and the
 * nudge only happens when the strip is actually too narrow to work in.
 */
function widenPeekForRetopo() {
  if (!document.body.classList.contains("peeking")) return;
  const half = Math.round(window.innerWidth / 2);
  const now =
    parseInt(document.documentElement.style.getPropertyValue("--peek"), 10) ||
    parseInt(getComputedStyle(document.body).getPropertyValue("--peek"), 10) ||
    460;
  if (now >= window.innerWidth * 0.4) return;
  document.documentElement.style.setProperty("--peek", `${half}px`);
  window.dispatchEvent(new Event("resize"));
}

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
  ["fog", "on", "fog-on"], ["fog", "density", "fog-density"],
  ["fog", "radius", "fog-radius"], ["fog", "height", "fog-height"],
  ["fog", "falloff", "fog-falloff"], ["fog", "colour", "fog-colour"],
  ["grade", "on", "grade-on"], ["grade", "contrast", "grade-contrast"],
  ["grade", "saturation", "grade-saturation"], ["grade", "temperature", "grade-temperature"],
  ["grade", "vignette", "grade-vignette"], ["grade", "grain", "grade-grain"],
  ["grade", "aberration", "grade-aberration"], ["grade", "sharpen", "grade-sharpen"],
  ["aa", "on", "aa-on"],
];

/**
 * What every control in the pane is set to, mirrored here.
 *
 * Read straight off the markup, once, before anything has had a chance to write
 * to it. That makes it the *defaults*, which is what a new scene has to go back
 * to: an effects stack is a property of the picture being made, not of the
 * application, so opening a second model beside the first must not inherit its
 * bloom.
 */
/** What one control currently says, in the type its setting is stored as. */
const readControl = (el) =>
  el.type === "checkbox" ? el.checked : el.type === "color" ? el.value : Number(el.value);

const POST_DEFAULTS = (() => {
  const bag = {};
  for (const [group, key, id] of POST_CONTROLS) {
    const el = $(id);
    if (!el) continue;
    bag[group] ??= {};
    bag[group][key] = readControl(el);
  }
  return bag;
})();

/** The live state, so a document can be handed a copy of it. */
let postState = structuredClone(POST_DEFAULTS);

let postPending = null;
async function setPost(group, key, value) {
  postState[group] = { ...(postState[group] || {}), [key]: value };
  // Still written to the preferences, which is what a *new session* starts
  // from. The document carries its own copy from here on.
  prefs.set("post", structuredClone(postState));
  // One chain, even if three sliders move before it has finished loading
  postPending ||= viewer.effects();
  const fx = await postPending;
  fx.set(group, key, value);
  viewer.invalidate();
}

/** Put a whole effects stack on, controls and chain together. */
async function applyPost(bag) {
  postState = structuredClone(bag || POST_DEFAULTS);
  for (const [group, key, id] of POST_CONTROLS) {
    const el = $(id);
    const value = postState[group]?.[key];
    if (!el || value === undefined) continue;
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = String(value);
  }
  for (const box of document.querySelectorAll(".fx-switch")) paintFxCard(box);
  refreshSliderValues();
  viewer.setFogState({ on: !!postState.fog?.on, colour: postState.fog?.colour });

  // A stack that is entirely off, on a session that never built the chain, is
  // nothing to do: bringing a composer in to switch everything off is the one
  // cost this whole lazy arrangement exists to avoid.
  const wanted = Object.values(postState).some((g) => g && g.on);
  if (!wanted && !postPending) return;
  postPending ||= viewer.effects();
  const fx = await postPending;
  fx.apply(postState);
  viewer.invalidate();
}

for (const [group, key, id] of POST_CONTROLS) {
  const el = $(id);
  if (!el) continue;
  const isCheck = el.type === "checkbox";
  el.addEventListener(isCheck ? "change" : "input", () => {
    setPost(group, key, readControl(el));
    if (isCheck) paintFxCard(el);
    // The fog is the one effect with a body in the scene: switching it on has
    // to bring its handle out, and recolouring it has to recolour that handle.
    if (group === "fog") {
      viewer.setFogState({
        on: $("fog-on").checked,
        colour: $("fog-colour").value,
      });
    }
  });
}

$("fog-recentre")?.addEventListener("click", () => {
  viewer.placeFog(true);
  toast(t("toast.fogRecentred"));
});

/*
 * Depth of field, shown while it is being set rather than after.
 *
 * The three sliders name a plane somewhere in the scene, and until now the only
 * way to find out where was to let go, wait for the frame, and look at what came
 * out soft. Dragging any of them puts three rings in the viewport — the plane in
 * focus and the two ends of the sharp band — and a readout under them.
 *
 * On `input` rather than on `pointerdown`, so the arrow keys get it too; and
 * held for a moment after the last change, because letting go to look at the
 * result is precisely when the rings should still be there.
 */
{
  const readout = $("focus-readout");
  readout.innerHTML =
    `<span data-i18n="dof.focusAt">Mise au point</span> <b>—</b>` +
    ` <span data-i18n="dof.sharpOver">· net sur</span> <i>—</i>`;
  const far = readout.querySelector("b");
  const band = readout.querySelector("i");
  let timer = 0;

  /*
   * Pushed by the pass, not polled by a frame loop.
   *
   * A `requestAnimationFrame` loop was the obvious way to keep this in step, and
   * the wrong one twice over: rendering here is on demand, so a loop spins
   * through frames that draw nothing, and rAF stops being called at all in a
   * background tab — which would leave the readout on screen for ever, since the
   * loop was also what took it away. The pass already recomputes the focus every
   * time it renders, so it says so, and the numbers follow a camera move for
   * free.
   */
  viewer.onFocus = (at) => {
    far.textContent = at.distance.toFixed(2);
    band.textContent = (at.halfBand * 2).toFixed(2);
  };

  const show = () => {
    readout.hidden = false;
    viewer.showFocus(true);
    // The rings are filled by the pass on its next render, which the change to
    // the setting has already asked for.
    viewer.invalidate();
    clearTimeout(timer);
    // Held after the last change, because letting go to look at the result is
    // precisely when the rings should still be there.
    timer = setTimeout(() => {
      readout.hidden = true;
      viewer.showFocus(false);
    }, 1200);
  };

  for (const id of ["dof-focus", "dof-aperture", "dof-maxblur"]) {
    $(id)?.addEventListener("input", show);
  }
  // Turning the effect on is also a moment to be told where it is aimed.
  $("dof-on")?.addEventListener("change", (e) => {
    if (e.target.checked) show();
  });
}

/**
 * A card looks like what it is doing.
 *
 * The class is what colours the border and the glyph and reveals the
 * parameters, and it is set from the switch rather than tracked beside it, so
 * there is one answer to "is this effect on" and the picture cannot drift from
 * it — restoring a saved set, clicking the switch and clicking the title all
 * end up here.
 */
function paintFxCard(input) {
  input.closest(".fx")?.classList.toggle("on", input.checked);
}

/**
 * The whole title line is the switch.
 *
 * A seventeen pixel toggle is a small target for a control that is used more
 * than anything else in this pane, and the name beside it is dead space. The
 * switch itself is left alone: it is a label click away from toggling twice.
 */
for (const head of document.querySelectorAll(".fx-head")) {
  head.addEventListener("click", (e) => {
    if (e.target.classList.contains("fx-switch")) return;
    const box = head.querySelector(".fx-switch");
    if (!box) return;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// Restore what was left on, and only then: a saved set that is entirely off
// must not drag the chain in at launch.
void shellReady.then(() => {
  // The saved set is merged over the markup defaults rather than used as-is: a
  // set written before a control existed says nothing about it, and reading it
  // raw would leave that control at whatever `undefined` does to it.
  const saved = prefs.get("post");
  void applyPost({ ...structuredClone(POST_DEFAULTS), ...structuredClone(saved || {}) });
});


// --- Décor / Object Manager --------------------------------------------------

let decorSelection = {
  type: "light",
  id: viewer.lights[0]?.id || 1,
  kind: "directional",
};
let decorGizmoMode = null;

const LIGHT_KIND_LABELS = {
  directional: "light.directional",
  point: "light.point",
  spot: "light.spot",
};

const LIGHT_KIND_ICONS = {
  directional: "☀️",
  point: "💡",
  spot: "🔦",
};

function lightIntensityPercent(entry) {
  const max = entry.kind === "spot" ? 20 : entry.kind === "point" ? 15 : 2.5;
  return Math.max(0, Math.min(100, Math.round((entry.intensity / max) * 100)));
}

function saveLights() {
  prefs?.set?.("lights", viewer.lightState());
}

function updateDecorSelectedLabel() {
  const label = $("decor-selected-label");
  if (!label) return;
  if (decorSelection.type === "light") {
    const entry =
      viewer.lights.find((l) => l.id === decorSelection.id) || viewer.lights[0];
    if (entry) {
      const kindLabel = LIGHT_KIND_LABELS[entry.kind];
      label.textContent = `${entry.name} (${kindLabel ? t(kindLabel) : entry.kind})`;
    } else {
      label.textContent = t("pane.lightGeneric");
    }
  } else if (decorSelection.type === "pedestal") {
    const pName = prefs?.get?.("pedestal")
      ? fileLabel(prefs.get("pedestal"))
      : viewer.pedestal
      ? t("pane.stand3d")
      : t("pane.noStand");
    label.textContent = t("pane.standNamed").replace("{name}", pName);
  } else if (decorSelection.type === "background") {
    const bName =
      viewer.envKind === "image"
        ? prefs?.get?.("environmentPath")
          ? fileLabel(prefs.get("environmentPath"))
          : t("pane.hdriImage")
        : viewer.envKind === "gradient"
        ? t("pane.gradient")
        : t("pane.studio");
    label.textContent = t("pane.backdropNamed").replace("{name}", bName);
  }
}

function updateLightControls(entry) {
  if (!entry) return;
  const pct = lightIntensityPercent(entry);
  if ($("light-power")) $("light-power").value = String(entry.intensity);
  if ($("light-power-value")) $("light-power-value").textContent = `${pct}%`;
  if ($("light-azimuth")) $("light-azimuth").value = String(entry.azimuth ?? 45);
  if ($("light-azimuth-value"))
    $("light-azimuth-value").textContent = `${entry.azimuth ?? 45}°`;
  if ($("light-elevation"))
    $("light-elevation").value = String(entry.elevation ?? 35);
  if ($("light-elevation-value"))
    $("light-elevation-value").textContent = `${entry.elevation ?? 35}°`;
  if ($("light-distance"))
    $("light-distance").value = String(entry.distance ?? 2.5);
  if ($("light-distance-value"))
    $("light-distance-value").textContent = `${(entry.distance ?? 2.5).toFixed(1)}×`;
  /*
   * Distance is hidden for a directional light, because it changes nothing.
   *
   * A directional light in three.js has no position in the physical sense: only
   * the vector from it to its target is read, and the rig aims every light at
   * the same centre. Sliding the distance walks the light along that very ray,
   * so the direction is identical and the picture does not move by a pixel.
   * There are no shadows in this viewer either, which is the other thing that
   * would have made the distance matter.
   *
   * It is real for the other two: a point and a spot fall off with distance, and
   * `placeLight` sizes their reach from it.
   */
  if ($("light-distance"))
    $("light-distance").closest("label").hidden = entry.kind === "directional";
  if ($("light-colour")) $("light-colour").value = entry.colour || "#ffffff";
  if ($("light-kind")) $("light-kind").value = entry.kind || "directional";
  if ($("light-cone")) $("light-cone").hidden = entry.kind !== "spot";
  if (entry.kind === "spot") {
    if ($("light-angle")) $("light-angle").value = String(entry.angle ?? 35);
    if ($("light-angle-value"))
      $("light-angle-value").textContent = `${entry.angle ?? 35}°`;
    if ($("light-penumbra"))
      $("light-penumbra").value = String(entry.penumbra ?? 0.4);
    if ($("light-penumbra-value"))
      $("light-penumbra-value").textContent = (entry.penumbra ?? 0.4).toFixed(2);
  }
}

/*
 * The initial selection at load is only for the panel, so it must not draw
 * the light helper: that line in the viewport should appear from a click,
 * never sit there before anyone touched the light list.
 *
 * `showHelper` says the same thing about the stand's handles, which is the half
 * that was never written. A stand is remembered between sessions, so `applyPrefs`
 * loads it and selects it to fill the panel in — and selecting a stand brought
 * its gizmo out. With no model open the stand itself is not even drawn
 * (`placePedestal` hides it until there is something to stand under), so what
 * came up on an empty viewport was a set of handles on nothing, before anybody
 * had clicked at all. Hence the second condition below: handles belong to what
 * is on screen.
 */
function selectDecorItem(sel, { showHelper = true } = {}) {
  decorSelection = sel;
  updateDecorSelectedLabel();

  if ($("decor-params-light"))
    $("decor-params-light").hidden = sel.type !== "light";
  if ($("decor-params-pedestal"))
    $("decor-params-pedestal").hidden = sel.type !== "pedestal";
  if ($("decor-params-background"))
    $("decor-params-background").hidden = sel.type !== "background";

  if (sel.type === "light") {
    const entry =
      viewer.lights.find((l) => l.id === sel.id) || viewer.lights[0];
    if (entry) {
      decorSelection.id = entry.id;
      if (showHelper) {
        viewer.showLightHelper(entry.id);
        if (decorGizmoMode) {
          viewer.setGizmo(decorGizmoMode, null, entry.object);
        }
      }
      updateLightControls(entry);
    }
  } else if (sel.type === "pedestal") {
    viewer.showLightHelper(null);
    if (showHelper && viewer.pedestal && viewer.stand.visible) {
      setGizmoMode("translate");
    }
  } else if (sel.type === "background") {
    viewer.showLightHelper(null);
    setGizmoMode(null);
    // The whole set, not just the two dead-control rules: choosing a backdrop
    // row has to bring up that backdrop's own editor, and the panel is reachable
    // by routes that never went through `useEnvironment`.
    paintBackdropPanes();
    // Switching to it is the outliner's job, on the click that chose the row.
    // Doing it here as well ran `useEnvironment` twice for one click, which on
    // the image source meant loading and decoding the panorama twice.
  }

  if ($("decor-act-dup")) $("decor-act-dup").disabled = sel.type !== "light";

  paintDecorTree();
}

function selectLight(id) {
  selectDecorItem({ type: "light", id });
}

/**
 * Which gizmo the selected light gets, if any.
 *
 * There is no button for this any more: the three that used to sit in the Décor
 * actions bar are gone, and the mode is decided by what is selected. Painting
 * them was the only thing left that reached for `#light-giz-*`, and those ids
 * have not been in the markup for some time.
 */
function setLightGizmoMode(mode) {
  decorGizmoMode = mode;

  const entry = viewer.lights.find((l) => l.id === decorSelection.id);
  if (entry && mode) {
    viewer.setGizmo(mode, null, entry.object);
  } else {
    viewer.setGizmo(null);
  }
}

/**
 * Repaint the list of what is in the scene.
 *
 * It used to build a second tree of its own, in the Décor tab, with its own
 * rows for the lights, the stand and the backdrops — two hundred lines saying
 * the same things about the same scene as the tree in the Scène tab, in a
 * different visual language, kept in step by hand. The two are one list now, so
 * this is the one call that redraws it.
 */
function paintDecorTree() {
  outliner?.paint();
}

const paintLights = paintDecorTree;

// Event listeners for Light controls
$("light-power")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  viewer.setLight(decorSelection.id, { intensity: value });
  const entry = viewer.lights.find((l) => l.id === decorSelection.id);
  if (entry) $("light-power-value").textContent = `${lightIntensityPercent(entry)}%`;
  paintDecorTree();
  saveLights();
});

$("light-azimuth")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  $("light-azimuth-value").textContent = `${value}°`;
  viewer.setLight(decorSelection.id, { azimuth: value });
  saveLights();
});

$("light-elevation")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  $("light-elevation-value").textContent = `${value}°`;
  viewer.setLight(decorSelection.id, { elevation: value });
  saveLights();
});

$("light-distance")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  $("light-distance-value").textContent = `${value.toFixed(1)}×`;
  viewer.setLight(decorSelection.id, { distance: value });
  saveLights();
});

$("light-colour")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  viewer.setLight(decorSelection.id, { colour: e.target.value });
  paintDecorTree();
  saveLights();
});

$("light-kind")?.addEventListener("change", (e) => {
  if (decorSelection.type !== "light") return;
  viewer.setLight(decorSelection.id, { kind: e.target.value });
  $("light-cone").hidden = e.target.value !== "spot";
  updateDecorSelectedLabel();
  paintDecorTree();
  saveLights();
});

$("light-angle")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  $("light-angle-value").textContent = `${value}°`;
  viewer.setLight(decorSelection.id, { angle: value });
  saveLights();
});

$("light-penumbra")?.addEventListener("input", (e) => {
  if (decorSelection.type !== "light") return;
  const value = Number(e.target.value);
  $("light-penumbra-value").textContent = value.toFixed(2);
  viewer.setLight(decorSelection.id, { penumbra: value });
  saveLights();
});

/*
 * Adding and deleting a light live in the outliner, on the Lumières group and
 * on each row. Two more buttons here did the same two things a second time and
 * had already lost their markup, so the handlers ran for nobody.
 */
$("decor-act-dup")?.addEventListener("click", () => {
  if (decorSelection.type !== "light") return;
  const entry = viewer.duplicateLight(decorSelection.id);
  if (entry) {
    selectDecorItem({ type: "light", id: entry.id });
    saveLights();
  }
});

$("decor-act-reset")?.addEventListener("click", () => {
  const primary = viewer.resetLights();
  selectDecorItem({ type: "light", id: primary.id });
  saveLights();
  toast(t("toast.lightingReset"));
});

// Group collapse carets
for (const [headId, groupId, caretId] of [
  ["decor-head-lights", "decor-group-lights", "decor-caret-lights"],
  ["decor-head-pedestals", "decor-group-pedestals", "decor-caret-pedestals"],
  ["decor-head-backgrounds", "decor-group-backgrounds", "decor-caret-backgrounds"],
]) {
  $(headId)?.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON" && e.target.id !== caretId) return;
    const grp = $(groupId);
    if (!grp) return;
    grp.classList.toggle("collapsed");
    $(caretId).textContent = grp.classList.contains("collapsed") ? "▸" : "▾";
  });
}

// Global viewer lighting hooks
viewer.onLightChange = (entry) => {
  if (decorSelection.type === "light" && decorSelection.id === entry.id) {
    updateLightControls(entry);
  }
  paintDecorTree();
};

selectDecorItem({ type: "light", id: viewer.lights[0]?.id || 1 }, { showHelper: false });



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
    : t("pan.orientNone");
}

// Named for what they do to the model rather than for the axis they turn it
// about. Nobody looking at a model on its side is thinking in axes; they are
// thinking "tip it forward". The axis stays in the tooltip for anyone who is.
for (const [axis, quarters, label, what] of [
  ["x", 1, "pan.tipForward", "pan.tipForwardTitle"],
  ["x", -1, "pan.tipBack", "pan.tipBackTitle"],
  ["y", 1, "pan.turnLeft", "pan.turnLeftTitle"],
  ["y", -1, "pan.turnRight", "pan.turnRightTitle"],
  ["z", 1, "pan.rollLeft", "pan.rollLeftTitle"],
  ["z", -1, "pan.rollRight", "pan.rollRightTitle"],
]) {
  const b = document.createElement("button");
  b.type = "button";
  // `data-i18n` rather than a repaint: `applyStatic` walks the document on
  // every language change, and reaches nodes built long after startup.
  b.dataset.i18n = label;
  b.dataset.i18nTitle = what;
  b.textContent = t(label);
  b.title = t(what);
  b.addEventListener("click", () => {
    recordBefore(viewer.root);
    viewer.turnModel(axis, quarters);
    recordAfter();
    paintOrientation();
    showDimensions();
  });
  $("orient-buttons").appendChild(b);
}

$("orient-reset").addEventListener("click", () => {
  recordBefore(viewer.root);
  viewer.resetOrientation();
  recordAfter();
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
// --- Windows integration ----------------------------------------------------

/**
 * Attach this copy of Albedo to Explorer, or detach it.
 *
 * Albedo is the only thing that knows where Albedo is, and it knows it every
 * time it starts, which an installer cannot say. A portable copy moves between
 * folders and disks; the path it records is refreshed at each launch, so moving
 * it is not something anyone has to remember to repair.
 *
 * Asked for rather than assumed, and the button that undoes it sits beside the
 * one that does it. A program that writes to the registry because it was
 * launched, and leaves the entry behind when its file is gone, has taken
 * something that was not offered.
 */
async function paintShellState(state) {
  const note = $("shell-state");
  if (!state) {
    note.textContent = t("shell.unknown");
    return;
  }
  $("shell-section").hidden = false;
  $("shell-on").disabled = !state.available || state.current_is_registered;
  $("shell-off").disabled = !state.registered;
  if (!state.registered) {
    note.textContent = state.available ? t("shell.inactive") : t("shell.unavailable");
    return;
  }
  note.textContent = state.current_is_registered
    ? t("shell.activeHere")
    : t("shell.activeElsewhere").replace(
        "{copy}",
        state.renderer || state.provider || t("shell.otherCopy")
      );
}

async function refreshShellState() {
  if (!tauri) return;
  const state = await tauri.core.invoke("shell_integration").catch(() => null);
  paintShellState(state);
}

for (const [id, command, saidKey] of [
  ["shell-on", "shell_integration_enable", "toast.shellOnDone"],
  ["shell-off", "shell_integration_disable", "toast.shellOffDone"],
]) {
  $(id).addEventListener("click", async () => {
    $(id).disabled = true;
    try {
      paintShellState(await tauri.core.invoke(command));
      toast(t(saidKey));
    } catch (e) {
      $("shell-state").textContent = String(e);
      toast(t("toast.failed").replace("{e}", e));
    }
    refreshShellState();
  });
}

$("shell-shortcut").addEventListener("click", async () => {
  try {
    await tauri.core.invoke("shell_desktop_shortcut");
    toast(t("toast.shortcutOn"));
  } catch {
    toast(t("toast.shortcutOff"));
  }
});

// --- undo ------------------------------------------------------------------

const poseOf = (o) => ({
  object: o,
  position: o.position.clone(),
  quaternion: o.quaternion.clone(),
  scale: o.scale.clone(),
});
const samePose = (a, b) =>
  a.object === b.object &&
  a.position.equals(b.position) &&
  a.quaternion.equals(b.quaternion) &&
  a.scale.equals(b.scale);
function applyPose(p) {
  p.object.position.copy(p.position);
  p.object.quaternion.copy(p.quaternion);
  p.object.scale.copy(p.scale);
  p.object.updateMatrixWorld(true);
}

function recordBefore(object) {
  pendingPose = object ? poseOf(object) : null;
}

/** Closes the entry opened by recordBefore, unless nothing actually moved. */
function recordAfter() {
  if (!pendingPose) return;
  const after = poseOf(pendingPose.object);
  if (samePose(pendingPose, after)) {
    pendingPose = null;
    return;
  }
  history.past.push({ before: pendingPose, after });
  markDirty();
  if (history.past.length > history.limit) history.past.shift();
  // A new edit is a new branch: what was undone can no longer be redone
  history.future.length = 0;
  pendingPose = null;
  paintHistory();
}

/** Drop every entry about an object, and about anything inside it. */
function forgetHistoryOf(object) {
  const inside = (o) => {
    let node = o;
    while (node) {
      if (node === object) return true;
      node = node.parent;
    }
    return false;
  };
  const keep = (entry) => !inside(entry.before.object);
  history.past = history.past.filter(keep);
  history.future = history.future.filter(keep);
  if (pendingPose && inside(pendingPose.object)) pendingPose = null;
  paintHistory();
}

function paintHistory() {
  $("undo").disabled = !history.past.length;
  $("redo").disabled = !history.future.length;
}

function stepHistory(back) {
  const from = back ? history.past : history.future;
  const to = back ? history.future : history.past;
  const entry = from.pop();
  if (!entry) return;
  applyPose(back ? entry.before : entry.after);
  to.push(entry);
  if (entry.before.object === viewer.pivotMarker) viewer.setPivot(viewer.pivotMarker.position);
  viewer.invalidate();
  paintOrientation();
  showDimensions();
  paintHistory();
  toast(t(back ? "toast.undone" : "toast.redone"));
}

$("undo").addEventListener("click", () => stepHistory(true));
$("redo").addEventListener("click", () => stepHistory(false));

viewer.onGizmoDrag = (phase, object) => {
  if (phase === "start") {
    recordBefore(object);
    return;
  }
  if (phase === "move") {
    paintTransform();
    toast(liveTransform(object));
    if (object === viewer.pivotMarker) viewer.setPivot(object.position);
    return;
  }
  recordAfter();
  paintTransform();
  if (object === viewer.pivotMarker) viewer.setPivot(object.position);
};

// Alt-drag duplicates: hold Alt and drag the move handle to copy the object in
// place and move the copy, the way Blender does it.
let altHeld = false;
viewer.onGizmoAltDrag = (object) => {
  if (!altHeld || editMode !== "translate" || !object || object === viewer.pivotMarker) return;
  const clone = object.clone();
  // `clone()` copies the name along with everything else, so the scene ended up
  // holding two rows called `Head` and no way to say which one the handles were
  // on. Numbered the way Blender numbers them: `Head`, then `Head.001`.
  adopt(viewer.root, clone);
  const entry = viewer.addPart(clone, clone.name || `${selectedPart?.name || "objet"} copie`);
  markDirty();
  selectedPart = entry;
  paintParts();
  paintTree();
  viewer.gizmo?.attach(clone);
};

// --- the numbers behind the handles ----------------------------------------

/**
 * Where the thing is, how it is turned, and how big it is.
 *
 * Both readable and writable. A handle is quick and never exact, a field is
 * exact and never quick, and a transform needs both: nudging something into
 * place by eye and then typing the ninety degrees you actually meant.
 */
/** The one number a drag is actually changing, said while it changes. */
function liveTransform(object) {
  if (!object) return "";
  const round = (v, n = 2) => Number(v.toFixed(n));
  if (editMode === "rotate") {
    const d = (r) => Math.round((r * 180) / Math.PI);
    return t("toast.liveRotation")
      .replace("{x}", d(object.rotation.x)).replace("{y}", d(object.rotation.y)).replace("{z}", d(object.rotation.z));
  }
  if (editMode === "scale") {
    const s = object.scale;
    return t("toast.liveScale")
      .replace("{x}", round(s.x)).replace("{y}", round(s.y)).replace("{z}", round(s.z));
  }
  const p = object.position;
  return t("toast.livePosition")
    .replace("{x}", round(p.x, 3)).replace("{y}", round(p.y, 3)).replace("{z}", round(p.z, 3));
}

function paintTransform() {
  const target = editTarget();
  for (const [id, group, axis, factor] of XFORM) {
    const input = $(id);
    input.disabled = !target;
    // Not while it is being typed into, or the caret jumps mid-number
    if (!target || (typingTransform && document.activeElement === input)) continue;
    const value = target[group][axis] * factor;
    input.value = String(Number(value.toFixed(group === "rotation" ? 1 : 4)));
  }
}

for (const [id, group, axis, factor] of XFORM) {
  const input = $(id);
  input.addEventListener("focus", () => {
    typingTransform = true;
  });
  input.addEventListener("blur", () => {
    typingTransform = false;
    paintTransform();
  });
  input.addEventListener("change", () => {
    const target = editTarget();
    const value = Number(input.value);
    if (!target || !Number.isFinite(value)) return;
    // A scale of zero collapses a mesh to a plane it cannot come back from by
    // dragging, so the field refuses what the handle would never produce.
    const wanted = group === "scale" && value === 0 ? 0.001 : value / factor;
    recordBefore(target);
    target[group][axis] = wanted;
    target.updateMatrixWorld(true);
    recordAfter();
    if (target === viewer.pivotMarker) viewer.setPivot(target.position);
    viewer.invalidate();
    paintOrientation();
    showDimensions();
    paintTransform();
  });
  input.addEventListener("keydown", (e) => e.stopPropagation());
}

// --- pivot -----------------------------------------------------------------

function setPivotEditing(on) {
  pivotEditing = !!on && !!viewer.current;
  $("pivot-move").classList.toggle("active", pivotEditing);
  if (pivotEditing) {
    $("pivot-show").checked = true;
    viewer.showPivot(true);
    setEditMode("translate");
  } else if (editMode) {
    setEditMode(editMode);
  }
}

$("pivot-show").addEventListener("change", (e) => {
  viewer.showPivot(e.target.checked);
  if (!e.target.checked && pivotEditing) setPivotEditing(false);
});
$("pivot-move").addEventListener("click", () => setPivotEditing(!pivotEditing));

$("pivot-centre").addEventListener("click", () => {
  if (!viewer.current) return;
  recordBefore(viewer.pivotMarker || viewer.root);
  viewer.setPivot(viewer.geometricCentre());
  viewer.showPivot($("pivot-show").checked || pivotEditing);
  recordAfter();
  toast(t("toast.pivotMean"));
});

$("pivot-reset").addEventListener("click", () => {
  if (!viewer.current) return;
  const box = viewer.sceneBox();
  // getCenter wants somewhere to write; the box's own corner is a spare vector
  const middle = box.getCenter(box.min.clone());
  recordBefore(viewer.pivotMarker || viewer.root);
  viewer.setPivot(middle);
  viewer.showPivot($("pivot-show").checked || pivotEditing);
  recordAfter();
  toast(t("toast.pivotBox"));
});

function editTarget() {
  if (pivotEditing && viewer.pivotMarker) return viewer.pivotMarker;
  if (!viewer.current) return null;
  // A chosen object wins: with several files in the scene, moving one of them
  // is the whole point, and it is a more useful answer than a surface.
  if (selectedPart && viewer.parts.includes(selectedPart)) return selectedPart.object;
  // A mesh chosen in the tree is the most direct answer there is: it names one
  // object rather than a material that may be spread over eight of them.
  const picked = selection.meshes();
  if (picked.length === 1) {
    const node = meshByUuid(picked[0]);
    if (node) return node;
  }
  /*
   * Everything that has a place answers here.
   *
   * The stand, a light and the fog each had a Déplacer / Tourner set of their
   * own, in their own panel, because this function only knew about meshes — so
   * "move the thing I have selected" was one control for meshes and three other
   * controls elsewhere for everything else. One question, one answer, and the
   * row under the scene list drives all of them.
   */
  const chosen = selection.primary;
  if (chosen?.kind === "stand" && viewer.pedestal) return viewer.pedestal;
  if (chosen?.kind === "light") {
    const entry = viewer.lights.find((l) => l.id === Number(decorKey(chosen.id)));
    if (entry) return entry.object;
  }
  if (chosen?.kind === "fog") return viewer.fogHandle();
  const uuid = selection.material;
  const meshes = uuid ? channels.usersOf(uuid).meshes : [];
  return meshes.length === 1 ? meshes[0] : viewer.root;
}

/** The mesh carrying a uuid, or null once the model that held it is gone. */
function meshByUuid(uuid) {
  let found = null;
  viewer.root?.traverse((o) => {
    if (!found && o.uuid === uuid) found = o;
  });
  return found;
}

function editTargetName() {
  const target = editTarget();
  if (pivotEditing && target === viewer.pivotMarker) return t("edit.pivot");
  if (!target || target === viewer.root) return t("edit.wholeScene");
  if (selectedPart && target === selectedPart.object) return selectedPart.name || t("edit.pickedObject");
  return target.name || t("edit.pickedSurface");
}

function paintEditTarget() {
  $("edit-target").textContent = `Cible : ${editTargetName()}`;
}

/**
 * The coordinates appear with a subject and go with it.
 *
 * A row of empty number fields is three questions with nothing to ask them
 * about, and they sat under the scene list permanently while the answer to
 * "which object" was "none". They show when something is chosen — from the
 * list, from the viewport, either way — and the numbers under them are the ones
 * a drag is changing, live.
 */
function paintTransformPanel() {
  const block = $("xform-block");
  if (!block) return;
  /*
   * Asked of `editTarget`, not of the kind of the selection.
   *
   * Clicking a surface in the viewport selects a *material* — that is what the
   * Matière panel is for — so a kind check said "not a mesh" and hid the
   * coordinates on the most ordinary gesture there is. But `editTarget` already
   * resolves a material to the single mesh carrying it, which is the object the
   * handles were going to move anyway. One answer to "what am I acting on",
   * asked once, and the numbers follow it.
   *
   * `viewer.root` is not one: it is the fallback for a material spread over
   * eight meshes, and showing the whole scene's transform as though it were the
   * thing just clicked would be a lie in nine characters.
   */
  const target = viewer.current ? editTarget() : null;
  const has = !!target && target !== viewer.root;
  block.hidden = !has;
  if (has) {
    paintEditTarget();
    paintTransform();
  }
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
    name.textContent = entry.name || t("pane.unnamed");
    name.title = t("pane.objectAimTitle");
    name.addEventListener("click", () => {
      const next = selectedPart === entry ? null : entry;
      // After: `selectMaterial(null)` fires the selection subscription, which
      // clears `selectedPart` on every change so a stale pick cannot outlive it.
      selectMaterial(null);
      selectedPart = next;
      paintParts();
      if (editMode) setEditMode(editMode);
      else paintEditTarget();
    });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "seg";
    drop.textContent = "×";
    drop.title = t("pane.objectRemoveTitle");
    // The first entry is the file that was opened, and removing it would leave
    // a window that says it is showing a file it no longer holds.
    drop.disabled = entry === viewer.parts[0];
    drop.addEventListener("click", () => {
      if (selectedPart === entry) selectedPart = null;
      // An undo that pushes a pose onto an object no longer in the scene, and
      // whose buffers have just been given back, restores nothing and says it
      // did. The entries that named it go with it.
      forgetHistoryOf(entry.object);
      viewer.removePart(entry);
      channels.absorb();
      applyChannel(currentChannel);
      paintParts();
      paintMaterialList();
      showStats(viewer.stats());
      if (editMode) setEditMode(editMode);
      toast(t("toast.removed").replace("{name}", entry.name || t("toast.objectDefault")));
    });

    row.append(name, drop);
    list.appendChild(row);
  }
}

function setEditMode(mode) {
  if (mode && !viewer.current) return;
  editMode = mode || null;
  const target = editMode ? editTarget() : null;
  // A stand placed by hand replaces the automatic fit and is remembered. That
  // used to hang off the stand's own gizmo buttons; those are gone, so the
  // promise travels with the target instead of with the control that made it.
  const onChange =
    target && target === viewer.pedestal
      ? (placing) => {
          viewer.pedestalTransform = placing;
          prefs.set("pedestalTransform", placing);
        }
      : null;
  viewer.setGizmo(editMode, onChange, target);
  viewer.setGizmoSnap(false);
  for (const [id, value] of [
    ["edit-off", null], ["edit-translate", "translate"],
    ["edit-rotate", "rotate"], ["edit-scale", "scale"],
    ["mini-move", "translate"], ["mini-rotate", "rotate"], ["mini-scale", "scale"],
  ]) {
    $(id)?.classList.toggle("active", editMode === value);
  }
  // The bar shows the same state as the pane, because it is the same state.
  for (const b of document.querySelectorAll("[data-giz]")) {
    setPressed(b, editMode === b.dataset.giz);
  }
  paintEditTarget();
  paintTransform();
  paintTransformPanel();
  if (editMode) {
    const label = t({ translate: "pane.editMove", rotate: "pane.editRotate", scale: "pane.editScale" }[editMode]);
    toast(t("toast.editMode").replace("{label}", label).replace("{target}", editTargetName()));
  } else {
    paintOrientation();
    showDimensions();
  }
}

// The Objet pane's own segment is gone; `?.` because these ids no longer exist
// and this loop is kept only so a future panel can opt back in by name.
for (const [id, mode] of [
  ["edit-off", null], ["edit-translate", "translate"],
  ["edit-rotate", "rotate"], ["edit-scale", "scale"],
]) {
  $(id)?.addEventListener("click", () => setEditMode(mode));
}

/*
 * The same three modes, under the scene list.
 *
 * Relays into the one `setEditMode`, like the bar over the model. No fourth
 * button for "none": clicking the mode you are already in puts the handles away,
 * which is the gesture people reach for before they look for a button that says
 * Aucun.
 */
for (const [id, mode] of [
  ["mini-move", "translate"], ["mini-rotate", "rotate"], ["mini-scale", "scale"],
]) {
  $(id)?.addEventListener("click", () => setEditMode(editMode === mode ? null : mode));
}

/*
 * The pivot, on a plate that opens under its glyph.
 *
 * Four controls that are needed for about ten seconds, twice a session, and had
 * a whole titled section of the Objet tab to themselves. Reachable the moment
 * something is selected, and out of the way the rest of the time — which is the
 * whole argument for a menu over a panel.
 */
{
  const button = $("mini-pivot");
  const menu = $("pivot-menu");
  const show = (on) => {
    menu.hidden = !on;
    button.setAttribute("aria-expanded", String(!!on));
  };
  button?.addEventListener("click", (e) => {
    e.stopPropagation();
    show(menu.hidden);
  });
  // Reaching past it closes it, like every other drawer here. On pointerdown, so
  // it shuts on the press that begins an orbit rather than waiting for a release
  // a drag never delivers.
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden || menu.contains(e.target) || button.contains(e.target)) return;
    show(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) show(false);
  });
}

/*
 * The same three modes, in the bar over the model.
 *
 * Relays, not a second implementation: they call the one `setEditMode` the pane
 * and the G, R, S keys call, and `setEditMode` paints all of them. There is no
 * fourth button for "none" because the lit one already is it -- clicking the
 * mode you are in puts the handles away, which is the gesture you reach for
 * before you look for a button that says Aucun.
 */
for (const b of document.querySelectorAll("[data-giz]")) {
  b.addEventListener("click", () => {
    setEditMode(editMode === b.dataset.giz ? null : b.dataset.giz);
  });
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
  // Importing into an empty tab is the whole point of an empty tab: a scene put
  // together out of several files starts with nothing in it.
  $("part-import").disabled = !tauri;
  over.disabled = !canOverwrite;
  over.title = canOverwrite
    ? t("pane.overwriteTitle").replace("{file}", fileLabel(openedPath))
    : openedPath
      ? t("pane.overwriteWrongFormat")
      : t("pane.overwriteNoFile");
}

/**
 * Bring another file in beside the one already open.
 *
 * The same loader and the same corrections as a plain open, because an
 * imported model is not a lesser one: it gets its materials normalised, its
 * colour spaces fixed and its textures found exactly as the first did.
 */
async function importPart(path, label) {
  if (!tauri) return;
  // An empty tab has no model to add to, and that is a state to fill rather
  // than a reason to refuse: the first import becomes the scene.
  const first = !viewer.current;
  setBusy(true);
  try {
    const url = tauri.core.convertFileSrc(path);
    const name = label || path.split(/[\\/]/).pop();
    const findTextures = async (names) => {
      const found = await tauri.core.invoke("find_textures", { modelPath: path, names });
      return (found || []).map((f) => ({ name: f.name, url: tauri.core.convertFileSrc(f.path) }));
    };
    const { object } = await loadModel(url, {
      renderer: viewer.renderer,
      onProgress: setProgress,
      findTextures,
      resolveSibling: siblingResolver(path),
    });
    normalizeMaterials(object);
    fixColorSpaces(object);
    ignoreDeadVertexColors(object);
    ensureAoUv(object);
    // Imported beside a model that may already hold these names, which is the
    // common case rather than the odd one: importing the same file twice, or
    // two exports of one asset, arrives with a full set of collisions.
    adopt(viewer.root, object);
    const entry = viewer.addPart(object, name);
    markDirty();
    selectedPart = entry;
    if (first) {
      // Nothing was framed, sized or named yet, because nothing had been loaded
      // through the usual path. The first object does all three.
      viewer.boxHelper.box.setFromObject(object);
      viewer.frame(viewer.boxHelper.box);
      viewer.scaleGrid(viewer.sceneBox());
      viewer.placePedestal();
      setTitle(name);
      $("empty").classList.add("hidden");
    }
    // The scene gained an object; the model that was already here did not
    // change and must not be forgotten along with it.
    channels.absorb();
    // An imported object arrives with plain indexed geometry, so it needs the
    // overlay's attributes before it can draw a single line. Without this a
    // retopology result came in mute while everything around it drew edges.
    if ($("opt-wireframe").checked) await setWireframe(true, false);
    applyChannel(currentChannel);
    paintParts();
    paintMaterialList();
    paintTree();
    showStats(viewer.stats());
    showDimensions();
    if (editMode) setEditMode(editMode);
    else paintEditTarget();
    toast(t("toast.imported").replace("{name}", name));
  } catch (e) {
    console.error("[albedo] import :", e);
    toast(t("toast.importFailed").replace("{e}", e?.message || e));
  } finally {
    setBusy(false);
  }
}

/** True while the library is standing in for the file dialog. */
let importing = false;

async function importFromDisk() {
  if (!viewer.current) return;
  const picked = await tauri?.dialog?.open({
    multiple: false,
    filters: [{ name: t("dlg.models3d"), extensions: SUPPORTED }],
  });
  if (picked) await importPart(picked);
}

/*
 * Two ways in, on a plate under the import glyph.
 *
 * From the disk, which is what it always did and is the only answer for a file
 * that is not in a library. And from the library, which is the answer for
 * everything that *is*: it already holds the scan, the tags and the thumbnails,
 * so choosing what to import there is choosing by looking rather than by
 * remembering a path.
 */
{
  const button = $("part-import");
  const menu = $("import-menu");
  const show = (on) => {
    menu.hidden = !on;
    button.setAttribute("aria-expanded", String(!!on));
  };
  button.addEventListener("click", (e) => {
    if (!viewer.current) return;
    e.stopPropagation();
    show(menu.hidden);
  });
  $("import-disk").addEventListener("click", () => {
    show(false);
    void importFromDisk();
  });
  $("import-library").addEventListener("click", async () => {
    show(false);
    importing = true;
    await toggleLibrary();
    if (!library?.isOpen) library?.show();
    toast(t("toast.chooseToImport"));
  });
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden || menu.contains(e.target) || button.contains(e.target)) return;
    show(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!menu.hidden) show(false);
    // Leaving the library by any route cancels the import it was opened for,
    // or the next ordinary browse would swallow a click as an import.
    importing = false;
  });
}

$("save-transform").addEventListener("click", async () => {
  $("save-note").textContent = "";
  await exportModel();
  $("save-note").textContent = $("export-note").textContent;
});

$("save-over").addEventListener("click", async () => {
  if (!openedPath) return;
  const name = openedPath.split(/[\\/]/).pop();
  const ok = await (tauri?.dialog?.confirm
    ? tauri.dialog.confirm(t("dlg.overwriteAsk").replace("{file}", name), {
        title: t("dlg.overwriteTitle"),
        kind: "warning",
      })
    : Promise.resolve(window.confirm(t("dlg.overwriteAsk").replace("{file}", name))));
  if (!ok) return;
  await exportModel({ overwrite: true });
  $("save-note").textContent = $("export-note").textContent;
  toast(t("toast.overwrite"));
});

// Held, not toggled: the same key that snaps in every other tool
window.addEventListener("keydown", (e) => {
  if (e.key === "Alt") altHeld = true;
  if (editMode && e.key === "Shift") viewer.setGizmoSnap(true);
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Alt") altHeld = false;
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
    const nx = ((e.clientX - box.left) / box.width) * 2 - 1;
    const ny = -((e.clientY - box.top) / box.height) * 2 + 1;

    /*
     * Lights are asked about first, and win outright.
     *
     * A light is an object you point at, like anything else in the outliner, and
     * the only reason it was not one before is that it draws nothing for a ray
     * to hit. Its marker does. Asked before the model because a key light
     * usually sits between the camera and the subject: whoever loses the tie is
     * the one you can never click, and a marker exists to be clicked.
     *
     * Choosing it is all that happens here. The panel follows the selection, the
     * helper is drawn by that, and the handles come up with it — one path from a
     * click in the list and from a click in the viewport, because they are the
     * same act on the same thing.
     */
    const light = viewer.pickLight(nx, ny);
    if (light?.fog) {
      selection.choose(decorId("fog", "main"), "fog", e.ctrlKey || e.metaKey);
      revealBar();
      return;
    }
    if (light) {
      selection.choose(decorId("light", light.id), "light", e.ctrlKey || e.metaKey);
      setLightGizmoMode("translate");
      revealBar();
      return;
    }

    const hit = viewer.pick(nx, ny);
    /*
     * The stand, judged against the model rather than before or after it.
     *
     * Asked outright first, it would have stolen every click aimed at a figure
     * standing on it; asked only when the model missed, it would be unreachable
     * wherever the two overlap, which is most of it. The ray answers the
     * question already — whichever surface it met first is the one being pointed
     * at — so the comparison is the whole of the rule.
     */
    const stand = viewer.pickStand(nx, ny);
    if (stand && (!hit || stand.distance < hit.distance)) {
      selection.choose(decorId("stand", "main"), "stand", e.ctrlKey || e.metaKey);
      revealBar();
      return;
    }
    if (!hit) {
      // A handle is not part of the model, so a click on one lands here as a
      // click on nothing and would put away the very thing being aimed at.
      // The controls name the axis under the pointer, which is the tell.
      if (viewer.gizmo?.axis || viewer.gizmo?.dragging) return;
      // Clicking off the model puts the handles away, the way clicking off
      // anything dismisses it. Escape does the same from the keyboard.
      if (editMode) setEditMode(null);
      selectMaterial(null);
      return;
    }
    const material = materialOfHit(hit);
    selectMaterial(material ? material.uuid : null);
    revealBar();
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

/** "qwerty" | "azerty", once the first keypress has said which. */
let keyLayout = null;
/**
 * Which layout is under the hands.
 *
 * The four keys that swap between QWERTY and AZERTY (A/Q and W/Z) are matched
 * by their physical position in the shortcuts, so the shortcut follows the
 * printed letter instead of the muscle memory: on AZERTY the keycap Z sits
 * where W does on QWERTY, and Ctrl+Z was closing the document rather than
 * undoing. The first keypress reveals the layout (the keycap A is on the QWERTY
 * Q key), and the language is the guess until then.
 */
function detectLayout(e) {
  // The first press of W or A says it all: on AZERTY the keycap W prints z and
  // the keycap A prints q, the exact mirror of QWERTY. Lowercased, so a held
  // shift key does not turn a z into evidence for qwerty.
  if (e.code === "KeyW") keyLayout = e.key.toLowerCase() === "z" ? "azerty" : "qwerty";
  else if (e.code === "KeyA") keyLayout = e.key.toLowerCase() === "q" ? "azerty" : "qwerty";
  return keyLayout || ((navigator.language || "").toLowerCase().startsWith("fr") ? "azerty" : "qwerty");
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
  /*
   * The library takes the keyboard only while it takes the screen.
   *
   * Blocking every shortcut for as long as the library was open made sense when
   * open meant covering the model. It does not with the preview strip out: the
   * model is on screen, beside the grid of files, and the whole point of the
   * split is to work on the one while browsing the other. G, R and S did
   * nothing there, and the only way to reach them was to shut the library.
   *
   * Typing is already safe twice over — the guard above skips inputs, and the
   * search field stops the event before it ever reaches this listener.
   */
  if (library?.isOpen && !library.isPeeking && e.code !== "KeyB") return;
  // On AZERTY, report W/Z and A/Q at the physical positions their letters
  // occupy, so every case below matches the keycap the user reads.
  const azerty = detectLayout(e) === "azerty";
  const code = azerty
    ? { KeyW: "KeyZ", KeyZ: "KeyW", KeyA: "KeyQ", KeyQ: "KeyA" }[e.code] || e.code
    : e.code;
  switch (code) {
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
      toast(t(document.body.classList.contains("clean") ? "toast.uiHidden" : "toast.uiVisible"));
      break;
    case "KeyF":
      if (e.ctrlKey || e.altKey) return;
      e.preventDefault();
      viewer.frameCurrent();
      toast(t("toast.framed"));
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
        toast(t("toast.orbit"));
      }
      break;
    case "KeyC":
      if (e.ctrlKey) {
        e.preventDefault();
        copySelection();
      }
      break;
    case "KeyV":
      if (e.ctrlKey) {
        e.preventDefault();
        pasteClipboard();
      } else {
        hud.setMode("fly");
        toast(t("toast.fly"));
      }
      break;
    /*
     * Escape lets go of things, in the order you are holding them.
     *
     * The handles first, then the selection, then fly mode. Clearing the
     * selection was reachable only through the list's "Tout" button, which also
     * reveals everything hidden — so somebody who merely wanted to stop pointing
     * at one mesh had to undo their own isolation to do it. Selecting nothing is
     * a state the whole application now depends on: it is what puts the handles
     * away, and what makes the comparison fall back to the newest result rather
     * than to whatever happened to be lit.
     */
    case "Escape":
      if (editMode) setEditMode(null);
      else if (selection.size) selection.clear();
      else hud.setMode("orbit");
      break;
    // G, R and S belong to the edit mode while it is on, and to the grid, the
    // roll and nothing at all while it is off. Modal, as in every tool that
    // has more to do than it has letters.
    case "KeyZ":
      if (!e.ctrlKey) break;
      e.preventDefault();
      stepHistory(!e.shiftKey);
      break;
    case "KeyE":
      if (nav.mode === "orbit") setEditMode(editMode ? null : "translate");
      break;
    // G, R and S bring their handle out straight away, with no mode to enter
    // first. That was the mistake: in the tools these keys come from, they act
    // on the spot, and a step nobody expects reads as a feature that is broken.
    // The two bindings they displaced moved onto shift, which is free here
    // because shift only means anything while a handle is already being dragged.
    case "KeyG":
      if (e.shiftKey) {
        const on = !$("opt-grid").checked;
        setGrid(on);
        toast(t(on ? "toast.gridShown" : "toast.gridHidden"));
      } else setEditMode("translate");
      break;
    case "KeyS":
      if (!e.ctrlKey) setEditMode("scale");
      break;
    /*
     * Ctrl+T and Ctrl+W, which mean what they mean everywhere there are tabs.
     *
     * T on its own is still the turntable, and W on its own is still the
     * wireframe. Neither is displaced: a modifier is what tells the two apart,
     * and these are the two chords nobody has to be taught.
     */
    case "KeyT":
      if (e.ctrlKey) {
        e.preventDefault();
        newDocument();
        setTitle("Albedo", true);
        toast(t("toast.newTab"));
      } else if (nav.mode === "orbit") {
        toggleTurntable();
        toast(t(viewer.spin ? "toast.turntableOn" : "toast.turntableOff"));
      }
      break;
    case "KeyU":
      toggleUnlit();
      toast(t(currentChannel === "unlit" ? "pane.standUnlit" : "pane.standPbr"));
      break;
    case "KeyB":
      e.preventDefault();
      toggleLibrary();
      break;
    case "KeyR":
      if (e.shiftKey) {
        nav.resetRoll();
        toast(t("toast.rollReset"));
      } else setEditMode("rotate");
      break;
    case "KeyW":
      if (e.ctrlKey) {
        e.preventDefault();
        if (activeDoc) closeDocument(activeDoc.id);
        break;
      }
      if (nav.mode === "orbit") {
        const on = !$("opt-wireframe").checked;
        setWireframe(on);
        toast(on ? t("toast.wireOn") : t("toast.wireOff"));
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
paintHistory();
paintTransform();
