import * as THREE from "three";

/**
 * Post-processing, in the order the picture is actually built.
 *
 * The stack follows what Marmoset and Sketchfab put in front of an artist,
 * because those are the pictures people compare a viewer against: occlusion in
 * the creases, a bloom on the bright parts, an optional focus, then the
 * grading and the film grain that make a render look photographed rather than
 * computed.
 *
 * Two rules decide the order. Occlusion, bloom and depth of field are physical
 * and belong in linear light, before tone mapping. Grading, vignette, grain and
 * sharpening are darkroom work and belong after it, on the picture as it will
 * be seen. Antialiasing comes last of all, on the final pixels.
 *
 * The whole module is loaded the first time an effect is switched on, and the
 * plain renderer keeps drawing until then: a viewer that costs a composer to
 * show one untouched model would be paying for nothing.
 */

/** Everything the panel can drive, with the values a fresh viewer starts at. */
export const DEFAULTS = {
  ao: { on: false, radius: 0.25, intensity: 1, thickness: 1 },
  // The threshold is read in linear light, before tone mapping, where a lit
  // backdrop already sits above one: at 0.85 everything bloomed and the picture
  // just lifted. Above white is where a highlight actually is.
  bloom: { on: false, strength: 0.6, radius: 0.5, threshold: 1.1 },
  dof: { on: false, focus: 0.5, aperture: 0.02, maxblur: 0.012 },
  grade: {
    on: false,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    vignette: 0.25,
    grain: 0.04,
    grainSize: 1.6,
    aberration: 0,
    sharpen: 0.2,
  },
  aa: { on: true },
};

/**
 * One pass for all the darkroom work.
 *
 * Five separate passes would each cost a full screen read and write; an artist
 * changing the vignette does not care which of them did it, and the picture is
 * identical either way.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    contrast: { value: 1 },
    saturation: { value: 1 },
    temperature: { value: 0 },
    vignette: { value: 0.25 },
    grain: { value: 0.04 },
    grainSize: { value: 1.6 },
    aberration: { value: 0 },
    sharpen: { value: 0.2 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float contrast, saturation, temperature, vignette, grain, grainSize, aberration, sharpen, time;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centre = uv - 0.5;

      // A lens does not focus every wavelength on the same point; the effect
      // grows towards the edge, which is why it is scaled by the radius.
      vec3 colour;
      if (aberration > 0.0) {
        vec2 offset = centre * aberration * 0.01;
        colour = vec3(
          texture2D(tDiffuse, uv + offset).r,
          texture2D(tDiffuse, uv).g,
          texture2D(tDiffuse, uv - offset).b
        );
      } else {
        colour = texture2D(tDiffuse, uv).rgb;
      }

      // Unsharp mask: the picture minus a cheap blur of itself.
      if (sharpen > 0.0) {
        vec2 texel = 1.0 / resolution;
        vec3 blur =
          texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb +
          texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb +
          texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb;
        colour += (colour - blur * 0.25) * sharpen;
      }

      // Warm or cool, the one grade everybody reaches for first.
      colour.r *= 1.0 + temperature * 0.15;
      colour.b *= 1.0 - temperature * 0.15;

      float grey = dot(colour, vec3(0.2126, 0.7152, 0.0722));
      colour = mix(vec3(grey), colour, saturation);
      colour = (colour - 0.5) * contrast + 0.5;

      if (vignette > 0.0) {
        float fall = smoothstep(0.8, 0.2, length(centre) * 1.4);
        colour *= mix(1.0, fall, vignette);
      }

      // Film grain, not sensor noise.
      //
      // Three things separate the two, and the first version had none of them.
      // Grain has a size, so it is sampled on a coarser lattice than the pixel
      // grid: at one grain per pixel it disappears on a dense screen and reads
      // as fizz on a coarse one. It lives in the midtones, since a film's
      // blacks hold no silver to speak of and its whites are saturated, so it
      // is weighted by luminance and vanishes at both ends. And it is
      // monochrome: coloured speckle is what a cheap sensor does.
      if (grain > 0.0) {
        vec2 lattice = floor(gl_FragCoord.xy / max(grainSize, 0.5));
        float seed = floor(time * 24.0);
        float n = hash(lattice + seed) + hash(lattice * 1.7 - seed) - 1.0;
        float lum = dot(colour, vec3(0.2126, 0.7152, 0.0722));
        float weight = 4.0 * clamp(lum, 0.0, 1.0) * (1.0 - clamp(lum, 0.0, 1.0));
        colour += n * grain * 0.5 * weight;
      }

      gl_FragColor = vec4(max(colour, 0.0), 1.0);
    }
  `,
};

// three's ACES fit, in the same arrangement the shader uses. Needed here to be
// able to undo it.
const ACES_IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];

const mul3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function acesToneMap(rgb, exposure) {
  const v = mul3(ACES_IN, rgb.map((c) => (c * exposure) / 0.6));
  const fit = v.map((x) => {
    const a = x * (x + 0.0245786) - 0.000090537;
    const b = x * (0.983729 * x + 0.432951) + 0.238081;
    return b === 0 ? 0 : a / b;
  });
  return mul3(ACES_OUT, fit).map((x) => Math.min(1, Math.max(0, x)));
}

/**
 * Find the colour that tone maps to the one that was asked for.
 *
 * The backdrop is drawn as a clear colour, which three does not tone map; the
 * effect chain ends in a pass that tone maps everything, backdrop included. So
 * switching an effect on visibly darkened the background, from 20,22,26 down to
 * 5,6,8 on the default grey. Feeding the chain a pre-compensated colour keeps
 * the promise that matters: the backdrop you picked is the backdrop you see,
 * effects or no effects.
 *
 * Solved by fixed point rather than algebra, because the fit mixes the three
 * channels through two matrices and there is no tidy inverse. It converges in a
 * handful of steps and runs once per change of colour.
 */
