import * as THREE from "three";

/**
 * A volume of fog you can put somewhere.
 *
 * Three's own `scene.fog` is a distance curve applied in every material: it has
 * a colour and a density and it is *everywhere*. That is the right tool for
 * "this scene is hazy" and no use at all for what an artist actually wants,
 * which is a bank of mist sitting in one part of the frame — behind the subject,
 * in the hollow of a landscape, around the feet of a figure. A thing with a
 * place.
 *
 * So this integrates along the view ray instead. For every pixel it walks from
 * the camera to whatever surface the depth buffer says is there, samples the
 * density at each step, and accumulates. Density falls off from a centre you can
 * drag, and again with height, which is what makes fog read as fog rather than
 * as a grey wash: real mist pools low and thins upwards.
 *
 * **Depth comes from a render of this pass's own.** The composer's targets
 * ping-pong between two buffers and are multisampled, so attaching a depth
 * texture to one of them gives a buffer that is sometimes the one just written
 * and sometimes the one before. A depth-only pass over the scene, with an
 * override material, is what three's own bokeh does and is one draw of flat
 * geometry with no shading in it.
 *
 * The cost is that draw plus a fixed-step march. Both only happen while the
 * effect is on, and the whole chain only exists once something is.
 */

/** Enough to look continuous, few enough to stay free on an integrated GPU. */
const STEPS = 28;

export const FogShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    /** Rebuilds a world position from a pixel and its depth. */
    inverseProjection: { value: new THREE.Matrix4() },
    cameraWorld: { value: new THREE.Matrix4() },
    cameraPos: { value: new THREE.Vector3() },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    fogColour: { value: new THREE.Color(0xaebdd0) },
    /** Where the bank of fog sits, and how far it reaches. */
    centre: { value: new THREE.Vector3() },
    radius: { value: 1 },
    /** Above this height the fog thins out, at `falloff` per unit. */
    height: { value: 0 },
    falloff: { value: 1 },
    density: { value: 0.5 },
    /** The far end of the march, so the steps are spread over the subject. */
    reach: { value: 10 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    #include <packing>

    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform mat4 inverseProjection;
    uniform mat4 cameraWorld;
    uniform vec3 cameraPos;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec3 fogColour;
    uniform vec3 centre;
    uniform float radius;
    uniform float height;
    uniform float falloff;
    uniform float density;
    uniform float reach;

    /** How thick the fog is at one point in the world. */
    float sample_density(vec3 p) {
      // A soft ball rather than a hard edge: a sphere with a visible rim reads
      // as a bubble, which is the one thing fog never looks like.
      float d = length(p - centre) / max(radius, 1e-4);
      float ball = 1.0 - smoothstep(0.35, 1.0, d);
      // And thinner as it rises. Mist pools; it does not fill a room evenly.
      float up = exp(-max(p.y - height, 0.0) * falloff);
      return ball * up;
    }

    void main() {
      vec4 source = texture2D(tDiffuse, vUv);

      // The surface this pixel is looking at, in world space. The texture is a
      // real depth attachment, so the value read is the clip depth itself.
      float packed = texture2D(tDepth, vUv).x;
      float viewZ = -perspectiveDepthToViewZ(packed, cameraNear, cameraFar);
      // Nothing was drawn here: the ray runs to the end of the march instead of
      // stopping at a surface, so fog still builds over the backdrop.
      bool sky = packed >= 1.0 - 1e-6;

      vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec4 view = inverseProjection * ndc;
      vec3 dirView = normalize(view.xyz / view.w);
      vec3 dir = normalize((cameraWorld * vec4(dirView, 0.0)).xyz);

      // The ray's length in world units. The depth is a distance along the
      // camera axis, not along this ray, so it is divided by the cosine between
      // them; without that the fog is thinner at the edges of a wide lens.
      float axis = max(-dirView.z, 1e-4);
      float far = sky ? reach : min(viewZ / axis, reach);

      float step = far / float(${STEPS});
      float acc = 0.0;
      for (int i = 0; i < ${STEPS}; i++) {
        float t = (float(i) + 0.5) * step;
        acc += sample_density(cameraPos + dir * t);
      }
      // Beer–Lambert, so doubling the distance does not double the whiteness:
      // fog saturates, and a linear accumulation goes flat white and stays there.
      float amount = 1.0 - exp(-acc * step * density);

      gl_FragColor = vec4(mix(source.rgb, fogColour, clamp(amount, 0.0, 1.0)), source.a);
    }
  `,
};

/**
 * The depth-only render the shader reads.
 *
 * Its own target and its own override material, for the reason in the header:
 * the composer's buffers alternate, so depth attached to one of them is right
 * half the time. This is the same arrangement three's bokeh pass uses.
 */
export function makeDepthTarget(width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    // Depth is read as a number, not shown: a colour space conversion on it
    // would be a conversion of the value the maths depends on.
    type: THREE.UnsignedByteType,
  });
  target.texture.name = "albedo:fog-depth";
  target.depthTexture = new THREE.DepthTexture(width, height);
  target.depthTexture.type = THREE.UnsignedShortType;
  return target;
}
