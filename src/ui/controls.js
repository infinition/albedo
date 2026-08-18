import { ACTIONS } from "../viewer/navigation.js";
import { t } from "../i18n/index.js";
import { setPressed } from "./toggle.js";

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

export function wireHud({ viewer, nav, tauri, onNotice, onSettings }) {
  // `tauri` is a getter into the module that owns the handle: it is still null
  // while the shell startup is in flight, so it is read at click time, when it
  // holds whatever the startup settled on.
  const shell = () => tauri();
  // --- navigation mode ---
  // Fly mode can end on its own, when the pointer capture is released, so the
  // buttons follow the navigation rather than the other way round.
  const paintMode = (mode) => {
    const free = mode === "fly";
    setPressed($("nav-free"), free);
    onNotice(mode === "fly" ? t("toast.flyHelp") : "");
  };
  nav.onMode = paintMode;
  paintMode(nav.mode);
  const setMode = (mode) => nav.setMode(mode);
  // A toggle rather than a pair: there is one way a viewer behaves, and this
  // says whether it is held to the middle of the model or not.
  $("nav-free").addEventListener("click", () =>
    setMode(nav.mode === "fly" ? "orbit" : "fly")
  );
  const toggleMode = () => setMode(nav.mode === "orbit" ? "fly" : "orbit");

  // --- framing ---
  $("btn-frame").addEventListener("click", () => viewer.frameCurrent());

  // --- fullscreen ---
  const toggleFullscreen = async () => {
    if (shell()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const next = !(await w.isFullscreen());
      await w.setFullscreen(next);
      document.body.classList.toggle("immersive", next);
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  };
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);

  /*
   * Full screen hides the interface, not only the window frame.
   *
   * Asking for full screen is asking to see the model, so leaving the chrome up
   * answers half the request. Everything goes; a strip along the right edge
   * stays alive as a hover target, which is the one thing that must not, or
   * there is no way back but a shortcut nobody was told about.
   *
   * Tauri's own full screen fires no DOM event, so the class is set from the
   * same call rather than from a listener that would never run for it.
   */
  document.addEventListener("fullscreenchange", () =>
    document.body.classList.toggle("immersive", !!document.fullscreenElement)
  );

  // --- inspector ---
  const inspector = $("inspector");
  const toggleInspector = (force) => {
    const open = force ?? !inspector.classList.contains("open");
    inspector.classList.toggle("open", open);
    inspector.setAttribute("aria-hidden", String(!open));
    document.body.classList.toggle("inspector", open);
    setPressed($("btn-inspector"), open);
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
      if (!name) onNotice(t("toast.noDeviceChosen"));
    } catch (e) {
      onNotice(t("toast.spacemouseError").replace("{msg}", e.message));
    }
  });

  // Plugged in and started is enough, once the device has been allowed once.
  // The button above is for that first time and for letting go on purpose.
  nav.watchSpaceMouse();

  wireDeviceSettings(nav, onSettings);

  return { setMode, toggleMode, toggleFullscreen, toggleInspector };
}

/**
 * Vendors disagree on which way a SpaceMouse axis points, so every axis gets a
 * toggle rather than a hard-coded sign nobody can change.
 */
// Named for the movement of the hand rather than the letter of the axis, since
// the letter is what nobody can map onto a cap they are pushing.
const AXES = [
  ["x", "sm.slide", "sm.slideHint"],
  ["y", "sm.lift", "sm.liftHint"],
  ["z", "sm.push", "sm.pushHint"],
  ["pitch", "sm.pitch", "sm.pitchHint"],
  ["yaw", "sm.yaw", "sm.yawHint"],
  ["roll", "sm.roll", "sm.rollHint"],
];

/**
 * One line per degree of freedom.
 *
 * The maker's own panel gives each axis three things, and it gives them for a
 * reason: a cap has six degrees of freedom and a hand has none of the
 * discipline to move one at a time, so switching off the two you did not mean
 * is what makes the other four usable. Three inversion buttons and two master
 * speeds could not express that.
 *
 * Built rather than written out, because six identical rows in the markup is
 * six chances for one of them to drift from the others.
 */
