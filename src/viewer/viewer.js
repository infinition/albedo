import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { releaseSubtree, texturesOf } from "./release.js";

/** Where the gradient starts before anyone touches it. */
export const DEFAULT_STOPS = [
  { color: "#2b3242", at: 0 },
  { color: "#1b1f28", at: 0.5 },
  { color: "#0d0f14", at: 1 },
];

/**
 * Rotate a colour around the wheel, in plain sRGB.
 *
 * Deliberately not three's `Color`: its `getHSL` reads in the linear working
 * space while `setHSL` writes in sRGB, so a round trip through them crushes the
 * lightness and turns a saturated blue into near black. Doing the arithmetic
 * here also means the preview strip and the texture use the very same function,
 * and cannot disagree.
 *
 * @param {string} hex `#rrggbb`
 * @param {number} degrees
 * @returns {string} `#rrggbb`
 */
export function shiftHue(hex, degrees) {
  if (!degrees) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (h + degrees / 360 + 1) % 1;

  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const out = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
    .join("");
  return `#${out}`;
}

/**
 * Scene host: renders on demand only.
 *
 * A viewer that redraws 60 times a second while nothing moves burns battery
 * and makes the whole window feel sluggish under load. Every mutation calls
 * invalidate(); the loop otherwise idles.
 */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.needsRender = true;
    this.clock = new THREE.Clock();
    this.mixer = null;
    this.current = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The scene paints its own opaque background, so this costs nothing in
      // the window; it is what lets a thumbnail come out with a clear one.
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    this.fov = 45;
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 10000);
    this.camera.position.set(2.5, 1.8, 3);
    this.perspective = this.camera;
    this.ortho = null;

    this.controls = this.makeControls(this.camera);

    // Neutral studio lighting, generated: no HDRI to ship, no license to track.
    // Built on demand, see studio(): an empty viewport has nothing to light.
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.studioMap = null;
    this.envMap = null;
    this.envKind = "studio";
    this.envPanorama = null;
    this.panoramaSource = null;
    /** Whether the backdrop is drawn at all, lighting is a separate question. */
    this.showEnvBackground = true;
    /** Whether a panorama also lights the model. */
    this.envLighting = true;
    this.framing = { zoom: 1, rotation: 0, blur: 0 };
    this.solidBackground = new THREE.Color(0x14161a);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.keyLight.position.set(3, 6, 4);
    this.scene.add(this.keyLight);

    // Lights the user adds, kept in their own group so clearing a model never
    // takes the rig with it.
    this.rig = new THREE.Group();
    this.scene.add(this.rig);
    this.lights = [];
    this.lightHelper = null;
    this.selectedLight = null;
    this._lightSeq = 0;

    this.grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x272c35);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    this.scene.add(this.grid);

    this.boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x4c8dff);
    this.boxHelper.visible = false;
    this.scene.add(this.boxHelper);

    /** The meshes one material covers, ringed while it is selected. */
    this.selected = [];

    /** Turntable speed in radians per second; zero means still. */
    this.spin = 0;

    this.skeletons = new THREE.Group();
    this.skeletons.visible = false;
    this.scene.add(this.skeletons);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    /**
     * What the scene is made of, in the order it arrived.
     *
     * The first entry is the file that was opened; the rest were imported into
     * it. Statistics, picking, the material list and the export already read
     * the whole group, so this list exists to name the pieces and to say which
     * one the handles act on, not to hold the geometry twice.
     * @type {{object: any, name: string}[]}
     */
    this.parts = [];

    // The stand lives outside the model's group: it must survive loading
    // another file, and it must never be counted as part of what was opened.
    this.stand = new THREE.Group();
    this.scene.add(this.stand);
    this.pedestal = null;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.loop();
  }

  invalidate() {
    this.needsRender = true;
  }

  makeControls(camera) {
    const controls = new OrbitControls(camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.addEventListener("change", () => this.invalidate());
    return controls;
  }

  /**
   * Field of view, in degrees.
   *
   * A narrow angle flattens perspective the way a long lens does, which is how
   * a shape is read without its proportions arguing; a wide one exaggerates
   * depth. The orthographic frustum follows the same number so switching
   * projection keeps the model the same size on screen.
   */
  setFov(degrees) {
    this.fov = Math.min(120, Math.max(5, degrees));
    this.perspective.fov = this.fov;
    this.perspective.updateProjectionMatrix();
    if (this.camera.isOrthographicCamera) this.syncOrtho();
    this.invalidate();
  }

  /** @param {"perspective"|"orthographic"} kind */
  setProjection(kind) {
    const wantOrtho = kind === "orthographic";
    if (wantOrtho === !!this.camera.isOrthographicCamera) return;

    if (wantOrtho) {
      if (!this.ortho) this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10000);
      this.ortho.position.copy(this.camera.position);
      this.ortho.quaternion.copy(this.camera.quaternion);
      this.ortho.up.copy(this.camera.up);
      this.camera = this.ortho;
      this.syncOrtho();
    } else {
      this.perspective.position.copy(this.camera.position);
      this.perspective.quaternion.copy(this.camera.quaternion);
      this.perspective.up.copy(this.camera.up);
      this.camera = this.perspective;
      this.camera.updateProjectionMatrix();
    }
    // The rig holds its camera from construction, so it is rebuilt rather than
    // reassigned behind its back.
    const target = this.controls.target.clone();
    const enabled = this.controls.enabled;
    this.controls.dispose();
    this.controls = this.makeControls(this.camera);
    this.controls.target.copy(target);
    this.controls.enabled = enabled;
    this.controls.update();
    // The passes hold the camera they were built with, not the viewer's field
    this.post?.setCamera(this.camera);
    this.invalidate();
  }

  /** Match the orthographic box to what the perspective camera would see. */
  syncOrtho(forced) {
    if (!this.ortho) return;
    const el = this.canvas.parentElement;
    const aspect = forced || (el.clientWidth || 1) / (el.clientHeight || 1);
    const distance = Math.max(1e-4, this.ortho.position.distanceTo(this.controls?.target ?? new THREE.Vector3()));
    const height = 2 * distance * Math.tan((this.fov * Math.PI) / 360);
    const width = height * aspect;
    this.ortho.left = -width / 2;
    this.ortho.right = width / 2;
    this.ortho.top = height / 2;
    this.ortho.bottom = -height / 2;
    this.ortho.near = Math.max(distance / 1000, 1e-4);
    this.ortho.far = distance * 1000;
    this.ortho.updateProjectionMatrix();
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    if (this.camera.isOrthographicCamera) {
      this.syncOrtho();
    } else {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.post?.setSize(w, h);
    this.invalidate();
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = this.clock.getDelta();
    if (this.onFrame) this.onFrame(dt);
    if (this.spin) {
      // Turn the camera around the target rather than the model itself: a
      // rotating model would drag its lighting with it and read as a shading
      // change instead of a look around.
      const offset = this.camera.position.clone().sub(this.controls.target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.spin * dt);
      this.camera.position.copy(this.controls.target).add(offset);
      this.camera.lookAt(this.controls.target);
      this.needsRender = true;
    }
    if (this.mixer && this.playing) {
      this.mixer.update(dt);
      this.needsRender = true;
    }
    if (this.controls.enableDamping) this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.draw(dt);
  }

  /**
   * One frame, through the effect chain when there is one to go through.
   *
   * Grain moves on its own, so the chain asks for a frame of its own accord;
   * everything else still redraws only when something changed.
   */
  draw(dt = 0) {
    if (this.post?.active) {
      this.post.render(dt);
      if (this.post.settings.grade.on && this.post.settings.grade.grain > 0) this.needsRender = true;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Close the clip planes around the subject, and remember what they were.
   *
   * Framing leaves a span of a million to one, which draws fine and resolves no
   * depth at all. Anything reading the depth buffer needs the range closed
   * first; only the caller knows for how long, so it says when to open it again.
   */
  tightenClip(near, far) {
    if (!this.camera.isPerspectiveCamera) return;
    this.wideClip ||= { near: this.camera.near, far: this.camera.far };
    this.camera.near = Math.max(1e-4, near);
    this.camera.far = Math.max(this.camera.near * 1.001, far);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  restoreClip() {
    if (!this.wideClip) return;
    this.camera.near = this.wideClip.near;
    this.camera.far = this.wideClip.far;
    this.camera.updateProjectionMatrix();
    this.wideClip = null;
    this.invalidate();
  }

  /**
   * Bring up the effect chain, once, the first time one is asked for.
   * @returns {Promise<import("./post.js").PostFx>}
   */
  async effects() {
    if (!this.post) {
      const { PostFx } = await import("./post.js");
      this.post = await PostFx.create(this);
      const size = this.renderer.getSize(new THREE.Vector2());
      this.post.setSize(size.x, size.y);
    }
    return this.post;
  }

  /**
   * Textures the scene owns.
   *
   * They are reached from a model's materials but do not belong to it, so a
   * model going away must not take them: the environment would come back black
   * and the UV checker would come back blank.
   */
  /**
   * Textures that must survive whatever is being released.
   *
   * The scene's own, plus whatever the host says is still needed elsewhere.
   * That second half exists because of tabs: two models referencing the same
   * image share one texture object, so a load that replaces the live scene would
   * otherwise free a texture a parked tab is sitting on, and that tab would come
   * back with a black surface. The viewer cannot know about parked documents,
   * and the host cannot know when a release is about to happen, so the two meet
   * on this hook.
   *
   * @type {null | (() => Iterable<any>)}
   */
  alsoKeep = null;

  keptTextures() {
    const extra = this.alsoKeep?.() || [];
    return new Set(
      [
        ...extra,
        this.studioMap,
        this.envMap,
        this.envPanorama,
        this.panoramaSource,
        this.gradient,
        this.framedTexture,
        this.scene.background,
        this.scene.environment,
      ].filter((t) => t && t.isTexture)
    );
  }

  clear() {
    // Detaching is not releasing. Without this every model looked at in one
    // session stayed on the card until the window closed, which the preview
    // strip turned from a curiosity into a habit.
    const keep = this.keptTextures();
    releaseSubtree(this.root, keep);
    // The helpers are built here rather than loaded, and are just as real
    releaseSubtree(this.skeletons, keep);
    this.root.clear();
    this.skeletons.clear();
    this.parts = [];
    this.mixer = null;
    this.current = null;
    this.selected = [];
    this.post?.outline([]);
    this.invalidate();
  }

  /**
   * Ring the meshes that carry one material.
   *
   * A list of names says which materials exist; it never says which part of the
   * model each one covers. Pass nothing to clear.
   */
  highlight(meshes) {
    const wanted = meshes && meshes.length ? [...meshes] : [];
    this.selected = wanted;
    // The box is gone: it said roughly where a thing was and nothing about its
    // shape, which on a mesh threaded through the middle of a model is no
    // answer. The outline follows the silhouette, and lives in the effect
    // chain, so it is brought up the first time something is picked.
    if (!wanted.length && !this.post) {
      this.invalidate();
      return;
    }
    this.effects().then((fx) => fx.outline(wanted));
  }

  /**
   * What the pointer is over, or nothing.
   *
   * Only what is drawn counts: a hidden mesh, a helper and the stand are all in
   * the scene and none of them is the model.
   * @param {number} x normalised device coordinate
   * @param {number} y normalised device coordinate
   */
  pick(x, y) {
    if (!this.current) return null;
    this._ray ||= new THREE.Raycaster();
    this._ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = this._ray.intersectObject(this.root, true);
    for (const hit of hits) {
      const o = hit.object;
      if (!o.visible || (!o.isMesh && !o.isSkinnedMesh)) continue;
      let ancestor = o.parent;
      let shown = true;
      while (ancestor && shown) {
        if (!ancestor.visible) shown = false;
        ancestor = ancestor.parent;
      }
      if (shown) return hit;
    }
    return null;
  }

  /**
   * The backdrop, from whatever the environment currently is.
   *
   * Kept apart from the lighting on purpose: a panorama can light a model
   * without being shown, which is what an inspection tool usually wants, and a
   * gradient can be shown without pretending to light anything.
   */
  applyBackground() {
    if (!this.showEnvBackground) {
      this.scene.background = this.solidBackground;
    } else if (this.envKind === "image" && this.envPanorama) {
      this.scene.background = this.envPanorama;
    } else if (this.envKind === "gradient" && this.gradient) {
      this.scene.background = this.gradient;
    } else {
      this.scene.background = this.solidBackground;
    }
    this.invalidate();
  }

  /**
   * A vertical sweep through the given stops, built here rather than shipped.
   *
   * The hue shift moves every stop around the wheel at once, which is what
   * makes one set of stops usable for a whole range of moods without editing
   * each colour by hand.
   *
   * @param {{color: string, at: number}[]} stops sorted or not, `at` in 0..1
   * @param {number} hue degrees to rotate every stop by
   */
  setGradient(stops, hue = 0) {
    const list = (stops && stops.length ? [...stops] : DEFAULT_STOPS).sort((a, b) => a.at - b.at);
    const canvas = this.gradientCanvas || document.createElement("canvas");
    this.gradientCanvas = canvas;
    canvas.width = 16;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    for (const stop of list) {
      grad.addColorStop(Math.min(1, Math.max(0, stop.at)), shiftHue(stop.color, hue));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // A new texture object every time, deliberately. three caches the
    // background it built from an equirectangular map against the texture's
    // identity and never looks at its version, so redrawing the canvas and
    // raising `needsUpdate` changed nothing on screen: the colours only
    // appeared at the next launch, when the object happened to be new.
    if (this.gradient) this.gradient.dispose();
    this.gradient = new THREE.CanvasTexture(canvas);
    this.gradient.colorSpace = THREE.SRGBColorSpace;
    this.gradient.mapping = THREE.EquirectangularReflectionMapping;
    if (this.envKind === "gradient") {
      // When the gradient is also the light, its colours have to reach the
      // probe too, or the model would keep the shading of the previous set.
      if (this.envLighting !== false) this.applyLighting();
      this.applyBackground();
    }
    return this.gradient;
  }

  gradientTexture() {
    return this.gradient || this.setGradient(DEFAULT_STOPS, 0);
  }

  /**
   * Cut the model open along one axis.
   *
   * Looking inside a closed shape otherwise means hiding materials one by one
   * or trusting the wireframe. The cut is not capped: the far side of the
   * surface shows through, which is honest about the model being a shell and
   * not a solid.
   *
   * @param {{axis?: "x"|"y"|"z", at?: number, on?: boolean}} options `at` in 0..1
   */
  setClipping({ axis, at, on } = {}) {
    this.clip = {
      axis: axis ?? this.clip?.axis ?? "x",
      at: at ?? this.clip?.at ?? 0.5,
      on: on ?? this.clip?.on ?? false,
    };
    const box = this.boxHelper.box;
    if (!this.clip.on || box.isEmpty()) {
      this.renderer.clippingPlanes = [];
      this.invalidate();
      return;
    }
    const normal = new THREE.Vector3(
      this.clip.axis === "x" ? -1 : 0,
      this.clip.axis === "y" ? -1 : 0,
      this.clip.axis === "z" ? -1 : 0
    );
    const min = box.min[this.clip.axis];
    const max = box.max[this.clip.axis];
    // A hair beyond each end, so the slider can also show the model whole
    const where = min + (max - min) * this.clip.at;
    this.renderer.clippingPlanes = [new THREE.Plane(normal, where)];
    this.invalidate();
  }

  /** How bright the backdrop is drawn, without touching the lighting. */
  setBackgroundBrightness(value) {
    this.scene.backgroundIntensity = Math.max(0, value);
    this.invalidate();
  }

  /**
   * How the panorama is framed behind the model: zoom, turn and softness.
   *
   * The blur is drawn here rather than handed to `scene.backgroundBlurriness`,
   * which only works on a texture that came out of the PMREM generator and
   * silently renders a flat dark field on a plain equirectangular one. That is
   * what made the backdrop look dead the moment the blur slider moved.
   *
   * Composing the backdrop ourselves also puts zoom and rotation in the same
   * pass, and leaves the original texture untouched for the lighting, so a
   * blurred backdrop still lights the model with the full panorama.
   */
  setFraming({ zoom, rotation, blur } = {}) {
    this.framing = {
      zoom: zoom ?? this.framing?.zoom ?? 1,
      rotation: rotation ?? this.framing?.rotation ?? 0,
      blur: blur ?? this.framing?.blur ?? 0,
    };
    // three's own rotation is free and exact, so the canvas only has to do the
    // things it cannot: magnify and soften.
    this.scene.backgroundRotation.y = (this.framing.rotation * Math.PI) / 180;
    this.scene.environmentRotation.y = (this.framing.rotation * Math.PI) / 180;
    if (this.envKind === "image") this.composePanorama();
    this.invalidate();
  }

  /**
   * Whether the environment also lights the model, or only sits behind it.
   *
   * Applies to a gradient as much as to a panorama: three colours make a soft,
   * directionless light, which is exactly what some models want.
   */
  setEnvironmentLighting(on) {
    this.envLighting = on !== false;
    this.applyLighting();
  }

  /** How hard the environment lights the model, the main dial in a PBR view. */
  setEnvironmentIntensity(value) {
    this.scene.environmentIntensity = Math.max(0, value);
    this.invalidate();
  }

  /** The directional fill, which a panorama usually makes unnecessary. */
  setKeyLight(on) {
    this.keyLight.visible = on !== false;
    this.invalidate();
  }

  /** How hard the fill hits, and what colour it is. */
  setKeyLightPower(value) {
    this.keyLight.intensity = Math.max(0, value);
    this.invalidate();
  }

  setKeyLightColour(hex) {
    this.keyLight.color.set(hex);
    this.invalidate();
  }

  /**
   * Whether a panorama is what actually lights the model.
   *
   * This decides what the rotate gesture turns: in a PBR viewer the light is
   * the environment, so turning the fill instead would do nothing visible.
   */
  lightsFromEnvironment() {
    return this.envKind === "image" && this.envLighting !== false;
  }

  /** Turn the environment, and say where it ended up. */
  rotateEnvironment(degrees) {
    const raw = (this.framing?.rotation || 0) + degrees;
    const rotation = Math.round((((raw + 180) % 360) + 360) % 360) - 180;
    this.setFraming({ rotation });
    return rotation;
  }

  /**
   * Set what lights the model, and what sits behind it.
   *
   * @param {"studio"|"gradient"|"image"} kind
   * @param {string} [url] panorama to load when the kind is an image
   */
  async setEnvironment(kind, url) {
    if (kind === "image" && url) {
      const panorama = await this.loadPanorama(url);
      if (!panorama) return false;
      if (this.panoramaSource && this.panoramaSource !== panorama) this.panoramaSource.dispose();
      this.panoramaSource = panorama;
      this.envKind = "image";
      this.applyPanorama();
      return true;
    }
    if (kind === "gradient") {
      this.gradientTexture();
      this.envKind = "gradient";
    } else {
      this.envKind = "studio";
    }
    this.applyLighting();
    this.applyBackground();
    return true;
  }

  /**
   * Light the scene from the panorama, and build the backdrop it shows.
   *
   * The two are separate on purpose: the lighting always comes from the source
   * at full range, so softening or magnifying the backdrop never changes how
   * the model is lit.
   */
  applyPanorama() {
    if (!this.panoramaSource) return;
    this.applyLighting();
    this.composePanorama();
  }

  /**
   * Decide what lights the model, and only that.
   *
   * The backdrop and the lighting are two separate questions and used to be
   * tangled: leaving a panorama for the gradient or the studio changed what was
   * shown while quietly keeping the panorama's probe, so the scene stayed lit
   * by an image that was no longer anywhere on screen.
   *
   * The studio probe is a generated room, not merely the fill light: it is what
   * makes a PBR material readable without shipping an HDRI.
   */
  /**
   * The generated studio light, built the first time something needs it.
   *
   * Building it runs a PMREM pass over a small scene, which is real GPU work
   * with nothing on screen to justify it: an empty viewport is lit by nothing
   * at all. Deferring it to the first model gets the window painted sooner.
   */
  studio() {
    if (!this.studioMap) {
      this.studioMap = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
    return this.studioMap;
  }

  /** Called once a model arrives, since that is what needs lighting. */
  ensureEnvironment() {
    if (!this.scene.environment) this.applyLighting();
  }

  applyLighting() {
    const source =
      this.envKind === "image" ? this.panoramaSource : this.envKind === "gradient" ? this.gradient : null;
    const wanted = source && this.envLighting !== false ? source : null;

    if (this.envMap && this.envMap !== this.studioMap) this.envMap.dispose();
    this.envMap = wanted ? this.pmrem.fromEquirectangular(wanted).texture : this.studio();
    this.scene.environment = this.envMap;
    this.invalidate();
  }

  /**
   * Draw the backdrop, magnified and softened as asked.
   *
   * An HDR source cannot be drawn to a canvas, so it is only framed when the
   * framing asks for something: left alone, the raw texture is handed over and
   * keeps every bit of its range.
   */
  composePanorama() {
    const source = this.panoramaSource;
    if (!source) return;
    const framing = this.framing || { zoom: 1, blur: 0 };
    const drawable = source.image;
    const canDraw =
      drawable &&
      (typeof HTMLImageElement !== "undefined" && drawable instanceof HTMLImageElement) ||
      (typeof ImageBitmap !== "undefined" && drawable instanceof ImageBitmap) ||
      (typeof HTMLCanvasElement !== "undefined" && drawable instanceof HTMLCanvasElement);

    if (!canDraw || (framing.zoom === 1 && !framing.blur)) {
      this.envPanorama = source;
      this.applyBackground();
      return;
    }

    const width = Math.min(4096, drawable.width);
    const height = Math.min(2048, drawable.height);
    const canvas = this.panoramaCanvas || document.createElement("canvas");
    this.panoramaCanvas = canvas;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    // Blur in source pixels, so the effect looks the same whatever the image
    ctx.filter = framing.blur ? `blur(${Math.round(framing.blur * width * 0.02)}px)` : "none";
    const zoom = Math.max(1, framing.zoom);
    const cropW = drawable.width / zoom;
    const cropH = drawable.height / zoom;
    ctx.drawImage(
      drawable,
      (drawable.width - cropW) / 2,
      (drawable.height - cropH) / 2,
      cropW,
      cropH,
      0,
      0,
      width,
      height
    );
    ctx.filter = "none";

    // Rebuilt rather than refreshed, for the same reason as the gradient: the
    // background is cached against the texture object itself.
    if (this.framedTexture) this.framedTexture.dispose();
    this.framedTexture = new THREE.CanvasTexture(canvas);
    this.framedTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.framedTexture.colorSpace = THREE.SRGBColorSpace;
    this.envPanorama = this.framedTexture;
    this.applyBackground();
  }

  /** HDR, EXR and ordinary images all end up as one equirectangular map. */
  async loadPanorama(url) {
    const clean = url.split(/[?#]/)[0].toLowerCase();
    try {
      let texture;
      if (clean.endsWith(".hdr")) {
        const { RGBELoader } = await import("three/examples/jsm/loaders/RGBELoader.js");
        texture = await new RGBELoader().loadAsync(url);
      } else if (clean.endsWith(".exr")) {
        const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
        texture = await new EXRLoader().loadAsync(url);
      } else {
        texture = await new THREE.TextureLoader().loadAsync(url);
        texture.colorSpace = THREE.SRGBColorSpace;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      return texture;
    } catch (e) {
      console.warn("[albedo] panorama illisible:", e);
      return null;
    }
  }

  /**
   * Put the model on a stand.
   *
   * The stand is scaled to the model rather than trusted at its authored size,
   * since a pedestal modelled in centimetres under a model in metres would
   * simply not be there. Its top meets the model's lowest point.
   */
  setPedestal(object) {
    this.clearPedestal();
    if (!object) return;
    object.userData.baseScale = object.scale.clone();
    this.pedestal = object;
    this.stand.add(object);
    this.placePedestal();
  }

  /**
   * Place the stand by hand, from a saved transform.
   *
   * Models differ too much for one rule to suit them all, so a manual placing
   * wins over the automatic fit and survives the next launch. Pass nothing to
   * hand the job back to the fit.
   */
  setPedestalTransform(transform) {
    this.pedestalTransform = transform || null;
    this.placePedestal();
  }

  /** The stand's current placing, in a form that can be written to a file. */
  pedestalPlacing() {
    if (!this.pedestal) return null;
    const o = this.pedestal;
    return {
      position: o.position.toArray(),
      rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
      scale: o.scale.toArray(),
    };
  }

  /** Fit the stand to whatever model is loaded now. */
  placePedestal() {
    const object = this.pedestal;
    if (!object) return;
    if (!this.current) {
      this.stand.visible = false;
      return;
    }
    this.stand.visible = true;

    // A placing chosen by hand is not a suggestion to improve upon
    if (this.pedestalTransform) {
      const t = this.pedestalTransform;
      object.position.fromArray(t.position || [0, 0, 0]);
      object.rotation.set(...(t.rotation || [0, 0, 0]));
      object.scale.fromArray(t.scale || [1, 1, 1]);
      object.updateMatrixWorld(true);
      this.invalidate();
      return;
    }
    // Always measured from the authored size, never from the last fit, or two
    // models in a row would shrink the stand twice.
    object.scale.copy(object.userData.baseScale || new THREE.Vector3(1, 1, 1));
    object.position.set(0, 0, 0);
    object.updateMatrixWorld(true);

    const model = new THREE.Box3().setFromObject(this.current);
    const stand = new THREE.Box3().setFromObject(object);
    if (model.isEmpty() || stand.isEmpty()) return;

    const modelSize = model.getSize(new THREE.Vector3());
    const standSize = stand.getSize(new THREE.Vector3());
    const footprint = Math.max(modelSize.x, modelSize.z, 1e-4);
    const standFoot = Math.max(standSize.x, standSize.z, 1e-4);
    object.scale.multiplyScalar((footprint * 1.35) / standFoot);
    object.updateMatrixWorld(true);

    const scaled = new THREE.Box3().setFromObject(object);
    const center = model.getCenter(new THREE.Vector3());
    const standCenter = scaled.getCenter(new THREE.Vector3());
    object.position.x += center.x - standCenter.x;
    object.position.z += center.z - standCenter.z;
    object.position.y += model.min.y - scaled.max.y;
    this.invalidate();
  }

  /**
   * Light the stand, or show it flat.
   *
   * A stand is scenery, not the subject: one that was hand painted looks wrong
   * under the studio probe, and one modelled for PBR looks flat without it.
   * Which is right depends on the stand, so it is a choice rather than a rule.
   *
   * @param {"shaded"|"unlit"} mode
   */
  setPedestalShading(mode) {
    this.pedestalShading = mode;
    if (!this.pedestal) return;
    const flatten = (m) =>
      new THREE.MeshBasicMaterial({
        map: m.map || null,
        color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
        side: m.side,
        transparent: m.transparent,
        opacity: m.opacity ?? 1,
        alphaTest: m.alphaTest ?? 0,
        alphaMap: m.alphaMap || null,
        vertexColors: !!m.vertexColors,
        toneMapped: false,
      });

    this.pedestal.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      if (!o.userData.litMaterial) o.userData.litMaterial = o.material;
      if (mode !== "unlit") {
        o.material = o.userData.litMaterial;
        return;
      }
      if (!o.userData.flatMaterial) {
        const source = o.userData.litMaterial;
        o.userData.flatMaterial = Array.isArray(source) ? source.map(flatten) : flatten(source);
      }
      o.material = o.userData.flatMaterial;
    });
    this.invalidate();
  }

  clearPedestal() {
    this.setGizmo(null);
    if (!this.pedestal) return;
    this.stand.remove(this.pedestal);
    this.pedestal = null;
    this.pedestalTransform = null;
    this.invalidate();
  }

  /**
   * Show the move, turn or scale handles on the stand.
   *
   * @param {"translate"|"rotate"|"scale"|null} mode
   * @param {(placing: object) => void} [onChange] called when the user lets go
   */
  async setGizmo(mode, onChange, target = this.pedestal) {
    if (!mode || !target) {
      this.gizmoReady = null;
      this.gizmoBuiltFor = null;
      if (this.gizmo) {
        this.gizmo.detach();
        this.gizmo.dispose();
        this.gizmo = null;
        this.gizmoHelper = null;
      }
      // Everything of that kind, not just the one currently held. Putting the
      // handles away has to mean the view is clear of them whatever happened
      // before, or "escape closes it" is a promise with an exception in it.
      // Matched on the flag: the helper's `type` is the inherited "Object3D",
      // so a check on the name silently matched nothing and leaked every one.
      for (const stray of this.scene.children.filter((o) => o.isTransformControlsRoot)) {
        this.scene.remove(stray);
      }
      this.invalidate();
      return;
    }
    // One construction however many calls arrive before it finishes. The await
    // below used to sit inside the branch that tests for an existing gizmo, so
    // pressing G then R while the module was still loading let both calls
    // through: each built its own controls and added its own helper, and the
    // one that lost the race stayed in the scene, attached where the object's
    // origin was before it got recentred. That was the second, offset gizmo.
    // Claimed synchronously, before the await. Testing gizmoCamera here was no
    // better than testing gizmo: both are only set once the build has finished,
    // so every call arriving in the meantime still saw a camera that did not
    // match and started a build of its own.
    if (!this.gizmoReady || this.gizmoBuiltFor !== this.camera) {
      this.gizmoBuiltFor = this.camera;
      this.gizmoReady = this.buildGizmo();
    }
    await this.gizmoReady;

    this.onGizmoChange = onChange;
    this.gizmo.setMode(mode);
    this.recentreOrigin(target);
    this.gizmo.attach(target);
    this.invalidate();
  }

  /** The handles themselves, built once per camera. */
  async buildGizmo() {
    // The handles belong to one camera; switching projection rebuilds them.
    // Any helper still in the scene goes, whoever put it there.
    if (this.gizmo) {
      this.gizmo.detach();
      this.gizmo.dispose();
      this.gizmo = null;
    }
    for (const stray of this.scene.children.filter((o) => o.isTransformControlsRoot)) {
      this.scene.remove(stray);
    }
    const { TransformControls } = await import(
      "three/examples/jsm/controls/TransformControls.js"
    );
    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmoCamera = this.camera;
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener("change", () => this.invalidate());
    // Fires on every step of a drag, which is where a number is wanted: not
    // knowing what you started from and by how much it has moved is the whole
    // complaint about dragging a handle blind.
    this.gizmo.addEventListener("objectChange", () =>
      this.onGizmoDrag?.("move", this.gizmo.object)
    );
    // Before the drag begins, so a duplication can swap the object out from
    // under the handles and the drag then moves the copy, Blender style.
    this.gizmo.addEventListener("mouseDown", () =>
      this.onGizmoAltDrag?.(this.gizmo.object)
    );
    // Dragging a handle must not also orbit the camera behind it
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
      // Announced before and after, so whatever is keeping a history can take
      // its snapshot of the object as it was rather than as it ended up.
      this.onGizmoDrag?.(e.value ? "start" : "end", this.gizmo.object);
      if (!e.value && this.onGizmoChange) this.onGizmoChange(this.pedestalPlacing());
    });
  }

  /**
   * Move an object's origin to the middle of its own geometry.
   *
   * The handles sit at the origin, and an exporter has no reason to have put
   * that anywhere near the shape: a model authored around a corner of its own
   * bounding box, or moved once already, shows its handles floating off to one
   * side. Worse than looking wrong, it turns wrong, since a rotation is about
   * the origin and one that far out swings the model through an arc instead of
   * turning it on the spot.
   *
   * Nothing moves on screen. The children go one way in local space and the
   * object goes the other in its parent's, which cancel exactly; only the point
   * everything is measured from has changed. A single mesh has no children to
   * shift, so it keeps the origin its geometry was authored with.
   */
  recentreOrigin(object) {
    if (!object || !object.children.length) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    object.updateMatrixWorld(true);
    const local = object.worldToLocal(box.getCenter(new THREE.Vector3()));
    // Already there, and repeating the arithmetic would only add drift
    if (local.lengthSq() < 1e-12) return;
    for (const child of object.children) child.position.sub(local);
    object.position.add(local.clone().multiply(object.scale).applyQuaternion(object.quaternion));
    object.updateMatrixWorld(true);
  }

  /**
   * Move in steps rather than freely.
   *
   * Held down while dragging, the way every modelling tool does it: a quarter
   * of a unit, fifteen degrees, a tenth of the scale. Without it a model that
   * needs turning a quarter turn ends up turned by 89.6 degrees.
   */
  setGizmoSnap(on) {
    if (!this.gizmo) return;
    this.gizmo.setTranslationSnap(on ? 0.25 : null);
    this.gizmo.setRotationSnap(on ? Math.PI / 12 : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  /**
   * Swing the key light around the model.
   *
   * Turning the light instead of the model is how every DCC application lets
   * you find a shape's relief, and it is the one thing an environment map
   * cannot do on its own.
   */
  orbitLight(dx, dy) {
    const target = this.controls.target;
    const offset = this.keyLight.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx;
    spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi + dy));
    this.keyLight.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
    this.invalidate();
  }

  /** Put a loaded object in the scene, frame it, and collect its stats. */
  setModel(object, animations = [], name = "") {
    this.ensureEnvironment();
    this.clear();
    this.root.rotation.set(0, 0, 0);
    this.root.add(object);
    this.current = object;
    this.parts = [{ object, name }];

    // Each model starts from the user's own preference, not the last model's
    this.skeletons.visible = this._skeletonVisible === true;
    let meshCount = 0;
    object.traverse((o) => {
      if (o.isMesh || o.isPoints) meshCount++;
      if (o.isSkinnedMesh && o.skeleton) {
        const helper = new THREE.SkeletonHelper(o);
        helper.material.linewidth = 2;
        this.skeletons.add(helper);
      }
    });
    // Skeleton files carry a bone tree and no geometry: without the helper the
    // viewport would simply be empty, so it is shown by default there.
    if (object.userData.boneTree && !this.skeletons.children.length) {
      const helper = new THREE.SkeletonHelper(object);
      helper.material.linewidth = 2;
      this.skeletons.add(helper);
      if (meshCount === 0) this.skeletons.visible = true;
    }

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) {
      // No geometry to measure: fall back to where the nodes actually are
      const p = new THREE.Vector3();
      object.updateMatrixWorld(true);
      object.traverse((o) => box.expandByPoint(p.setFromMatrixPosition(o.matrixWorld)));
    }
    this.boxHelper.box.copy(box);
    // The rig is placed against the model, so a new file is lit the same way
    this.replaceLights();
    this.frame(box);
    this.scaleGrid(box);

    if (animations.length) {
      this.mixer = new THREE.AnimationMixer(object);
      this.clips = animations;
    } else {
      this.clips = [];
    }
    this.placePedestal();
    this.invalidate();
    return this.stats();
  }

  frame(box) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-4);
    const dir = new THREE.Vector3(1, 0.55, 1).normalize();

    /*
     * Fit the box as it actually looks from here, in both axes.
     *
     * This used to be the bounding *sphere* against the vertical opening alone,
     * which is the framing that always fits and almost never fills. A sphere
     * around a standing figure is as wide as the figure is tall, so a tall thin
     * model was pushed back until its imaginary shoulders fitted, and it came up
     * at about half the height it could have had. Then the horizontal opening
     * was never asked at all, so the same distance was used in a square window
     * and in the library's narrow strip, where width is the binding constraint
     * and the model ended up smaller still.
     *
     * So: the eight corners into the camera's own basis, the half extents that
     * come out of it, and the distance each opening needs for its own extent.
     * The larger of the two is the one that has to be obeyed, and the depth of
     * the box is added because the near face is closer than the centre.
     */
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    // A camera looking straight down has no horizon to take its right from.
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    let halfW = 0;
    let halfH = 0;
    let halfD = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z
      ).sub(center);
      halfW = Math.max(halfW, Math.abs(corner.dot(right)));
      halfH = Math.max(halfH, Math.abs(corner.dot(up)));
      halfD = Math.max(halfD, Math.abs(corner.dot(fwd)));
    }

    // The stored angle, not the camera's: an orthographic camera has none, and
    // both projections should sit the model at the same distance.
    const tanY = Math.tan((this.fov * Math.PI) / 360);
    const el = this.canvas.parentElement;
    const aspect = (el?.clientWidth || 1) / (el?.clientHeight || 1);
    const dist =
      Math.max(
        halfH / tanY,
        halfW / (tanY * Math.max(aspect, 1e-4)),
        // A degenerate box, a single point or a flat plane seen edge on, still
        // needs a distance that is not zero.
        radius * 0.01
      ) *
        1.06 +
      halfD;

    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    // The distance that shows the whole model, kept so zoom has something to be
    // a percentage of. A number of world units would mean nothing to anyone.
    this.framedDistance = dist;
    if (this.camera.isOrthographicCamera) {
      this.syncOrtho();
    } else {
      // Framing states the range afresh, so anything that had closed it in
      // must forget what it was holding rather than restore a stale pair.
      this.wideClip = null;
      this.camera.near = Math.max(radius / 1000, 1e-4);
      this.camera.far = radius * 1000;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.invalidate();
  }

  /**
   * How close the camera sits, as a percentage of the framing `F` gives.
   *
   * A hundred is the whole model in view; more is closer. Null while nothing is
   * framed, so a caller shows nothing rather than a number about nothing.
   */
  zoomPercent() {
    if (!this.framedDistance) return null;
    const d = this.camera.position.distanceTo(this.controls.target);
    if (!(d > 0)) return null;
    return Math.round((this.framedDistance / d) * 100);
  }

  /** Everything in the scene, not just the file that was opened. */
  sceneBox() {
    return new THREE.Box3().setFromObject(this.root);
  }

  /**
   * The point the camera turns about.
   *
   * Framing puts it at the middle of the bounding box, which is the right guess
   * and the wrong answer often enough to be worth changing by hand: a figure
   * with an outstretched arm, or a building with a spire, has a box whose
   * middle is nowhere near what you want to look at.
   */
  setPivot(point) {
    this.controls.target.copy(point);
    this.controls.update();
    if (this.pivotMarker) this.pivotMarker.position.copy(point);
    this.invalidate();
  }

  /**
   * Where the geometry actually is, rather than where its box is.
   *
   * The average of the vertices, which for a shape with one long limb sits
   * where the mass is instead of halfway to the tip. Sampled on large meshes:
   * a centre computed from every vertex of a million and a centre computed from
   * every eleventh do not differ by anything anyone can see.
   */
  geometricCentre() {
    const sum = new THREE.Vector3();
    const p = new THREE.Vector3();
    let n = 0;
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      const position = o.geometry?.attributes?.position;
      if (!position || (!o.isMesh && !o.isPoints)) return;
      const step = Math.max(1, Math.floor(position.count / 20000));
      for (let i = 0; i < position.count; i += step) {
        p.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
        sum.add(p);
        n++;
      }
    });
    return n ? sum.divideScalar(n) : this.sceneBox().getCenter(new THREE.Vector3());
  }

  /** A marker at the pivot, so moving it is something you can see. */
  showPivot(on) {
    if (on && !this.pivotMarker) {
      const marker = new THREE.Group();
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        // Drawn over everything: a pivot inside the model is the usual case,
        // and one that is hidden by the very thing it turns is no help.
        new THREE.MeshBasicMaterial({ color: 0x4c8dff, depthTest: false, transparent: true, opacity: 0.9 })
      );
      marker.add(ball, new THREE.AxesHelper(4));
      marker.renderOrder = 999;
      marker.traverse((o) => {
        if (o.material) o.material.depthTest = false;
      });
      this.pivotMarker = marker;
      this.scene.add(marker);
    }
    if (this.pivotMarker) {
      this.pivotMarker.visible = !!on;
      this.pivotMarker.position.copy(this.controls.target);
      // Sized against the model, so it is a dot on a building and not a planet
      const s = Math.max(this.sceneBox().getSize(new THREE.Vector3()).length(), 1e-3) * 0.01;
      this.pivotMarker.scale.setScalar(s);
    }
    this.invalidate();
  }

  /** Re-frame what is in the scene. */
  frameCurrent() {
    if (!this.current) return;
    this.frame(this.sceneBox());
  }

  /**
   * Bring another file into the scene beside the one already there.
   *
   * Placed where it was authored rather than centred on what is already here:
   * two files that were made to go together arrive together, and one that was
   * not is a thing to move, which is what the handles are for. Framing is left
   * alone on purpose, since jumping the camera on every import would lose the
   * view being worked in.
   *
   * @returns {{object: any, name: string}} the entry, for a list to name
   */
  addPart(object, name = "") {
    this.root.add(object);
    const entry = { object, name };
    this.parts.push(entry);
    if (!this.current) this.current = object;
    this.scaleGrid(this.sceneBox());
    this.invalidate();
    return entry;
  }

  /** Take one back out, and give the card back what it held. */
  removePart(entry) {
    const index = this.parts.indexOf(entry);
    if (index < 0) return;
    this.parts.splice(index, 1);
    if (this.gizmo && this.gizmo.object === entry.object) this.setGizmo(null);
    releaseSubtree(entry.object, this.keptTextures());
    this.root.remove(entry.object);
    // The opened file leaving means there is no primary any more; whatever is
    // left is still a scene, and the guards elsewhere ask only whether one
    // exists at all.
    if (this.current === entry.object) this.current = this.parts[0]?.object || null;
    this.invalidate();
  }


  /**
   * Take the whole model out of the scene without releasing any of it.
   *
   * This is the difference between a tab and a replacement, and it is the whole
   * reason `clear()` could not be reused: `clear` releases geometries, materials
   * and textures, which is exactly right when a model is being thrown away and
   * exactly wrong when it is being put aside to come back to.
   *
   * Everything that belongs to *this* model travels in the returned object.
   * Everything that belongs to the *viewer*, meaning the lights, the grid, the
   * stand, the environment and the camera rig, stays where it is: it is the room
   * rather than the thing in it.
   *
   * @returns {object} an opaque holder to hand back to `attachModel`
   */
  detachModel() {
    const held = {
      objects: [...this.root.children],
      rotation: this.root.rotation.clone(),
      parts: this.parts,
      current: this.current,
      skeletons: [...this.skeletons.children],
      skeletonsVisible: this.skeletons.visible,
      box: this.boxHelper.box.clone(),
      mixer: this.mixer,
      clips: this.clips || [],
      playing: this.playing,
      // The camera is part of what you were doing, not part of the file. Coming
      // back to a tab and finding it framed from somewhere else is the same
      // small betrayal as coming back to a scrolled page at the top.
      camera: {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        zoom: this.camera.zoom,
      },
    };
    // The handles point at an object that is about to leave the scene.
    if (this.gizmo) this.setGizmo(null);
    for (const o of held.objects) this.root.remove(o);
    for (const s of held.skeletons) this.skeletons.remove(s);
    this.parts = [];
    this.current = null;
    this.mixer = null;
    this.clips = [];
    this.selected = [];
    this.post?.outline([]);
    this.invalidate();
    return held;
  }

  /** Put back what `detachModel` took out, exactly as it was. */
  attachModel(held) {
    if (!held) return;
    for (const o of held.objects) this.root.add(o);
    for (const s of held.skeletons) this.skeletons.add(s);
    this.root.rotation.copy(held.rotation);
    this.parts = held.parts;
    this.current = held.current;
    this.skeletons.visible = held.skeletonsVisible;
    this.boxHelper.box.copy(held.box);
    this.mixer = held.mixer;
    this.clips = held.clips;
    this.playing = held.playing;
    this.camera.position.copy(held.camera.position);
    this.controls.target.copy(held.camera.target);
    if (held.camera.zoom) this.camera.zoom = held.camera.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    // The grid and the stand are sized against whatever is in the scene, so they
    // have to be told the scene changed even though nothing was loaded.
    this.scaleGrid(this.sceneBox());
    this.placePedestal();
    this.invalidate();
  }

  /**
   * Release a detached model.
   *
   * Closing a tab is the one moment a held scene stops being worth keeping, and
   * it is not on screen at that point, so nothing else will do it.
   */
  /** Every texture a held document still points at. */
  texturesHeldBy(held) {
    const out = new Set();
    if (!held) return out;
    for (const o of [...held.objects, ...held.skeletons]) {
      o.traverse?.((n) => {
        const m = n.material;
        if (!m) return;
        for (const one of Array.isArray(m) ? m : [m]) texturesOf(one, out);
      });
    }
    return out;
  }

  releaseHeld(held) {
    if (!held) return;
    // `keptTextures` already asks the host what the other documents still need.
    const keep = this.keptTextures();
    for (const o of held.objects) releaseSubtree(o, keep);
    for (const s of held.skeletons) releaseSubtree(s, keep);
    held.objects.length = 0;
    held.skeletons.length = 0;
    held.parts = [];
    held.current = null;
    held.mixer = null;
  }

  /** Keep the floor grid readable whatever the model scale is. */
  scaleGrid(box) {
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1e-3);
    const step = Math.pow(10, Math.round(Math.log10(span)) - 1);
    const divisions = 20;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(step * divisions, divisions, 0x3a4150, 0x272c35);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    this.grid.position.y = box.min.y;
    this.grid.visible = this._gridVisible !== false;
    this.scene.add(this.grid);
  }


  // ---------------------------------------------------------------------------
  // Extra lights
  // ---------------------------------------------------------------------------

  /**
   * Lights the user adds on top of the environment.
   *
   * Placed by azimuth and elevation rather than by coordinates, the way a light
   * dome works in Marmoset or a three point rig is described on paper: a light
   * belongs at a bearing and a height around the subject, and should stay there
   * when the next model is a different size. The distance is a multiple of the
   * model's own radius for the same reason.
   */
  addLight(kind = "directional", patch = {}) {
    const id = ++this._lightSeq;
    const entry = {
      id,
      kind,
      name: patch.name || `Lumière ${this.lights.length + 1}`,
      colour: patch.colour || "#ffffff",
      intensity: patch.intensity ?? (kind === "directional" ? 2 : 12),
      azimuth: patch.azimuth ?? 45,
      elevation: patch.elevation ?? 35,
      distance: patch.distance ?? 2.5,
      angle: patch.angle ?? 35,
      penumbra: patch.penumbra ?? 0.4,
      enabled: patch.enabled !== false,
    };
    entry.object = this.makeLight(entry);
    this.rig.add(entry.object);
    if (entry.object.target) this.rig.add(entry.object.target);
    this.lights.push(entry);
    this.placeLight(entry);
    this.invalidate();
    return entry;
  }

  makeLight(entry) {
    const colour = new THREE.Color(entry.colour);
    if (entry.kind === "point") return new THREE.PointLight(colour, entry.intensity);
    if (entry.kind === "spot") {
      const spot = new THREE.SpotLight(colour, entry.intensity);
      spot.angle = THREE.MathUtils.degToRad(entry.angle);
      spot.penumbra = entry.penumbra;
      return spot;
    }
    return new THREE.DirectionalLight(colour, entry.intensity);
  }

  /** Put a light where its bearing, height and distance say it belongs. */
  placeLight(entry) {
    const box = this.boxHelper.box;
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? 1 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const azimuth = THREE.MathUtils.degToRad(entry.azimuth);
    const elevation = THREE.MathUtils.degToRad(entry.elevation);
    const reach = radius * entry.distance;

    entry.object.position.set(
      centre.x + reach * Math.cos(elevation) * Math.sin(azimuth),
      centre.y + reach * Math.sin(elevation),
      centre.z + reach * Math.cos(elevation) * Math.cos(azimuth)
    );
    if (entry.object.target) {
      entry.object.target.position.copy(centre);
      entry.object.target.updateMatrixWorld();
    }
    if (entry.kind === "point" || entry.kind === "spot") {
      // Reach past the model, otherwise the far side falls off to nothing
      entry.object.distance = reach * 4;
      entry.object.decay = 2;
    }
    this.invalidate();
  }

  /** Every light follows the model it lights, so a new file is lit the same. */
  replaceLights() {
    for (const entry of this.lights) this.placeLight(entry);
    if (this.lightHelper) this.lightHelper.update?.();
  }

  setLight(id, patch) {
    const entry = this.lights.find((l) => l.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);

    // Changing the kind means a different object, not a different setting
    if (patch.kind && patch.kind !== entry.object.type.toLowerCase().replace("light", "")) {
      this.rig.remove(entry.object);
      if (entry.object.target) this.rig.remove(entry.object.target);
      entry.object.dispose?.();
      entry.object = this.makeLight(entry);
      this.rig.add(entry.object);
      if (entry.object.target) this.rig.add(entry.object.target);
      if (this.selectedLight === id) this.showLightHelper(id);
    }
    entry.object.color.set(entry.colour);
    entry.object.intensity = entry.intensity;
    entry.object.visible = entry.enabled;
    if (entry.object.isSpotLight) {
      entry.object.angle = THREE.MathUtils.degToRad(entry.angle);
      entry.object.penumbra = entry.penumbra;
    }
    this.placeLight(entry);
    this.lightHelper?.update?.();
    return entry;
  }

  removeLight(id) {
    const index = this.lights.findIndex((l) => l.id === id);
    if (index < 0) return;
    const [entry] = this.lights.splice(index, 1);
    this.rig.remove(entry.object);
    if (entry.object.target) this.rig.remove(entry.object.target);
    entry.object.dispose?.();
    if (this.selectedLight === id) this.showLightHelper(null);
    this.invalidate();
  }

  /** Draw where a light is, while it is the one being edited. */
  showLightHelper(id) {
    if (this.lightHelper) {
      this.rig.remove(this.lightHelper);
      this.lightHelper.dispose?.();
      this.lightHelper = null;
    }
    this.selectedLight = id;
    const entry = this.lights.find((l) => l.id === id);
    if (!entry) {
      this.invalidate();
      return;
    }
    const radius = Math.max(this.boxHelper.box.getSize(new THREE.Vector3()).length() / 20, 0.01);
    if (entry.object.isDirectionalLight) {
      this.lightHelper = new THREE.DirectionalLightHelper(entry.object, radius, 0xffb454);
    } else if (entry.object.isSpotLight) {
      this.lightHelper = new THREE.SpotLightHelper(entry.object, 0xffb454);
    } else {
      this.lightHelper = new THREE.PointLightHelper(entry.object, radius, 0xffb454);
    }
    this.rig.add(this.lightHelper);
    this.invalidate();
  }

  /** What to write down, without the three objects. */
  lightState() {
    return this.lights.map(({ object, ...rest }) => rest);
  }

  applyLights(saved) {
    for (const entry of [...this.lights]) this.removeLight(entry.id);
    for (const item of saved || []) this.addLight(item.kind, item);
  }


  /**
   * Turn the model on an axis, in quarter turns.
   *
   * Exporters disagree about which way is up, and a converter that assumes the
   * wrong one hands over a model lying on its side or standing on its head.
   * Nothing in the file says which of the two happened, so the only honest
   * answer is a control: quarter turns, because that is what the mistake always
   * is, and cumulative, so a wrong guess is undone by carrying on.
   *
   * @param {"x"|"y"|"z"} axis
   * @param {number} quarters signed, usually one or minus one
   */
  turnModel(axis, quarters = 1) {
    if (!this.current) return;
    this.root.rotation[axis] += (Math.PI / 2) * quarters;
    // Keep it readable rather than letting it wander to large numbers
    this.root.rotation[axis] = Math.round(this.root.rotation[axis] / (Math.PI / 2)) * (Math.PI / 2);
    this.afterOrientation();
  }

  resetOrientation() {
    this.root.rotation.set(0, 0, 0);
    this.afterOrientation();
  }

  /** @returns {{x: number, y: number, z: number}} in degrees */
  orientation() {
    const deg = (r) => Math.round((r * 180) / Math.PI) % 360;
    return { x: deg(this.root.rotation.x), y: deg(this.root.rotation.y), z: deg(this.root.rotation.z) };
  }

  /** Everything that was measured against the old pose has to be measured again. */
  afterOrientation() {
    this.root.updateMatrixWorld(true);
    if (!this.current) return;
    const box = new THREE.Box3().setFromObject(this.current);
    this.boxHelper.box.copy(box);
    this.scaleGrid(box);
    this.replaceLights();
    this.invalidate();
  }

  stats() {
    let tris = 0;
    let meshes = 0;
    let points = 0;
    const materials = new Set();
    const textures = new Set();
    const collect = (o) => {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        materials.add(m);
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture) textures.add(v);
        }
      }
    };
    this.root.traverse((o) => {
      // A point cloud has no triangles, but counting nothing at all would
      // report an empty scene while two thousand points are on screen.
      if (o.isPoints) {
        points += o.geometry?.attributes.position?.count || 0;
        collect(o);
        return;
      }
      if (!o.isMesh && !o.isSkinnedMesh) return;
      meshes++;
      const g = o.geometry;
      if (g) {
        const count = g.index ? g.index.count : g.attributes.position?.count || 0;
        tris += count / 3;
      }
      collect(o);
    });
    return {
      triangles: Math.round(tris),
      meshes,
      points,
      materials: materials.size,
      textures: textures.size,
    };
  }

  /**
   * Render the model on its own into a square PNG.
   *
   * Reading the pixels straight after the draw call is what makes this work
   * with no window on screen: nothing here waits for a frame to be composited,
   * which a hidden window never does. The helpers are taken out first, since a
   * grid is scene furniture and not part of the model.
   *
   * @returns {string} a `data:image/png` URL
   */
  snapshot(size = 512, { transparent = true } = {}) {
    if (!this.current) throw new Error("aucun modèle à rendre");
    const background = this.scene.background;
    const gridVisible = this.grid.visible;
    const boundsVisible = this.boxHelper.visible;
    const standVisible = this.stand.visible;
    if (transparent) this.scene.background = null;
    this.grid.visible = false;
    this.boxHelper.visible = false;
    // A thumbnail is about the file, not about the room it is shown in
    this.stand.visible = false;

    // Rendered at twice the asked size, then cropped to what was actually
    // drawn. Fitting the camera on the bounding box instead would leave a long
    // model swimming in empty space, because a box corner is a place the
    // geometry almost never reaches; the silhouette is what should fill an
    // icon, and reading it back costs one render.
    const draw = Math.min(2048, size * 2);
    this.renderer.setSize(draw, draw, false);
    if (!this.camera.isOrthographicCamera) {
      this.camera.aspect = 1;
      this.camera.updateProjectionMatrix();
    }
    this.frame(new THREE.Box3().setFromObject(this.current));
    // Through the same chain the window uses, so a thumbnail is the picture the
    // viewer would show and not a plainer cousin of it.
    this.post?.setSize(draw, draw);
    this.draw(0);

    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    this.scene.background = background;
    this.grid.visible = gridVisible;
    this.boxHelper.visible = boundsVisible;
    this.stand.visible = standVisible;
    this.resize();

    const full = document.createElement("canvas");
    full.width = w;
    full.height = h;
    const fctx = full.getContext("2d");
    const img = fctx.createImageData(w, h);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      // GL reads bottom up; a canvas expects the first row to be the top one
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w; x++) {
        const s = src + x * 4;
        const d = dst + x * 4;
        const a = px[s + 3];
        // WebGL hands back premultiplied colour and ImageData expects it
        // straight, so edges would otherwise darken against transparency
        const scale = a === 0 || a === 255 ? 1 : 255 / a;
        img.data[d] = Math.min(255, px[s] * scale);
        img.data[d + 1] = Math.min(255, px[s + 1] * scale);
        img.data[d + 2] = Math.min(255, px[s + 2] * scale);
        img.data[d + 3] = a;
        if (a > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    fctx.putImageData(img, 0, 0);

    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const octx = out.getContext("2d");
    octx.imageSmoothingQuality = "high";
    if (maxX < minX || maxY < minY) {
      // Nothing was drawn: an empty scene is honest output, not a failure
      octx.drawImage(full, 0, 0, size, size);
      return out.toDataURL("image/png");
    }
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    const margin = 0.94;
    const scale = (size * margin) / Math.max(cropW, cropH);
    const dw = cropW * scale;
    const dh = cropH * scale;
    octx.drawImage(full, minX, minY, cropW, cropH, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return out.toDataURL("image/png");
  }

  /**
   * The view as it stands, at any size.
   *
   * Not `snapshot`, which re-frames the model into a square for a thumbnail:
   * this keeps the camera exactly where the user put it and only widens the
   * sensor when a different shape is asked for, the way a larger back on the
   * same lens sees more without moving. It goes through whatever is currently
   * drawing, effect chain included, so the file matches the screen.
   *
   * @returns {string} a `data:image/png` URL
   */
  photo({ width, height, transparent = false, grid = true, stand = true } = {}) {
    const gl = this.renderer.getContext();
    const limit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096;
    const w = Math.max(16, Math.min(limit, Math.round(width || 1920)));
    const h = Math.max(16, Math.min(limit, Math.round(height || 1080)));

    const size = this.renderer.getSize(new THREE.Vector2());
    const before = {
      background: this.scene.background,
      grid: this.grid.visible,
      stand: this.stand.visible,
      bounds: this.boxHelper.visible,
      selection: this.selected,
      aspect: this.camera.isPerspectiveCamera ? this.camera.aspect : null,
    };

    if (transparent) this.scene.background = null;
    this.grid.visible = grid && before.grid;
    this.stand.visible = stand && before.stand;
    this.boxHelper.visible = false;
    this.post?.outline([]);

    this.renderer.setSize(w, h, false);
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } else {
      this.syncOrtho(w / h);
    }
    this.post?.setSize(w, h);
    if (this.post?.active) this.post.render(0);
    else this.renderer.render(this.scene, this.camera);

    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    this.scene.background = before.background;
    this.grid.visible = before.grid;
    this.stand.visible = before.stand;
    this.boxHelper.visible = before.bounds;
    if (before.selection?.length) this.post?.outline(before.selection);
    if (before.aspect !== null) {
      this.camera.aspect = before.aspect;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.setSize(size.x, size.y, false);
    this.post?.setSize(size.x, size.y);
    this.resize();

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const a = px[src + x + 3];
        const scale = a === 0 || a === 255 ? 1 : 255 / a;
        image.data[dst + x] = Math.min(255, px[src + x] * scale);
        image.data[dst + x + 1] = Math.min(255, px[src + x + 1] * scale);
        image.data[dst + x + 2] = Math.min(255, px[src + x + 2] * scale);
        image.data[dst + x + 3] = a;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  sceneTree(maxLines = 200) {
    const lines = [];
    const walk = (o, depth) => {
      if (lines.length >= maxLines) return;
      const kind = o.isSkinnedMesh
        ? "SkinnedMesh"
        : o.isMesh
          ? "Mesh"
          : o.isBone
            ? "Bone"
            : o.type;
      lines.push(`${"  ".repeat(depth)}${o.name || "(sans nom)"} · ${kind}`);
      for (const c of o.children) walk(c, depth + 1);
    };
    for (const c of this.root.children) walk(c, 0);
    return lines.join("\n") || "—";
  }

  setGrid(v) {
    this._gridVisible = v;
    this.grid.visible = v;
    this.invalidate();
  }
  setBounds(v) {
    this.boxHelper.visible = v;
    this.invalidate();
  }
  setSkeleton(v) {
    this._skeletonVisible = v;
    this.skeletons.visible = v;
    this.invalidate();
  }
  setExposure(v) {
    this.renderer.toneMappingExposure = v;
    this.invalidate();
  }
}
