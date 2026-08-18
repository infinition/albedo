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
 *    cheap, and it is exactly what the retopology engine does for the same
 *    reason.
 * 2. **The quad mask rides along as a vertex attribute.** The engine puts it in
 *    a texture indexed by triangle id, which is the right call at its scale; here
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
/**
 * The attributes this overlay writes onto a geometry.
 *
 * Named here so that anything writing a geometry to a file can take them off
 * first. They are scaffolding for a shader — a barycentric coordinate, an edge
 * mask, a chart index, a deviation — and they belong to how the model is being
 * *looked at*, not to the model.
 *
 * That distinction is not cosmetic. glTF only allows custom vertex semantics as
 * `_UPPERCASE`, which is what three's exporter writes them as, and readers are
 * entitled to refuse anything they do not know: the retopology engine rejects
 * the whole file with "invalid semantic name" rather than skipping four
 * attributes it has no use for.
 */
export const WIRE_ATTRIBUTES = ["aBary", "aEdges", "aChart", "aDev", "aGroup", "aNbr"];

/**
 * Take the overlay's attributes off for the duration of something, and put them
 * back exactly as they were.
 *
 * Detached rather than deleted: turning the wireframe off and on again would
 * otherwise have to rebuild them, and rebuilding un-indexes the geometry, which
 * triples its vertex buffer and cannot be undone.
 *
 * @param {any} root the subtree to strip
 * @param {() => Promise<any>} fn what to do while it is stripped
 */
export async function withoutWireAttributes(root, fn) {
  const parked = [];
  root?.traverse?.((o) => {
    const g = o.geometry;
    if (!g?.attributes) return;
    for (const name of WIRE_ATTRIBUTES) {
      const attribute = g.attributes[name];
      if (!attribute) continue;
      parked.push([g, name, attribute]);
      g.deleteAttribute(name);
    }
  });
  try {
    // Awaited, not returned: `finally` around a returned promise runs before it
    // settles, so the attributes would come back while the exporter was still
    // walking the scene.
    return await fn();
  } finally {
    for (const [g, name, attribute] of parked) g.setAttribute(name, attribute);
  }
}

export function prepareWire(object, mask = null, charts = null, dev = null) {
  // Whether this call brings data worth overwriting what is already there.
  const carries = !!(mask || charts || dev);
  let tri = 0;
  let vert = 0;
  object.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    let g = n.geometry;
    if (!g?.attributes?.position) return;

    /*
     * A geometry already prepared is left alone unless there is new data.
     *
     * Switching the wireframe on walks the scene with no mask, and a result mesh
     * in that scene already carries the pairing the engine wrote. Rebuilding its
     * attributes from nothing replaced a real quad mask with "every edge is
     * real", so the quads a run had just reported stopped being visible and the
     * only way back was another run.
     */
    if (!carries && g.attributes.aBary) {
      tri += g.attributes.position.count / 3;
      vert += g.attributes.position.count;
      return;
    }

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
    // The two group attributes exist from the start too, and they are filled
    // with -1 rather than 0. Zero is a real superface id, so a mesh nobody has
    // segmented would otherwise paint itself entirely in group zero's colour
    // with no borders anywhere: the same plausible lie the line above is about,
    // wearing a different hat. Minus one means "not segmented" and the shader
    // leaves those surfaces alone.
    const group = new Float32Array(count).fill(-1);
    const nbr = new Float32Array(count * 3).fill(-1);

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
    if (!g.attributes.aGroup) {
      g.setAttribute("aGroup", new THREE.BufferAttribute(group, 1));
      g.setAttribute("aNbr", new THREE.BufferAttribute(nbr, 3));
    }
    tri += count / 3;
    // Vertices are counted in the *engine's* numbering, not the expanded one, so
    // a second mesh starts where the first one's own vertices ended.
    /*
     * A loop, and not `Math.max(...source)`.
     *
     * The spread turns every entry of the index buffer into a separate function
     * argument, so a nine hundred thousand triangle mesh calls `Math.max` with
     * 2.7 million of them and overflows the stack. It works on every small model
     * you test with and dies on the first real one, which is the worst shape a
     * bug can have.
     */
    let highest = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] > highest) highest = source[i];
    }
    vert += before ? highest + 1 : count;
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
    // Lines only: the surface goes away and only the edges stay. A mode of the
    // same overlay, sharing its colour and its master switch, rather than the
    // old `material.wireframe` that replaced the surface.
    uWireOnly: { value: 0 },
    // Near black rather than black: a pure 0 reads as a hole against a dark
    // surface, where a hair of light still says "line".
    uWireColor: { value: new THREE.Color(0.03, 0.03, 0.04) },
    uQuads: { value: 0 },
    // The curtain. `uSplit` is where it sits across the viewport, 0 to 1.
    uSplit: { value: 0.5 },
    uViewport: { value: new THREE.Vector2(1, 1) },

    /**
     * Which picture the *groups* draw, and it is deliberately not `uView`.
     *
     * 0 off, 1 flat colours, 2 a tint over whatever the surface already was,
     * 3 outlines only with the material left untouched underneath.
     *
     * A separate switch because these compose rather than compete. `uView` is a
     * single slot the Retopo mode owns and resets to zero on any click in the
     * channel strip, so a group overlay riding on it would go dark the moment
     * somebody looked at the roughness map. Group colours are meant to stay up
     * while you work, which is the whole reason mode 3 exists.
     */
    uGroupView: { value: 0 },
    /** True once anything is picked, which is when the rest goes grey. */
    uGroupMarked: { value: 0 },
    /**
     * Superface id to group id, as a texture.
     *
     * The one decision that makes the slider live. Moving it re-partitions the
     * mesh, and rewriting a per-vertex attribute to say so would push six
     * megabytes at the GPU per frame on a half-million triangle model, for a
     * change whose actual information content is a few thousand numbers. A
     * lookup table is those few thousand numbers, and the shader does the
     * indirection for free.
     */
    uGroupLut: { value: emptyLut() },
    uGroupLutSize: { value: new THREE.Vector2(0, 0) },
  };
}

