import * as THREE from "three";

/**
 * The wireframe overlay, in the shader.
 *
 * Not `material.wireframe = true`. That one *replaces* the surface with lines,
 * so you lose the shading that tells you whether the silhouette survived the
 * decimation, which is the thing you opened the wireframe to check. This draws
 * the lines *over* the shaded surface, which is the view every retopology tool
 * shows by default and the reason people ask for it.
 *
 * The technique is barycentric: give each corner of a triangle a coordinate that
 * is 1 at that corner and 0 at the other two, and the distance to the nearest
 * edge falls out of the interpolation for free. `fwidth` turns that into a line
 * of constant width on screen regardless of how far away the triangle is, which
 * is what makes a dense mesh readable instead of a grey smear. One pass, no
 * second geometry, no z-fighting.
 *
 * Two things it costs, and both are worth stating rather than discovering:
 *
 * 1. **The geometry has to be non-indexed.** A shared vertex cannot hold three
 *    different barycentric coordinates at once. Un-indexing a decimated mesh is
 *    cheap, and it is exactly what plancton does for the same reason.
 * 2. **The quad mask rides along as a vertex attribute.** plancton puts it in a
 *    texture indexed by triangle id, which is the right call at its scale; here
 *    the mesh is already un-indexed, so one float per vertex is simpler and
 *    needs no texture unit.
 */

/** Bit `k` of the mask says the edge from corner `k` to `k+1` is real. */
const ALL_EDGES = 7;

/**
 * Give an object what the wire shader needs to read.
 *
 * `mask` is one entry per triangle across the whole object, in traversal order,
 * which is the order the engine wrote it in.
 */
export function prepareWire(object, mask = null) {
  let tri = 0;
  object.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    let g = n.geometry;
    if (!g?.attributes?.position) return;

    // A shared vertex cannot be corner 0 of one triangle and corner 1 of the
    // next, so the index has to go.
    if (g.index) {
      g = g.toNonIndexed();
      n.geometry = g;
    }
    const count = g.attributes.position.count;
    const bary = new Float32Array(count * 3);
    const edges = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      bary[i * 3 + (i % 3)] = 1;
      const m = mask ? mask[tri + ((i / 3) | 0)] : undefined;
      edges[i] = m === undefined ? ALL_EDGES : m;
    }
    g.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
    g.setAttribute("aEdges", new THREE.BufferAttribute(edges, 1));
    tri += count / 3;
  });
  return tri;
}

/**
 * The uniforms every patched material shares.
 *
 * One object, handed to every material, so changing the toggle is an assignment
 * rather than a walk of the scene graph.
 */
export function makeWireUniforms() {
  return {
    uWire: { value: 0 },
    // Near black rather than black: a pure 0 reads as a hole against a dark
    // surface, where a hair of light still says "line".
    uWireColor: { value: new THREE.Color(0.03, 0.03, 0.04) },
    uQuads: { value: 0 },
    // The curtain. `uSplit` is where it sits across the viewport, 0 to 1.
    uSplit: { value: 0.5 },
    uViewport: { value: new THREE.Vector2(1, 1) },
  };
}

/**
 * Which side of the curtain an object lives on: -1 left, 1 right, 0 everywhere.
 *
 * This one cannot be shared, because telling source and result apart is the
 * entire point. Each material gets its own, recorded so it can be set later
 * without recompiling anything.
 */
export function setSide(object, side) {
  object.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
      if (m?.userData?.uSide) m.userData.uSide.value = side;
    }
  });
}

const VERT_HEAD = /* glsl */ `
attribute vec3 aBary;
attribute float aEdges;
varying vec3 vBary;
varying float vEdges;
`;

const FRAG_HEAD = /* glsl */ `
uniform float uWire;
uniform vec3 uWireColor;
uniform float uQuads;
uniform float uSplit;
uniform float uSide;
uniform vec2 uViewport;
varying vec3 vBary;
varying float vEdges;
`;

/*
 * The curtain.
 *
 * Comparing the same pixels beats comparing two numbers, and it beats two
 * viewports side by side too: the eye is very good at spotting a silhouette
 * shifting under a moving edge, and very bad at comparing two things it has to
 * saccade between. Source on the left of the line, result on the right, one
 * camera, one set of pixels.
 *
 * Screen space rather than a clipping plane, because the line has to stay
 * vertical on screen while the model turns underneath it. A world space plane
 * would tilt with the camera and stop meaning anything.
 */
const FRAG_SPLIT = /* glsl */ `
  if (uSide != 0.0) {
    float sx = gl_FragCoord.x / max(uViewport.x, 1.0);
    if (uSide < 0.0 && sx > uSplit) discard;
    if (uSide > 0.0 && sx < uSplit) discard;
  }
`;

/*
 * Injected after dithering, which is after tone mapping and after the colour
 * space conversion. That is deliberate: the line is a diagram drawn on top of a
 * photograph, not a surface in the scene, so it should come out the colour it
 * was asked for rather than the colour the exposure curve makes of it.
 */
const FRAG_WIRE = /* glsl */ `
#include <dithering_fragment>
if (uWire > 0.0) {
  vec3 d = fwidth(vBary);
  vec3 a = smoothstep(vec3(0.0), d * 1.3, vBary);
  if (uQuads > 0.5) {
    // Barycentric x vanishes on the edge between corners 1 and 2, y on 2 to 0,
    // and z on 0 to 1, so the mask bits map across as 2, 4, 1 rather than in
    // order. Getting this wrong hides the wrong edge and looks like noise.
    int m = int(vEdges + 0.5);
    if ((m & 2) == 0) a.x = 1.0;
    if ((m & 4) == 0) a.y = 1.0;
    if ((m & 1) == 0) a.z = 1.0;
  }
  float edge = 1.0 - min(min(a.x, a.y), a.z);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uWireColor, edge * uWire * 0.85);
}
`;

/**
 * Teach one material to draw the overlay. Safe to call twice.
 */
export function patchWire(material, uniforms) {
  for (const m of Array.isArray(material) ? material : [material]) {
    if (!m || m.userData?.wirePatched) continue;
    m.userData.wirePatched = true;
    m.userData.uSide = { value: 0 };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.uniforms.uSide = m.userData.uSide;
      shader.vertexShader = VERT_HEAD + shader.vertexShader.replace(
        "void main() {",
        "void main() {\n  vBary = aBary;\n  vEdges = aEdges;"
      );
      shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
        // The curtain discards before any lighting runs. Shading a fragment and
        // then throwing it away is the same picture for more work.
        .replace("void main() {", "void main() {" + FRAG_SPLIT)
        .replace("#include <dithering_fragment>", FRAG_WIRE);
    };
    // Without this every patched material shares one compiled program with
    // every unpatched one, and the overlay appears on things that never asked
    // for it.
    m.customProgramCacheKey = () => "retopo-wire";
    m.needsUpdate = true;
  }
}

/** Patch a whole object, geometry included. */
export function applyWire(object, uniforms, mask = null) {
  prepareWire(object, mask);
  object.traverse((n) => {
    if (n.isMesh || n.isSkinnedMesh) patchWire(n.material, uniforms);
  });
}

/**
 * Light lines or dark ones.
 *
 * Dark edges vanish on a dark model, which is most of them, and light edges
 * vanish on a light one. There is no single colour that works, so it is a
 * setting rather than a constant.
 */
export function setWireColor(uniforms, light) {
  uniforms.uWireColor.value.setRGB(
    light ? 0.97 : 0.03,
    light ? 0.98 : 0.03,
    light ? 1.0 : 0.04
  );
}