function wireDeviceSettings(nav, onChange = () => {}) {
  const holder = $("sm-invert");
  const cfg = nav.settings.space;
  for (const [key, labelKey, hintKey] of AXES) {
    const label = t(labelKey);
    const hint = t(hintKey);
    const row = document.createElement("div");
    row.className = "axis-row";

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = cfg.on?.[key] !== false;
    on.title = t("pane.smListenTitle").replace("{label}", label);

    const name = document.createElement("span");
    name.className = "axis-name";
    name.textContent = label;
    name.title = hint;

    const gain = document.createElement("input");
    gain.type = "range";
    gain.min = "0";
    gain.max = "3";
    gain.step = "0.05";
    gain.value = String(cfg.gain?.[key] ?? 1);
    gain.dataset.novalue = "";
    gain.title = t("pane.smSpeedTitle").replace("{label}", label);

    const value = document.createElement("span");
    value.className = "axis-value mono";
    const paint = () => {
      value.textContent = Number(gain.value).toFixed(2);
      row.classList.toggle("muted", !on.checked);
      gain.disabled = !on.checked;
    };

    // A correction restored from the settings file has to show as pressed,
    // otherwise the panel disagrees with what the device is actually doing.
    const flip = document.createElement("button");
    flip.type = "button";
    flip.className = "seg";
    flip.textContent = "±";
    flip.title = t("pane.smInvertTitle").replace("{label}", label);
    flip.classList.toggle("active", !!cfg.invert[key]);

    on.addEventListener("change", () => {
      (cfg.on ||= {})[key] = on.checked;
      paint();
      onChange();
    });
    gain.addEventListener("input", () => {
      (cfg.gain ||= {})[key] = Number(gain.value);
      paint();
      onChange();
    });
    flip.addEventListener("click", () => {
      cfg.invert[key] = !cfg.invert[key];
      flip.classList.toggle("active", cfg.invert[key]);
      onChange();
    });

    paint();
    row.append(on, name, gain, value, flip);
    holder.appendChild(row);
  }

  const bind = (id, apply, initial) => {
    const el = $(id);
    if (!el) return;
    if (initial !== undefined) {
      if (el.type === "checkbox") el.checked = !!initial;
      else el.value = String(initial);
    }
    const evt = el.type === "checkbox" ? "change" : "input";
    el.addEventListener(evt, () => {
      apply(el.type === "checkbox" ? el.checked : Number(el.value));
      onChange();
    });
  };
  const s = nav.settings;
  bind("pad-sens", (v) => (s.pad.sensitivity = v), s.pad.sensitivity);
  bind("pad-dead", (v) => (s.pad.deadzone = v), s.pad.deadzone);
  bind("pad-inverty", (v) => (s.pad.invertY = v), s.pad.invertY);
  bind("sm-trans", (v) => (s.space.translation = v), s.space.translation);
  bind("sm-rot", (v) => (s.space.rotation = v), s.space.rotation);
  bind("sm-lockroll", (v) => (s.space.lockRoll = v), s.space.lockRoll);
}

/** Show which devices are live, both in the panel and on the viewport. */
export function showDevice(kind, name) {
  const strip = $("devices");
  const id = `dev-${kind}`;
  const existing = document.getElementById(id);
  if (!name) {
    existing?.remove();
    if (kind === "pad") $("dev-pad").textContent = t("dev.padNone");
    if (kind === "space") $("btn-spacemouse").textContent = t("dev.spaceConnect");
    return;
  }
  if (!existing) {
    const el = document.createElement("span");
    el.id = id;
    el.className = "dot";
    el.textContent = kind === "pad" ? t("dev.padDot") : "spacemouse";
    el.title = name;
    strip.appendChild(el);
  }
  if (kind === "pad") $("dev-pad").textContent = t("dev.padNamed").replace("{name}", name);
  if (kind === "space") $("btn-spacemouse").textContent = t("dev.spaceDisconnect").replace("{name}", name);
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

  /*
   * Stepping, and why it is a thirtieth of a second rather than "a frame".
   *
   * A glTF clip carries keyframe times and no frame rate: there is no honest
   * answer to "which frame is this". So the step is a fixed, small, familiar
   * increment — the size of a frame in the rate most people work at — and the
   * buttons say "image précédente" as a description of the gesture rather than a
   * claim about the file. Printing an invented frame number next to it would be
   * the dishonest version of the same convenience.
   */
  const STEP = 1 / 30;
  const step = (dir) => {
    if (!state.action) return;
    if (viewer.playing) toggle();
    const d = state.duration || 1;
    setTime((((now() + dir * STEP) % d) + d) % d);
  };
  $("anim-prev").addEventListener("click", () => step(-1));
  $("anim-next").addEventListener("click", () => step(1));

  /*
   * Looping, as the two three.js constants rather than an import.
   *
   * `LoopRepeat` is 2201 and `LoopOnce` 2200. This module is parsed at startup —
   * it is the HUD — and pulling three in for two integers is weight on the path
   * that every Explorer thumbnail job also walks.
   */
  const LOOP_REPEAT = 2201;
  const LOOP_ONCE = 2200;
  const loop = $("anim-loop");
  const setLoop = (on) => {
    state.loop = on;
    setPressed(loop, on);
    if (state.action) {
      state.action.loop = on ? LOOP_REPEAT : LOOP_ONCE;
      state.action.clampWhenFinished = !on;
    }
    viewer.invalidate();
  };
  state.loop = true;
  loop.addEventListener("click", () => setLoop(!state.loop));

  /** Slower is the whole point: a foot plant is four frames at full speed. */
  const setSpeed = (v) => {
    state.speed = v;
    for (const b of document.querySelectorAll("[data-speed]")) {
      b.classList.toggle("active", Number(b.dataset.speed) === v);
    }
    if (state.action) state.action.timeScale = v;
    viewer.invalidate();
  };
  state.speed = 1;
  for (const b of document.querySelectorAll("[data-speed]")) {
    b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));
  }

  return {
    attach(action, duration) {
      state.action = action;
      state.duration = duration || 0;
      range.max = String(state.duration || 1);
      // The loop and the speed belong to the transport, not to the clip: a new
      // action arrives at its own defaults and has to be told what the buttons
      // already say, or the controls would lie about what is playing.
      if (action) {
        action.loop = state.loop ? LOOP_REPEAT : LOOP_ONCE;
        action.clampWhenFinished = !state.loop;
        action.timeScale = state.speed;
      }
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