/**
 * A one texel stand-in, so the sampler is never unbound.
 *
 * Sampling a null texture is undefined and looks, on some drivers, exactly like
 * a working feature that has decided everything is group zero.
 */
function emptyLut() {
  const tex = new THREE.DataTexture(
    new Float32Array(2),
    1,
    1,
    THREE.RGFormat,
    THREE.FloatType
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Hand the shader a new partition.
 *
 * `labels` is one group id per superface, which is what replaying the first
 * `n - k` merges of the dendrogram produces. Two thousand texels wide because
 * that is comfortably inside every `MAX_TEXTURE_SIZE` worth worrying about and
 * keeps the table one row tall for anything under two thousand superfaces.
 *
 * The texture is reused whenever its shape has not changed, which is every
 * slider move: only the pixels are rewritten.
 */
export function setGroupLut(uniforms, labels, marks = null) {
  const n = labels?.length || 0;
  if (!n) {
    uniforms.uGroupLutSize.value.set(0, 0);
    uniforms.uGroupMarked.value = 0;
    return;
  }
  const w = Math.min(2048, n);
  const h = Math.ceil(n / w);

  let tex = uniforms.uGroupLut.value;
  if (!tex || tex.image.width !== w || tex.image.height !== h) {
    tex?.dispose?.();
    // Two channels rather than a second texture: which group a superface is in
    // and whether that group is picked are asked at the same moment, of the same
    // index, and one fetch answers both.
    tex = new THREE.DataTexture(
      new Float32Array(w * h * 2),
      w,
      h,
      THREE.RGFormat,
      THREE.FloatType
    );
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    uniforms.uGroupLut.value = tex;
  }
  const data = tex.image.data;
  let any = 0;
  for (let i = 0; i < n; i++) {
    data[i * 2] = labels[i];
    const mark = marks ? marks[i] : 0;
    data[i * 2 + 1] = mark;
    any |= mark;
  }
  tex.needsUpdate = true;
  uniforms.uGroupLutSize.value.set(w, h);
  uniforms.uGroupMarked.value = any ? 1 : 0;
}

/**
 * Write the two group attributes onto geometry `prepareWire` has already seen.
 *
 * Separate from `prepareWire` on purpose, and this is not a stylistic split.
 * That function returns early on any geometry that already carries `aBary`
 * unless the call brings new mask data, which is the right rule for what it
 * does and the wrong one here: switching the plain wireframe on prepares every
 * geometry in the scene, and a segmentation arriving afterwards would then be
 * skipped and draw nothing.
 *
 * It takes a **list of meshes** rather than a root to traverse, and that is the
 * one thing in here that has to be exact. The ids are one flat array in the
 * order the engine read them, which is the order they were written to the GLB,
 * and the exporter writes with `onlyVisible`. A traversal here would happily
 * count a hidden mesh the exporter skipped, and every id after it would land on
 * the wrong triangle — a segmentation that looks like a segmentation and is
 * shifted by however many triangles were hidden. The caller collects the list
 * once and uses the same one for both halves.
 *
 * `superOfFace` is one id per triangle across the whole list. `nbrOfFace` is
 * three per triangle: the superface across the edge from corner `k` to `k + 1`,
 * and `0xffffffff` where the mesh has an open border.
 */
export function ensureGroupAttributes(meshes, superOfFace, nbrOfFace) {
  let tri = 0;
  for (const n of meshes) {
    const g = n?.geometry;
    if (!g?.attributes?.position) continue;

    const count = g.attributes.position.count;
    const group = new Float32Array(count);
    const nbr = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const t = tri + ((i / 3) | 0);
      // Past the end of the data is a mesh the run did not cover, and the
      // largest u32 is a triangle the engine threw away as degenerate. Both are
      // the "not segmented" case rather than the "group zero" one, and neither
      // survives a float exactly, so both become -1.
      const s = superOfFace?.[t];
      group[i] = s === undefined || s === 0xffffffff ? -1 : s;
      for (let k = 0; k < 3; k++) {
        const v = nbrOfFace?.[t * 3 + k];
        // An open border comes across as the largest u32, which does not
        // survive a float exactly. Negative says "nobody there" in a number the
        // shader can compare without a second uniform to explain it.
        nbr[i * 3 + k] = v === undefined || v === 0xffffffff ? -1 : v;
      }
    }

    g.setAttribute("aGroup", new THREE.BufferAttribute(group, 1));
    g.setAttribute("aNbr", new THREE.BufferAttribute(nbr, 3));
    tri += count / 3;
  }
  return tri;
}

/**
 * Forget a segmentation, so nothing claims one that no longer exists.
 *
 * Written back to -1 rather than deleted, and the difference matters. A missing
 * attribute is not absent as far as the shader is concerned: WebGL feeds a
 * disabled attribute the generic value, which is zero, and zero is a perfectly
 * good superface id. Deleting these would therefore paint the whole model in
 * group zero's colour rather than in none — the same plausible lie that the
 * fill in `prepareWire` exists to prevent, arrived at from the other direction.
 */
export function clearGroupAttributes(root) {
  root?.traverse?.((n) => {
    const g = n.geometry;
    const group = g?.attributes?.aGroup;
    if (!group) return;
    group.array.fill(-1);
    group.needsUpdate = true;
    const nbr = g.attributes.aNbr;
    if (nbr) {
      nbr.array.fill(-1);
      nbr.needsUpdate = true;
    }
  });
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
attribute float aGroup;
attribute vec3 aNbr;
varying vec3 vBary;
varying float vEdges;
varying float vChart;
varying float vDev;
varying float vGroup;
varying vec3 vNbr;
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
uniform float uWireOnly;
uniform float uQuads;
uniform float uSplit;
uniform float uSide;
uniform vec2 uViewport;
uniform float uView;
uniform float uDevScale;
uniform float uXray;
uniform float uGroupView;
uniform float uGroupMarked;
uniform sampler2D uGroupLut;
uniform vec2 uGroupLutSize;
varying vec3 vBary;
varying float vEdges;
varying float vChart;
varying float vDev;
varying float vGroup;
varying vec3 vNbr;
varying vec3 vRtNormal;

/*
 * Which group a superface currently belongs to.
 *
 * texelFetch rather than a normalised sample: the table is data, not an
 * image, and asking for texel 4097 of 20000 through UV coordinates means
 * getting the arithmetic exactly right at every resize or reading a neighbour's
 * value, which is a bug that looks like a segmentation flickering between two
 * plausible answers.
 *
 * Negative in means negative out. aNbr uses -1 for "the mesh ends here", and
 * that has to survive the lookup so the border test below can treat a
 * silhouette as an outline rather than as a group called minus one.
 */
vec2 groupAt(float superId) {
  if (superId < 0.0 || uGroupLutSize.x < 1.0) return vec2(-1.0, 0.0);
  int w = int(uGroupLutSize.x);
  int i = int(superId + 0.5);
  return texelFetch(uGroupLut, ivec2(i - (i / w) * w, i / w), 0).rg;
}
float groupOf(float superId) { return groupAt(superId).r; }

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
 * Appended at the very end of `main`, which is after tone mapping and after the
 * colour space conversion. That is deliberate: the line is a diagram drawn on
 * top of a photograph, not a surface in the scene, so it should come out the
 * colour it was asked for rather than the colour the exposure curve makes of it.
 *
 * It used to anchor on `#include <dithering_fragment>`, which is the last line
 * of `main` in the lit and basic shaders and **does not exist at all** in
 * `MeshNormalMaterial`. So the overlay silently did nothing on the normals
 * channel: no error, no warning, just no lines. The end of `main` is the same
 * place in the shaders that have the include and a place that exists in the ones
 * that do not.
 */
const FRAG_WIRE = /* glsl */ `
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
 * The groups.
 *
 * Three pictures and one outline, and the outline is drawn in all of them. It
 * is derived rather than stored: vNbr says which superface sits across each
 * of the three edges, both sides go through the same lookup table, and an edge
 * whose two sides land on different groups is a border. That is why moving the
 * slider costs one small texture upload and no geometry work at all — the
 * borders re-draw themselves because the answer they read changed.
 *
 * vBary.x vanishes on the edge between corners 1 and 2, y on 2 to 0 and z on
 * 0 to 1, while aNbr[k] is the neighbour across corner k to k + 1. So
 * the three cross over as 1, 2, 0 rather than staying in order, exactly as the
 * quad mask below does and for exactly the same reason.
 */
if (uGroupView > 0.5 && uGroupLutSize.x >= 1.0 && vGroup >= 0.0) {
  float g = groupOf(vGroup);

  if (uGroupView < 1.5) {
    // Flat colours, lit only by how square-on the surface is. A field of pure
    // hues has no form in it and you cannot tell which group is behind a fold.
    float lit = 0.42 + 0.58 * clamp(abs(dot(normalize(vRtNormal), vec3(0.0, 0.0, 1.0))), 0.0, 1.0);
    gl_FragColor.rgb = chartColour(g) * lit;
  } else if (uGroupView < 2.5) {
    // A tint, so the texture underneath still reads. This is the one to work
    // in when you are judging whether a border follows something real.
    gl_FragColor.rgb = mix(gl_FragColor.rgb, chartColour(g), 0.45);
  }

  vec3 near = vec3(groupOf(vNbr.y), groupOf(vNbr.z), groupOf(vNbr.x));
  vec3 gd = fwidth(vBary);
  vec3 ga = smoothstep(vec3(0.0), gd * 1.6, vBary);
  if (near.x == g) ga.x = 1.0;
  if (near.y == g) ga.y = 1.0;
  if (near.z == g) ga.z = 1.0;
  float gedge = 1.0 - min(min(ga.x, ga.y), ga.z);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uWireColor, gedge * 0.9);

  /*
   * Picked groups keep their colour; the rest go grey rather than invisible.
   *
   * Hiding them would take away the silhouette that says where the picked part
   * sits on the model, which is most of what somebody is judging when they pick
   * it. Greying leaves the shape and removes the claim.
   */
  if (uGroupMarked > 0.5 && groupAt(vGroup).g < 0.5) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.42), 0.82) * 0.42;
  }
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
  if (uWireOnly > 0.5) {
    // Lines only: throw the surface away and keep the edge, in the same colour
    // as the overlay. Discarding rather than fading keeps this a mode of the
    // one system rather than a second kind of material, and the line comes out
    // in the light or dark choice the master switch already makes.
    if (edge < 0.35) discard;
    gl_FragColor = vec4(uWireColor, 1.0);
  } else {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uWireColor, edge * uWire * 0.85);
  }
}
`;

/**
 * Everything the fragment stage reads, written where `main` begins.
 *
 * All five, and that matters: three of them used to be *declared* in both stages
 * and assigned in neither. A varying that is never written reads as whatever was
 * left in the register, so the atlas view, the deviation heatmap and the x-ray
 * were each drawing a plausible picture out of nothing. Nothing errors, nothing
 * warns, and the output looks exactly like data.
 *
 * The normal is this module's own rather than three's `vNormal`, which is
 * declared under `ifndef FLAT_SHADED` and would therefore stop the shader
 * compiling the moment the flat toggle is switched on. It is the object normal
 * through `normalMatrix`, so it ignores skinning and morphs: good enough for a
 * facing term used to shade a diagram, and wrong for anything else, which is why
 * it is not used for anything else.
 */
const VERT_MAIN = /* glsl */ `
  vBary = aBary;
  vEdges = aEdges;
  vChart = aChart;
  vDev = aDev;
  vGroup = aGroup;
  vNbr = aNbr;
  vRtNormal = normalMatrix * normal;
`;

/**
 * Put a block at the end of `main`, whatever shader it is.
 *
 * Returns null rather than the source unchanged when there is no `main` to
 * append to, so the caller can say so instead of shipping a material that
 * quietly draws nothing.
 */
function appendToMain(source) {
  const end = source.lastIndexOf("}");
  if (end < 0) return null;
  return `${source.slice(0, end)}\n${FRAG_WIRE}\n}${source.slice(end + 1)}`;
}

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
        "void main() {" + VERT_MAIN
      );
      const lit = appendToMain(
        // The curtain discards before any lighting runs. Shading a fragment and
        // then throwing it away is the same picture for more work.
        shader.fragmentShader.replace("void main() {", "void main() {" + FRAG_SPLIT)
      );
      if (!lit) {
        console.warn("[albedo] fil de fer : aucun main() dans", m.type);
        return;
      }
      shader.fragmentShader = FRAG_HEAD + lit;
    };
    // Without this every patched material shares one compiled program with
    // every unpatched one, and the overlay appears on things that never asked
    // for it.
    m.customProgramCacheKey = () => "albedo-wire";
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