function undoToneMap(target, exposure) {
  let guess = [...target];
  for (let i = 0; i < 24; i++) {
    const mapped = acesToneMap(guess, exposure);
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const error = target[c] - mapped[c];
      worst = Math.max(worst, Math.abs(error));
      // Multiplicative near zero, additive further out: the fit is close to
      // linear in the darks, which is exactly where a backdrop lives.
      guess[c] = Math.max(0, guess[c] + error * (guess[c] > 0.02 ? guess[c] / 0.6 : 1));
    }
    if (worst < 1e-5) break;
  }
  return guess;
}

export class PostFx {
  /** Bring in the passes and build the chain. Never called at startup. */
  static async create(viewer) {
    const [
      { EffectComposer },
      { RenderPass },
      { OutputPass },
      { ShaderPass },
      { UnrealBloomPass },
      { GTAOPass },
      { BokehPass },
      { SMAAPass },
    ] = await Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
      import("three/examples/jsm/postprocessing/ShaderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/GTAOPass.js"),
      import("three/examples/jsm/postprocessing/BokehPass.js"),
      import("three/examples/jsm/postprocessing/SMAAPass.js"),
    ]);
    return new PostFx(viewer, {
      EffectComposer, RenderPass, OutputPass, ShaderPass,
      UnrealBloomPass, GTAOPass, BokehPass, SMAAPass,
    });
  }

  constructor(viewer, P) {
    this.viewer = viewer;
    this.settings = structuredClone(DEFAULTS);

    const { width, height } = viewer.renderer.getSize(new THREE.Vector2());
    const size = new THREE.Vector2(width, height);

    // A float target keeps the highlights that bloom is supposed to find; an
    // eight bit one has already clipped them by the time the pass runs.
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new P.EffectComposer(viewer.renderer, target);

    this.render0 = new P.RenderPass(viewer.scene, viewer.camera);
    this.ao = new P.GTAOPass(viewer.scene, viewer.camera, width, height);
    this.bloom = new P.UnrealBloomPass(size, DEFAULTS.bloom.strength, DEFAULTS.bloom.radius, DEFAULTS.bloom.threshold);
    this.dof = new P.BokehPass(viewer.scene, viewer.camera, { ...DEFAULTS.dof });
    this.output = new P.OutputPass();
    this.grade = new P.ShaderPass(GradeShader);
    this.aa = new P.SMAAPass(width, height);

    this.grade.uniforms.resolution.value.set(width, height);

    for (const pass of [this.render0, this.ao, this.bloom, this.dof, this.output, this.grade, this.aa]) {
      this.composer.addPass(pass);
    }
    this.ao.enabled = false;
    this.bloom.enabled = false;
    this.dof.enabled = false;
    this.grade.enabled = false;
    this.aa.enabled = DEFAULTS.aa.on;
    this.setSize(width, height);
    this.syncBackdrop();
  }

  /**
   * Whether anything is worth a composer at all.
   *
   * Antialiasing alone does not count: the renderer already multisamples, and
   * routing a whole frame through a chain to do again what it just did is a
   * cost with nothing to show for it.
   */
  get active() {
    const s = this.settings;
    return s.ao.on || s.bloom.on || s.dof.on || s.grade.on;
  }

  setSize(width, height) {
    this.composer.setSize(width, height);
    this.ao.setSize(width, height);
    this.bloom.setSize(width, height);
    this.aa.setSize(width, height);
    this.grade.uniforms.resolution.value.set(width, height);
  }

  /** The camera is rebuilt when the projection changes; the passes hold it. */
  setCamera(camera) {
    this.render0.camera = camera;
    this.ao.camera = camera;
    this.dof.camera = camera;
  }

  /**
   * Apply one setting.
   * @param {"ao"|"bloom"|"dof"|"grade"|"aa"} group
   */
  set(group, key, value) {
    const bag = this.settings[group];
    if (!bag) return;
    bag[key] = value;

    if (group === "ao") {
      this.ao.enabled = bag.on;
      this.ao.updateGtaoMaterial?.({
        radius: bag.radius,
        thickness: bag.thickness,
      });
      this.ao.blendIntensity = bag.intensity;
    } else if (group === "bloom") {
      this.bloom.enabled = bag.on;
      this.bloom.strength = bag.strength;
      this.bloom.radius = bag.radius;
      this.bloom.threshold = bag.threshold;
    } else if (group === "dof") {
      this.dof.enabled = bag.on;
      this.tuneDof();
    } else if (group === "grade") {
      this.grade.enabled = bag.on;
      for (const name of ["contrast", "saturation", "temperature", "vignette", "grain", "grainSize", "aberration", "sharpen"]) {
        if (this.grade.uniforms[name]) this.grade.uniforms[name].value = bag[name];
      }
    } else if (group === "aa") {
      this.aa.enabled = bag.on;
    }
    this.syncBackdrop();
    this.viewer.invalidate();
  }

  /**
   * Keep the backdrop looking the same whether the chain is running or not.
   *
   * Only a flat colour can be compensated: a gradient or a panorama is a
   * texture, and three draws those through a material that is already tone
   * mapped, so they come out the same either way.
   */
  syncBackdrop() {
    const scene = this.viewer.scene;
    const wanted = this.viewer.solidBackground;
    if (!wanted || !scene.background?.isColor) return;
    if (!this.active) {
      // Hand the viewer's own colour back, untouched.
      scene.background = wanted;
      return;
    }
    // A separate instance on purpose: the scene's background and the viewer's
    // chosen colour are the same object, so writing the compensated value into
    // it would compensate the compensation on the next pass, and the backdrop
    // drifted lighter with every toggle.
    this.backdrop ||= new THREE.Color();
    const [r, g, b] = undoToneMap(
      [wanted.r, wanted.g, wanted.b],
      this.viewer.renderer.toneMappingExposure
    );
    this.backdrop.setRGB(r, g, b);
    scene.background = this.backdrop;
  }

  /** Apply a whole saved set at once, on load. */
  apply(saved) {
    if (!saved) return;
    for (const [group, values] of Object.entries(saved)) {
      if (!this.settings[group] || !values) continue;
      for (const [key, value] of Object.entries(values)) this.set(group, key, value);
    }
  }

  /**
   * Point the lens, and give it a depth range it can actually resolve.
   *
   * Two things kept this effect from doing anything at all. The aperture was
   * divided by a thousand on its way to the pass, so the widest setting was
   * still shut. And the camera spans a million to one from its near plane to
   * its far one, which is fine for drawing and hopeless for depth: the whole
   * subject landed inside a thousandth of the range, so every pixel came back
   * at the same distance and nothing was ever out of focus.
   *
   * The clip planes are therefore closed around the subject while the effect is
   * on, and opened again when it is off. That is also better for depth
   * precision generally, which is why the picture stops flickering on
   * coincident faces at the same time.
   */
  tuneDof() {
    const bag = this.settings.dof;
    const camera = this.viewer.camera;
    const u = this.dof.materialBokeh?.uniforms;
    if (!u) return;

    if (!bag.on) {
      this.viewer.restoreClip();
      return;
    }

    const box = this.viewer.boxHelper.box;
    const centre = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const distance = camera.position.distanceTo(centre);

    const near = Math.max(radius * 0.01, distance - radius * 1.6);
    const far = distance + radius * 2.4;
    this.viewer.tightenClip(near, far);

    u.nearClip.value = camera.near;
    u.farClip.value = camera.far;
    // The slider walks the subject from its near face to its far one
    u.focus.value = distance + (bag.focus - 0.5) * radius * 2;
    // Past a certain opening the blur reaches its ceiling everywhere and the
    // effect stops being a depth of field: it becomes a flat blur, and moving
    // the focus changes nothing at all. The slider stops before that.
    u.aperture.value = Math.min(bag.aperture, 0.06);
    u.maxblur.value = bag.maxblur;
  }

  render(dt = 0) {
    if (this.grade.enabled) this.grade.uniforms.time.value += dt;
    // The camera moves; a focus fixed when the slider last moved would drift
    if (this.dof.enabled) this.tuneDof();
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose?.();
    this.ao.dispose?.();
    this.bloom.dispose?.();
    this.aa.dispose?.();
  }
}
