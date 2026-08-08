import * as THREE from "three";

/**
 * Camera navigation: keyboard, mouse, gamepad and SpaceMouse.
 *
 * Two modes share one camera. Orbit inspects an object; fly walks through a
 * scene. Every device feeds the same two update paths, so a control added to
 * one is available in both.
 *
 * Keyboard is layout-agnostic: physical key codes are read, so ZQSD and WASD
 * are literally the same keys.
 */

const FLY_KEYS = {
  forward: ["KeyW", "KeyZ", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "KeyQ", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  up: ["Space", "KeyE"],
  down: ["ShiftLeft", "KeyC"],
  boost: ["ControlLeft"],
};

const isKey = (role, code) => FLY_KEYS[role].includes(code);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const HALF_PI = Math.PI / 2 - 0.001;

/**
 * Xbox pads report through the standard mapping, so the indices are fixed.
 * Anything else that claims "standard" lands on the same layout.
 */
const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

/**
 * Decode one 3Dconnexion HID record into `state`.
 *
 * Records come in three shapes: id 1 carries the three translations, id 2 the
 * three rotations, and id 3 a button bitmask. Wireless units skip the split and
 * pack all six axes into id 1. Kept separate from the device plumbing so the
 * byte layout can be exercised without hardware.
 *
 * @returns {number} bitmask of buttons pressed since the previous record
 */
export function decodeSpaceReport(reportId, data, state, norm) {
  const i16 = (o) => (o + 2 <= data.byteLength ? data.getInt16(o, true) : 0);

  if (reportId === 1) {
    state.tx = norm(i16(0));
    state.ty = norm(i16(2));
    state.tz = norm(i16(4));
    if (data.byteLength >= 12) {
      state.rx = norm(i16(6));
      state.ry = norm(i16(8));
      state.rz = norm(i16(10));
    }
    return 0;
  }
  if (reportId === 2) {
    state.rx = norm(i16(0));
    state.ry = norm(i16(2));
    state.rz = norm(i16(4));
    return 0;
  }
  if (reportId === 3) {
    let bits = 0;
    for (let i = 0; i < data.byteLength && i < 4; i++) bits |= data.getUint8(i) << (i * 8);
    const pressed = bits & ~state.buttons;
    state.buttons = bits;
    return pressed;
  }
  return 0;
}

/** Actions a device button can fire; main.js decides what they do. */
export const ACTIONS = {
  FRAME: "frame",
  TOGGLE_MODE: "toggle-mode",
  PLAY_PAUSE: "play-pause",
  NEXT_CHANNEL: "next-channel",
  PREV_CHANNEL: "prev-channel",
  RESET_ROLL: "reset-roll",
};

export class Navigation {
  constructor(viewer, { onAction, onDevice, onMode, onFov, onEnvRotate } = {}) {
    this.viewer = viewer;
    this.onAction = onAction || (() => {});
    this.onDevice = onDevice || (() => {});
    /** Fired while the lens is being opened or closed by a drag. */
    this.onFov = onFov || (() => {});
    /** Fired while the environment is being turned by a drag. */
    this.onEnvRotate = onEnvRotate || (() => {});
    /** Fired whenever the mode changes, including when it changes itself. */
    this.onMode = onMode || (() => {});
    /**
     * Something able to hold the cursor at the window level, when there is a
     * shell to ask. `{ grab(on), show(on), recenter() }`, all fire and forget.
     */
    this.pointer = null;
    this.mode = "orbit";
    this.speed = 1; // world units per second, rescaled per model
    this.pressed = new Set();
    this.look = { x: 0, y: 0, roll: 0 };
    this.gamepadIndex = null;
    this.gamepadName = null;
    this.spaceNav = null;
    this.spaceNavName = null;
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.padPrev = [];

    /** Everything a user may need to correct without touching the code. */
    this.settings = {
      pad: { sensitivity: 1, deadzone: 0.14, invertY: false },
      space: {
        translation: 1,
        rotation: 1,
        deadzone: 0.06,
        // A SpaceMouse reports six signed axes but vendors disagree on which
        // way each one points; these flip an axis without a rebuild.
        invert: { x: false, y: false, z: false, pitch: false, yaw: false, roll: false },
        // One line per axis, as the maker's own panel has it: whether the axis
        // is listened to at all, and how strongly. A cap has six degrees of
        // freedom and a hand has none of the discipline to use one at a time,
        // so switching off the two you did not mean is how the other four
        // become usable. The two speeds above remain as a master for each half.
        on: { x: true, y: true, z: true, pitch: true, yaw: true, roll: true },
        gain: { x: 1, y: 1, z: 1, pitch: 1, yaw: 1, roll: 1 },
        lockRoll: false,
      },
    };

    const canvas = viewer.canvas;

    window.addEventListener("keydown", (e) => {
      if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
      this.pressed.add(e.code);
      if (this.mode === "fly" && this.pressed.size) viewer.invalidate();
    });
    window.addEventListener("keyup", (e) => this.pressed.delete(e.code));
    window.addEventListener("blur", () => this.pressed.clear());

    // Looking around in fly mode.
    //
    // The webview's own pointer capture is not used: it answers with a banner
    // telling the user to press Escape, and no page can dismiss it. The shell
    // can hold the cursor at the window level instead, which is the same effect
    // with no notice; the cursor is hidden and pushed back to the middle before
    // it can reach an edge, so the view turns without end.
    //
    // In a plain browser there is no such shell, and looking falls back to
    // holding the button.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let recentring = false;

    const freeLook = () => this.mode === "fly" && !!this.pointer;

    canvas.addEventListener("mousedown", (e) => {
      if (this.mode !== "fly" || e.button !== 0 || freeLook()) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.classList.add("looking");
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove("looking");
    });
    document.addEventListener("mousemove", (e) => {
      if (this.mode !== "fly") return;
      if (!freeLook() && !dragging) return;
      if (recentring) {
        // The jump we asked for ourselves is not a movement of the hand
        recentring = false;
        lastX = e.clientX;
        lastY = e.clientY;
        return;
      }
      this.look.x -= (e.clientX - lastX) * 0.0022;
      this.look.y = clamp(this.look.y - (e.clientY - lastY) * 0.0022, -HALF_PI, HALF_PI);
      lastX = e.clientX;
      lastY = e.clientY;
      this.applyLook();

      if (!freeLook()) return;
      const margin = 120;
      const nearEdge =
        e.clientX < margin ||
        e.clientY < margin ||
        e.clientX > window.innerWidth - margin ||
        e.clientY > window.innerHeight - margin;
      if (nearEdge) {
        recentring = true;
        this.pointer.recenter();
      }
    });
    // A window that loses focus must not keep the cursor: alt-tab has to work.
    window.addEventListener("blur", () => {
      if (this.mode === "fly") this.releasePointer();
    });
    window.addEventListener("focus", () => {
      if (this.mode === "fly") this.holdPointer();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (this.mode !== "fly") return;
        // in fly mode the wheel sets travel speed, not zoom
        e.preventDefault();
        this.speed = clamp(this.speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1e-4, 1e6);
      },
      { passive: false }
    );

    // Modified drags: Shift swings the key light, Ctrl opens or closes the
    // lens. Both listen on the window in the capture phase so they run before
    // the orbit rig, which would otherwise turn the camera at the same time.
    // Orbit only: Ctrl already means "faster" while flying.
    let lightDrag = false;
    let fovDrag = false;
    let modX = 0;
    let modY = 0;
    let fovStart = 45;
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (this.mode !== "orbit" || e.button !== 0 || e.target !== canvas) return;
        if (!e.shiftKey && !e.ctrlKey) return;
        // While the transform handles are out, shift belongs to them: it is
        // what makes a drag work in steps. This listener captures and stops
        // propagation, so leaving it in place did not merely also swing the
        // light, it took the event before the handle could see it at all.
        if (viewer.gizmo && e.shiftKey) return;
        lightDrag = e.shiftKey;
        fovDrag = !e.shiftKey && e.ctrlKey;
        modX = e.clientX;
        modY = e.clientY;
        fovStart = viewer.fov;
        viewer.controls.enabled = false;
        e.stopPropagation();
      },
      true
    );
    window.addEventListener("pointermove", (e) => {
      if (lightDrag) {
        // Turn whatever is doing the lighting. Under a panorama the fill is
        // beside the point, and swinging it would look like nothing happened.
        if (viewer.lightsFromEnvironment()) {
          this.onEnvRotate(viewer.rotateEnvironment(-(e.clientX - modX) * 0.4));
        } else {
          viewer.orbitLight((e.clientX - modX) * 0.008, (e.clientY - modY) * 0.008);
        }
        modX = e.clientX;
        modY = e.clientY;
        return;
      }
      if (!fovDrag) return;
      // Pulling towards you narrows the lens, the way a zoom ring reads
      const fov = clamp(fovStart + (e.clientY - modY) * 0.2, 10, 100);
      viewer.setFov(fov);
      this.onFov(fov);
    });
    window.addEventListener("pointerup", () => {
      if (!lightDrag && !fovDrag) return;
      lightDrag = false;
      fovDrag = false;
      viewer.controls.enabled = this.mode === "orbit";
    });

    window.addEventListener("gamepadconnected", (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadName = e.gamepad.id;
      this.onDevice("pad", e.gamepad.id);
      viewer.invalidate();
    });
    window.addEventListener("gamepaddisconnected", (e) => {
      if (e.gamepad.index !== this.gamepadIndex) return;
      this.gamepadIndex = null;
      this.gamepadName = null;
      this.onDevice("pad", null);
    });
    // A pad already plugged in when the page loads fires no event.
    this.pollForPad();
  }

  pollForPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      this.gamepadIndex = p.index;
      this.gamepadName = p.id;
      this.onDevice("pad", p.id);
      return;
    }
  }

  /** Speed follows the model: a building and a bolt need different steps. */
  calibrate(box) {
    const size = box.getSize(new THREE.Vector3());
    this.speed = Math.max(size.length() / 6, 1e-4);
  }

  /**
   * Take the cursor at the window level, when running under the shell.
   *
   * `pointer` is supplied by the application: navigation knows nothing about
   * the desktop framework, it only knows there is or is not something able to
   * hold a cursor.
   */
  holdPointer() {
    if (!this.pointer) return;
    this.pointer.grab(true);
    this.pointer.show(false);
    this.pointer.recenter();
  }

  releasePointer() {
    if (!this.pointer) return;
    this.pointer.grab(false);
    this.pointer.show(true);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // Fly is a free camera: the orbit rig would otherwise keep pulling the
    // view back towards its target every time the mouse moved.
    this.viewer.controls.enabled = mode === "orbit";
    if (mode === "fly") {
      const dir = new THREE.Vector3();
      this.viewer.camera.getWorldDirection(dir);
      this.look.x = Math.atan2(-dir.x, -dir.z);
      this.look.y = Math.asin(clamp(dir.y, -1, 1));
      this.look.roll = 0;
      this.holdPointer();
    } else {
      this.releasePointer();
      this.viewer.canvas.classList.remove("looking");
      // Orbit turns around what it is aimed at, so the target follows the
      // camera home instead of being wherever the flight started.
      const c = this.viewer.controls;
      const dir = new THREE.Vector3();
      this.viewer.camera.getWorldDirection(dir);
      const reach = c.target.distanceTo(this.viewer.camera.position) || 1;
      c.target.copy(this.viewer.camera.position).addScaledVector(dir, reach);
      this.viewer.camera.up.set(0, 1, 0);
      c.update();
    }
    this.onMode(mode);
    this.viewer.invalidate();
  }

  applyLook() {
    this.euler.set(this.look.y, this.look.x, 0, "YXZ");
    this.viewer.camera.quaternion.setFromEuler(this.euler);
    if (this.look.roll) {
      // roll lives on top of yaw/pitch so the horizon can tilt without the
      // Euler order fighting it
      this.viewer.camera.quaternion.multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.look.roll)
      );
    }
    this.viewer.invalidate();
  }

  resetRoll() {
    this.look.roll = 0;
    this.viewer.camera.up.set(0, 1, 0);
    this.applyLook();
    this.viewer.controls.update();
    this.viewer.invalidate();
  }

  // -------------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------------

  readGamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    if (!pad) return null;

    const { deadzone, sensitivity, invertY } = this.settings.pad;
    // Radial deadzone on each stick: a per-axis cut makes diagonals crooked.
    const stick = (ax, ay) => {
      const x = pad.axes[ax] || 0;
      const y = pad.axes[ay] || 0;
      const mag = Math.hypot(x, y);
      if (mag < deadzone) return [0, 0];
      const scaled = ((mag - deadzone) / (1 - deadzone)) ** 1.6 / mag;
      return [x * scaled * sensitivity, y * scaled * sensitivity];
    };
    const btn = (i) => pad.buttons[i]?.pressed || false;
    const val = (i) => pad.buttons[i]?.value || 0;

    const [moveX, moveZ] = stick(0, 1);
    const [lookX, lookYRaw] = stick(2, 3);

    // Edge detection so a button fires once per press, not once per frame.
    const fired = [];
    for (let i = 0; i < pad.buttons.length; i++) {
      const now = btn(i);
      if (now && !this.padPrev[i]) fired.push(i);
      this.padPrev[i] = now;
    }
    for (const i of fired) {
      if (i === PAD.Y) this.onAction(ACTIONS.FRAME);
      else if (i === PAD.B) this.onAction(ACTIONS.TOGGLE_MODE);
      else if (i === PAD.A) this.onAction(ACTIONS.PLAY_PAUSE);
      else if (i === PAD.RIGHT) this.onAction(ACTIONS.NEXT_CHANNEL);
      else if (i === PAD.LEFT) this.onAction(ACTIONS.PREV_CHANNEL);
      else if (i === PAD.R3) this.onAction(ACTIONS.RESET_ROLL);
    }

    return {
      moveX,
      moveZ,
      lookX,
      lookY: invertY ? -lookYRaw : lookYRaw,
      up: (btn(PAD.RB) ? 1 : 0) - (btn(PAD.LB) ? 1 : 0),
      dolly: val(PAD.RT) - val(PAD.LT),
      boost: btn(PAD.L3) ? 4 : 1,
    };
  }

  // -------------------------------------------------------------------------
  // SpaceMouse
  // -------------------------------------------------------------------------

  /**
   * 3Dconnexion devices over WebHID, no driver involved.
   *
   * They report six signed 16-bit axes: three translations and three
   * rotations, either as two records (ids 1 and 2) or packed into one on the
   * wireless models. Buttons arrive on id 3.
   */
  async connectSpaceMouse() {
    if (!navigator.hid) throw new Error("WebHID indisponible dans cette webview");
    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: 0x256f }, // 3Dconnexion
        { vendorId: 0x046d, usagePage: 0x01, usage: 0x08 }, // Logitech-era units
      ],
    });
    return this.useSpaceMouse(devices[0]);
  }

  /**
   * Pick up a device the browser already lets us have.
   *
   * WebHID asks for permission once, on a click, and remembers it. After that
   * `getDevices` hands the device back with no gesture at all, so plugging the
   * SpaceMouse in and starting Albedo is enough, the way a gamepad is: the
   * button in the panel is for the first time only. `connect` covers the case
   * where the device arrives while the window is already open.
   *
   * The first authorisation cannot be skipped. It is the webview's rule, not a
   * setting, and the only way past it would be to read the device from the Rust
   * side instead, which is a bigger change and a real option.
   */
  async adoptKnownSpaceMouse() {
    if (!navigator.hid || this.spaceDevice) return null;
    const known = await navigator.hid.getDevices().catch(() => []);
    const device = known.find((d) => d.vendorId === 0x256f || d.vendorId === 0x046d);
    return device ? this.useSpaceMouse(device) : null;
  }

  watchSpaceMouse() {
    if (!navigator.hid || this._watchingHid) return;
    this._watchingHid = true;
    navigator.hid.addEventListener("connect", (e) => {
      if (this.spaceDevice) return;
      const d = e.device;
      if (d.vendorId === 0x256f || d.vendorId === 0x046d) this.useSpaceMouse(d);
    });
    this.adoptKnownSpaceMouse();
  }

  async useSpaceMouse(device) {
    if (!device) return null;
    if (!device.opened) await device.open().catch(() => {});
    if (!device.opened) return null;

    const state = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, buttons: 0 };
    this.spaceNav = state;
    this.spaceNavName = device.productName || "SpaceMouse";
    this.spaceDevice = device;

    // Full deflection is about ±350 on every model seen in the wild.
    const norm = (v) => {
      const s = v / 350;
      return Math.abs(s) < this.settings.space.deadzone ? 0 : clamp(s, -1, 1);
    };

    device.addEventListener("inputreport", (e) => {
      const pressed = decodeSpaceReport(e.reportId, e.data, state, norm);
      if (pressed & 0x1) this.onAction(ACTIONS.FRAME);
      if (pressed & 0x2) this.onAction(ACTIONS.TOGGLE_MODE);
      if (pressed & 0x4) this.onAction(ACTIONS.RESET_ROLL);
      this.viewer.invalidate();
    });

    device.addEventListener("disconnect", () => {
      this.spaceDevice = null;
      this.spaceNav = null;
      this.spaceNavName = null;
      this.onDevice("space", null);
    });

    this.onDevice("space", this.spaceNavName);
    return this.spaceNavName;
  }

  async disconnectSpaceMouse() {
    if (this.spaceDevice?.opened) await this.spaceDevice.close().catch(() => {});
    this.spaceDevice = null;
    this.spaceNav = null;
    this.spaceNavName = null;
    this.onDevice("space", null);
  }

  /**
   * The six axes in viewer terms, with the user's inversions applied.
   * @returns {{x:number,y:number,z:number,pitch:number,yaw:number,roll:number}|null}
   */
  readSpaceMouse() {
    const s = this.spaceNav;
    if (!s) return null;
    const cfg = this.settings.space;
    const t = cfg.translation;
    const r = cfg.rotation;
    // Off is a zero rather than a skipped multiplication, so an axis switched
    // off cannot leak through whatever reads these afterwards.
    const k = (name, master) =>
      (cfg.on?.[name] === false ? 0 : 1) *
      master *
      (cfg.gain?.[name] ?? 1) *
      (cfg.invert[name] ? -1 : 1);
    const axes = {
      x: s.tx * k("x", t), // right
      y: -s.tz * k("y", t), // up: the cap reports downwards
      z: s.ty * k("z", t), // forward, three's -Z
      pitch: -s.rx * k("pitch", r),
      yaw: -s.rz * k("yaw", r),
      roll: cfg.lockRoll ? 0 : -s.ry * k("roll", r),
    };
    const idle =
      !axes.x && !axes.y && !axes.z && !axes.pitch && !axes.yaw && !axes.roll;
    return idle ? null : axes;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /** Called every frame; returns true when the camera moved. */
  update(dt) {
    const pad = this.readGamepad();
    const space = this.readSpaceMouse();
    return this.mode === "orbit"
      ? this.updateOrbit(dt, pad, space)
      : this.updateFly(dt, pad, space);
  }

  updateOrbit(dt, pad, space) {
    const c = this.viewer.controls;
    const cam = this.viewer.camera;
    let moved = false;

    const offset = cam.position.clone().sub(c.target);
    const distance = offset.length();
    const spherical = new THREE.Spherical().setFromVector3(offset);

    const orbit = (dTheta, dPhi) => {
      if (!dTheta && !dPhi) return;
      spherical.theta -= dTheta;
      spherical.phi = clamp(spherical.phi + dPhi, 0.01, Math.PI - 0.01);
      moved = true;
    };
    // Pan keeps the object under the cursor: shift camera and target together.
    const pan = (right, up) => {
      if (!right && !up) return;
      const rightVec = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
      const upVec = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
      const delta = rightVec.multiplyScalar(right).add(upVec.multiplyScalar(up));
      cam.position.add(delta);
      c.target.add(delta);
      moved = true;
    };
    const dolly = (amount) => {
      if (!amount) return;
      spherical.radius = clamp(spherical.radius * (1 - amount), distance * 1e-4, distance * 1e4);
      moved = true;
    };

    if (pad) {
      orbit(pad.lookX * dt * 1.8, pad.lookY * dt * 1.8);
      pan(pad.moveX * distance * dt * 0.9, -pad.moveZ * distance * dt * 0.9);
      dolly(pad.dolly * dt * 1.5);
      if (pad.up) pan(0, pad.up * distance * dt * 0.9);
    }
    if (space) {
      orbit(space.yaw * dt * 2, space.pitch * dt * 2);
      pan(space.x * distance * dt, space.y * distance * dt);
      dolly(space.z * dt * 1.6);
      if (space.roll) {
        // tilt the horizon by rolling the up vector around the view axis
        const axis = new THREE.Vector3().subVectors(c.target, cam.position).normalize();
        cam.up.applyAxisAngle(axis, space.roll * dt * 1.6).normalize();
        moved = true;
      }
    }

    if (!moved) return false;
    offset.setFromSpherical(spherical);
    cam.position.copy(c.target).add(offset);
    cam.lookAt(c.target);
    c.update();
    this.viewer.invalidate();
    return true;
  }

  updateFly(dt, pad, space) {
    const cam = this.viewer.camera;
    let boost = 1;
    for (const code of FLY_KEYS.boost) if (this.pressed.has(code)) boost = 4;
    if (pad) boost = Math.max(boost, pad.boost);

    const move = new THREE.Vector3();
    for (const code of this.pressed) {
      if (isKey("forward", code)) move.z -= 1;
      else if (isKey("back", code)) move.z += 1;
      else if (isKey("left", code)) move.x -= 1;
      else if (isKey("right", code)) move.x += 1;
      else if (isKey("up", code)) move.y += 1;
      else if (isKey("down", code)) move.y -= 1;
    }

    let turned = false;
    if (pad) {
      move.x += pad.moveX;
      move.z += pad.moveZ;
      move.y += pad.up;
      move.z -= pad.dolly;
      if (pad.lookX || pad.lookY) {
        this.look.x -= pad.lookX * dt * 2.2;
        this.look.y = clamp(this.look.y - pad.lookY * dt * 2.2, -HALF_PI, HALF_PI);
        turned = true;
      }
    }
    if (space) {
      move.x += space.x;
      move.y += space.y;
      move.z -= space.z;
      if (space.yaw || space.pitch || space.roll) {
        this.look.x += space.yaw * dt * 2;
        this.look.y = clamp(this.look.y + space.pitch * dt * 2, -HALF_PI, HALF_PI);
        this.look.roll = clamp(this.look.roll + space.roll * dt * 2, -Math.PI, Math.PI);
        turned = true;
      }
    }
    if (turned) this.applyLook();
    if (move.lengthSq() === 0) return turned;

    // Clamp rather than normalise: a half-pushed stick should move at half pace
    if (move.lengthSq() > 1) move.normalize();
    move.multiplyScalar(this.speed * boost * dt);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    cam.position
      .addScaledVector(forward, -move.z)
      .addScaledVector(right, move.x)
      .addScaledVector(up, move.y);
    this.viewer.invalidate();
    return true;
  }
}
