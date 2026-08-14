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
export function prepareWire(object, mask = null, charts = null, dev = null) {
  let tri = 0;
  let vert = 0;
  object.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    let g = n.geometry;
    if (!g?.attributes?.position) return;

    /*
     * The index is read *before* it is thrown away, and that ordering is the
     * whole correctness of the deviation view.
     *
     * Deviation arrives one value per vertex of the engine's mesh, which is the
     * mesh the GLB was written from, so it is indexed the way the file is. Un-
     * indexing expands the geometry to three vertices per triangle and destroys
     * that correspondence. Reading `oldIndex[i]` after the fact is impossible;
     * reading it first costs one array.
     *
     * Getting this wrong does not throw. It paints a heatmap that looks entirely
     * plausible and is wrong everywhere, which is worse than a crash.
     */
    const before = g.index;
    const source = new Uint32Array(before ? before.count : g.attributes.position.count);
    for (let i = 0; i < source.length; i++) source[i] = before ? before.getX(i) : i;

    if (before) {
      g = g.toNonIndexed();
      n.geometry = g;
    }
    const count = g.attributes.position.count;
    const bary = new Float32Array(count * 3);
    const edges = new Float32Array(count);
    // Always created, even with no data behind them. A missing attribute reads
    // as zero in the shader with no error anywhere, which would show as a model
    // that is entirely chart 0 and entirely undeviated: a plausible picture that
    // happens to be a lie.
    const chart = new Float32Array(count);
    const deviation = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      bary[i * 3 + (i % 3)] = 1;
      const t = tri + ((i / 3) | 0);
      const m = mask ? mask[t] : undefined;
      edges[i] = m === undefined ? ALL_EDGES : m;
      if (charts) chart[i] = charts[t] ?? 0;
      if (dev) deviation[i] = dev[vert + (source[i] ?? i)] ?? 0;
    }

    g.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
    g.setAttribute("aEdges", new THREE.BufferAttribute(edges, 1));
    g.setAttribute("aChart", new THREE.BufferAttribute(chart, 1));
    g.setAttribute("aDev", new THREE.BufferAttribute(deviation, 1));
    tri += count / 3;
    // Vertices are counted in the *engine's* numbering, not the expanded one, so
    // a second mesh starts where the first one's own vertices ended.
    vert += before ? Math.max(...source) + 1 : count;
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
    /**
     * Which picture the surface draws.
     *
     * 0 keeps whatever the material already was, which is the point: these are
     * *overrides* on top of Albedo's own eleven channels, not a twelfth renderer.
     * 1 colours by atlas chart, 2 by deviation from the source.
     */
    uView: { value: 0 },
    uDevScale: { value: 1 },
    uXray: { value: 0 },
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
attribute float aChart;
attribute float aDev;
varying vec3 vBary;
varying float vEdges;
varying float vChart;
varying float vDev;
/*
 * Our own view space normal, rather than three's vNormal.
 *
 * vNormal is declared under ifndef FLAT_SHADED, so reading it would fail to
 * compile the moment the flat toggle in the bar is switched on: a shader error
 * triggered by an unrelated button, which is the worst kind to debug.
 */
varying vec3 vRtNormal;
`;

const FRAG_HEAD = /* glsl */ `
uniform float uWire;
uniform vec3 uWireColor;
uniform float uQuads;
uniform float uSplit;
uniform float uSide;
uniform vec2 uViewport;
uniform float uView;
uniform float uDevScale;
uniform float uXray;
varying vec3 vBary;
varying float vEdges;
varying float vChart;
varying float vDev;
varying vec3 vRtNormal;

/*
 * A colour per chart, from the id alone.
 *
 * Hashed rather than looked up in a palette, because the number of charts is not
 * known until the atlas has run and a palette would have to wrap: two adjacent
 * islands sharing a colour is exactly the case you opened this view to see.
 * The multiplier is Knuth's, and the saturation and value are pulled from other
 * bits of the same hash so neighbouring ids do not merely differ in hue.
 */
vec3 chartColour(float id) {
  uint h = uint(id + 0.5) * 2654435761u;
  float hue = float((h >> 8) & 1023u) / 1023.0;
  float sat = 0.45 + float((h >> 18) & 63u) / 63.0 * 0.35;
  float val = 0.55 + float((h >> 24) & 63u) / 63.0 * 0.35;
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + hue * 6.0, 6.0);
  return val - val * sat * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

/* Cold to hot, five stops. The same ramp the icon in the bar draws. */
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.10, 0.20, 0.55);
  vec3 c1 = vec3(0.10, 0.70, 0.75);
  vec3 c2 = vec3(0.55, 0.85, 0.25);
  vec3 c3 = vec3(0.98, 0.72, 0.10);
  vec3 c4 = vec3(0.92, 0.16, 0.12);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
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

/*
 * The two data views replace the shaded colour but keep its lighting, which is
 * what makes them readable: a flat field of hues has no form in it, and you
 * cannot tell which island is on the far side of a fold. dot(N,V) is a
 * stand-in for that lighting, available here without re-deriving anything.
 */
if (uView > 0.5) {
  float lit = 0.42 + 0.58 * clamp(abs(dot(normalize(vRtNormal), vec3(0.0, 0.0, 1.0))), 0.0, 1.0);
  vec3 c = uView < 1.5 ? chartColour(vChart) : heat(vDev * uDevScale);
  gl_FragColor.rgb = c * lit;
}

/*
 * X-ray: fade the surface by how square-on it is, so silhouettes and folds stay
 * solid and flat faces go clear. Depth is already written by the time this runs,
 * so this is a look rather than true see-through, and it is the look that
 * answers the question people actually ask of it: where is the other surface
 * relative to this one.
 */
if (uXray > 0.5) {
  float facing = abs(dot(normalize(vRtNormal), vec3(0.0, 0.0, 1.0)));
  gl_FragColor.a *= clamp(1.25 - facing, 0.12, 1.0);
}

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
export function applyWire(object, uniforms, mask = null, charts = null, dev = null) {
  prepareWire(object, mask, charts, dev);
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
