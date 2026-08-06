import { ACTIONS } from "../viewer/navigation.js";

/**
 * Overlay wiring: navigation, framing, fullscreen, the inspector panel, device
 * settings and the animation scrubber.
 *
 * Nothing here touches the scene directly; it drives the viewer and the
 * navigation and reports back through callbacks, so the UI stays replaceable.
 */
const $ = (id) => document.getElementById(id);

const PLAY = "M8 5l11 7-11 7z";
const PAUSE = "M8 5h3v14H8zM13 5h3v14h-3z";

export function wireHud({ viewer, nav, tauri, onNotice }) {
  // --- navigation mode ---
  const setMode = (mode) => {
    nav.setMode(mode);
    $("nav-orbit").classList.toggle("active", mode === "orbit");
    $("nav-fly").classList.toggle("active", mode === "fly");
    onNotice(
      mode === "fly"
        ? "Vol : ZQSD/WASD, Espace monte, Maj descend, clic capture la souris, molette règle la vitesse"
        : ""
    );
  };
  $("nav-orbit").addEventListener("click", () => setMode("orbit"));
  $("nav-fly").addEventListener("click", () => setMode("fly"));
  const toggleMode = () => setMode(nav.mode === "orbit" ? "fly" : "orbit");

  // --- framing ---
  $("btn-frame").addEventListener("click", () => viewer.frameCurrent());

  // --- fullscreen ---
  const toggleFullscreen = async () => {
    if (tauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  };
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);

  // --- inspector ---
  const inspector = $("inspector");
  const toggleInspector = (force) => {
    const open = force ?? !inspector.classList.contains("open");
    inspector.classList.toggle("open", open);
    inspector.setAttribute("aria-hidden", String(!open));
    document.body.classList.toggle("inspector", open);
    $("btn-inspector").classList.toggle("active", open);
    $("btn-inspector").setAttribute("aria-pressed", String(open));
  };
  $("btn-inspector").addEventListener("click", () => toggleInspector());

  // --- SpaceMouse ---
  $("btn-spacemouse").addEventListener("click", async () => {
    if (nav.spaceNav) {
      await nav.disconnectSpaceMouse();
      return;
    }
    try {
      const name = await nav.connectSpaceMouse();
      if (!name) onNotice("Aucun périphérique choisi");
    } catch (e) {
      onNotice(`SpaceMouse : ${e.message}`);
    }
  });

  wireDeviceSettings(nav);

  return { setMode, toggleMode, toggleFullscreen, toggleInspector };
}

/**
 * Vendors disagree on which way a SpaceMouse axis points, so every axis gets a
 * toggle rather than a hard-coded sign nobody can change.
 */
const AXES = [
  ["x", "X"],
  ["y", "Y"],
  ["z", "Z"],
  ["pitch", "Tang."],
  ["yaw", "Lacet"],
  ["roll", "Roulis"],
];

function wireDeviceSettings(nav) {
  const holder = $("sm-invert");
  for (const [key, label] of AXES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = `Inverser ${label}`;
    b.addEventListener("click", () => {
      const inv = nav.settings.space.invert;
      inv[key] = !inv[key];
      b.classList.toggle("active", inv[key]);
    });
    holder.appendChild(b);
  }

  const bind = (id, apply, initial) => {
    const el = $(id);
    if (!el) return;
    if (initial !== undefined) el.value = String(initial);
    const evt = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(evt, () =>
      apply(el.type === "checkbox" ? el.checked : Number(el.value))
    );
  };
  const s = nav.settings;
  bind("pad-sens", (v) => (s.pad.sensitivity = v), s.pad.sensitivity);
  bind("pad-dead", (v) => (s.pad.deadzone = v), s.pad.deadzone);
  bind("pad-inverty", (v) => (s.pad.invertY = v));
  bind("sm-trans", (v) => (s.space.translation = v), s.space.translation);
  bind("sm-rot", (v) => (s.space.rotation = v), s.space.rotation);
  bind("sm-lockroll", (v) => (s.space.lockRoll = v));
}

/** Show which devices are live, both in the panel and on the viewport. */
export function showDevice(kind, name) {
  const strip = $("devices");
  const id = `dev-${kind}`;
  const existing = document.getElementById(id);
  if (!name) {
    existing?.remove();
    if (kind === "pad") $("dev-pad").textContent = "Manette : aucune détectée";
    if (kind === "space") $("btn-spacemouse").textContent = "Connecter une SpaceMouse";
    return;
  }
  if (!existing) {
    const el = document.createElement("span");
    el.id = id;
    el.className = "dot";
    el.textContent = kind === "pad" ? "manette" : "spacemouse";
    el.title = name;
    strip.appendChild(el);
  }
  if (kind === "pad") $("dev-pad").textContent = `Manette : ${name}`;
  if (kind === "space") $("btn-spacemouse").textContent = `Déconnecter ${name}`;
}

/**
 * One scrubber and one clip picker, kept in step with the mixer.
 */
export function wireTimeline({ viewer, onState }) {
  const play = $("anim-play");
  const icon = $("icon-play");
  const range = $("anim-time");
  const clock = $("anim-clock");

  const state = { action: null, duration: 0, scrubbing: false };

  // The action's own clock is what poses the model, and it is the only one
  // that stays right while scrubbing: the mixer's clock keeps running with the
  // frame loop even when the action is paused.
  const now = () => {
    if (!state.action) return 0;
    const d = state.duration || 1;
    return ((state.action.time % d) + d) % d;
  };

  const paint = () => {
    const t = now();
    if (!state.scrubbing) range.value = String(t);
    clock.textContent = `${t.toFixed(2)} / ${state.duration.toFixed(2)} s`;
    icon.setAttribute("d", viewer.playing ? PAUSE : PLAY);
    play.title = viewer.playing ? "Pause (Espace)" : "Lecture (Espace)";
    if (onState) onState(viewer.playing);
  };

  /**
   * Scrub to an instant.
   *
   * A paused action has an effective time scale of zero, so `mixer.setTime()`
   * hands it a delta of zero and the pose never moves: the model would snap to
   * the first frame and stay there for the whole drag. Setting the action's
   * time directly and asking the mixer for a zero-length step re-evaluates the
   * tracks and applies the pose, which makes the drag follow frame by frame.
   */
  const setTime = (t) => {
    if (!viewer.mixer || !state.action) return;
    state.action.time = Math.max(0, Math.min(state.duration, t));
    viewer.mixer.update(0);
    viewer.invalidate();
    paint();
  };

  const toggle = () => {
    if (!state.action) return;
    viewer.playing = !viewer.playing;
    state.action.paused = !viewer.playing;
    viewer.invalidate();
    paint();
  };

  play.addEventListener("click", toggle);
  range.addEventListener("pointerdown", () => {
    state.scrubbing = true;
    if (viewer.playing) toggle();
  });
  range.addEventListener("pointerup", () => (state.scrubbing = false));
  range.addEventListener("input", (e) => setTime(Number(e.target.value)));

  return {
    attach(action, duration) {
      state.action = action;
      state.duration = duration || 0;
      range.max = String(state.duration || 1);
      // A clip of zero length is a bind pose, not an animation: showing a
      // scrubber that cannot move would only be in the way.
      $("timeline").hidden = !action || state.duration <= 0;
      paint();
    },
    toggle,
    paint,
    get scrubbing() {
      return state.scrubbing;
    },
  };
}

export { ACTIONS };
