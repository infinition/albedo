/**
 * Settings that outlive the window.
 *
 * A viewer whose grid, exposure and backdrop reset at every launch makes the
 * user redo the same three clicks forever. These live in roaming AppData under
 * the shell, and in localStorage when the frontend runs in a plain browser, so
 * developing against `npm run dev` behaves the same way.
 *
 * Writes are coalesced: dragging a slider must not hit the disk sixty times a
 * second.
 */

const KEY = "albedo.settings";
const SAVE_DELAY = 400;

export const DEFAULTS = {
  /** Which pane of the shared panel was open. */
  pane: "view",
  /** Cross section: axis, or nothing for a whole model. */
  clipAxis: null,
  clipAt: 0.5,
  /** Photo mode: the picture asked for, not the one the thumbnail wants. */
  shotWidth: 1920,
  shotHeight: 1080,
  shotAlpha: false,
  shotGrid: false,
  shotStand: true,
  grid: true,
  bounds: false,
  skeleton: false,
  wireframe: false,
  /** Only the lines, no surface: a mode of the same overlay. */
  wireOnly: false,
  /** Dark lines rather than light ones: neither works on every model. */
  wireDark: true,
  /** Flat faces rather than smooth ones, for reading the topology. */
  flat: false,
  exposure: 1,
  fov: 45,
  projection: "perspective",
  /** studio | gradient | image */
  environment: "studio",
  /** Absolute path of the panorama, when the environment is an image. */
  environmentPath: null,
  /** Whether the backdrop is drawn at all. */
  environmentBackground: true,
  /** Whether the environment also lights the model, as in any 3D package. */
  environmentLighting: true,
  /** How hard it lights it. */
  environmentIntensity: 1,
  /** The directional fill, on top of the environment. */
  keyLight: true,
  keyLightPower: 1.6,
  keyLightColour: "#ffffff",
  /** How the panorama is framed behind the model. */
  environmentZoom: 1,
  environmentRotation: 0,
  environmentBlur: 0,
  /** Colour stops of the built in gradient, `at` from 0 at the top. */
  gradientStops: [
    { color: "#2b3242", at: 0 },
    { color: "#1b1f28", at: 0.5 },
    { color: "#0d0f14", at: 1 },
  ],
  /** Degrees the whole gradient is rotated around the colour wheel. */
  gradientHue: 0,
  backgroundBrightness: 1,
  /** Absolute path of a model used as a stand, or nothing. */
  pedestal: null,
  /** Where the stand was put by hand, when it was. */
  pedestalTransform: null,
  /** How the stand is lit: shaded or unlit. */
  pedestalShading: "shaded",
  /**
   * Device tuning. Axis inversions especially: a SpaceMouse points its axes
   * whichever way its vendor decided, so the correction found once has to
   * outlive the session that found it.
   */
  devices: {
    padSensitivity: 1,
    padDeadzone: 0.14,
    padInvertY: false,
    spaceTranslation: 1,
    spaceRotation: 1,
    spaceLockRoll: false,
    spaceInvert: { x: false, y: false, z: false, pitch: false, yaw: false, roll: false },
  },
};

export async function createPrefs(tauri) {
  let values = { ...DEFAULTS };
  let timer = null;

  const read = async () => {
    try {
      const raw = tauri
        ? await tauri.core.invoke("load_prefs")
        : localStorage.getItem(KEY);
      if (!raw) return;
      const stored = JSON.parse(raw);
      // Only known keys, so a settings file from a later version cannot inject
      // anything, and an older one simply keeps the defaults it lacks.
      for (const key of Object.keys(DEFAULTS)) {
        if (stored[key] !== undefined) values[key] = stored[key];
      }
    } catch (e) {
      console.warn("[albedo] réglages illisibles, valeurs par défaut:", e);
    }
  };

  const write = async () => {
    const raw = JSON.stringify(values, null, 2);
    try {
      if (tauri) await tauri.core.invoke("save_prefs", { data: raw });
      else localStorage.setItem(KEY, raw);
    } catch (e) {
      console.warn("[albedo] réglages non enregistrés:", e);
    }
  };

  await read();

  return {
    get: (key) => values[key],
    all: () => ({ ...values }),
    set(key, value) {
      // Reference equality would swallow every change to the gradient stops,
      // which are edited in place and handed back as the very same array.
      if (values[key] === value && (value === null || typeof value !== "object")) return;
      values[key] = value;
      clearTimeout(timer);
      timer = setTimeout(write, SAVE_DELAY);
    },
    /** Write immediately, for a change that must not be lost on exit. */
    flush() {
      clearTimeout(timer);
      return write();
    },
  };
}
