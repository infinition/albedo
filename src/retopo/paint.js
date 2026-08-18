import * as THREE from "three";

/**
 * Painting on the model, so the retopology can be told where to care.
 *
 * The rest of this mode asks one question — how many triangles — and applies the
 * answer everywhere. That is the right shape for a first pass and the wrong
 * shape for the work that follows it. The face needs its detail and the back of
 * the skull does not. The bolt heads have to survive and the plate they sit on
 * can lose ninety percent. That fold across the shoulder is a real edge and no
 * cost function is going to guess it. Every one of those is knowledge the person
 * looking at the screen already has, and there was nowhere to put it.
 *
 * So: four brushes and a pen.
 *
 * - **Densité** — where triangles are worth spending, from −1 to +1. Neutral
 *   everywhere by default, which is the identity: an unpainted model decimates
 *   exactly as it always did.
 * - **Geler** — never touch this. Hard, not a preference.
 * - **Zone** — the only part of the model this run may modify at all. Paint the
 *   face, run, and the hands come back untouched, vertex for vertex.
 * - **Guides** — curves drawn along the surface. A *pli* is a promise that the
 *   result still has an edge there; a *flux* says which way the loops should
 *   run, so the edges along it are kept and the ones across it are spent.
 *
 * # Three things this file is careful about
 *
 * **The brush measures along the surface, not through it.** A sphere of
 * influence painted on one side of an ear paints the other side too, and on a
 * hand it paints the neighbouring finger. Every stamp here is a Dijkstra walk
 * over the mesh's own edges, so the paint goes where the surface goes and stops
 * at a gap. It costs one priority queue per stamp and it is the difference
 * between a brush you can use on a real model and a demo.
 *
 * **The values live on welded points, not on render vertices.** A UV seam or a
 * hard edge duplicates a position in the vertex buffer, and a brush that does
 * not know that paints one of the copies: the seam then shows as a hairline of
 * unpainted surface that no amount of going over it will fill. The engine welds
 * for exactly the same reason.
 *
 * **The pen is the pointer, not a special case.** Pressure, tilt and the eraser
 * end arrive through `PointerEvent` like everything else, and the coalesced
 * queue is drained on every move so a fast stroke is sampled at the digitiser's
 * rate rather than the frame rate. A mouse reports a pressure of 0.5 and works
 * unchanged.
 */

/** The layers, in the order they are drawn and reported. */
export const LAYERS = ["density", "freeze", "region"];

/** Guide kinds, matching the engine's `Guide::CREASE` and `Guide::FLOW`. */
const GUIDE_KIND = { crease: 0, flow: 1 };

/** The sidecar's magic. Bumping the last two digits is how a format changes. */
const MAGIC = "ALBPNT01";

/**
 * A minimal binary heap over `(distance, vertex)`.
 *
 * Written out rather than reached for, because the alternative in a brush is
 * sorting an array on every pop, and a stamp on a dense mesh visits a few
 * thousand points: an O(n log n) sort per pop turns a brush that feels attached
 * to the pen into one that lags a stroke behind it.
 */
class Heap {
  constructor() {
    this.d = [];
    this.v = [];
  }
  get size() {
    return this.v.length;
  }
  push(dist, vert) {
    const { d, v } = this;
    let i = d.length;
    d.push(dist);
    v.push(vert);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= d[i]) break;
      [d[p], d[i]] = [d[i], d[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { d, v } = this;
    const topD = d[0];
    const topV = v[0];
    const lastD = d.pop();
    const lastV = v.pop();
    if (d.length) {
      d[0] = lastD;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < d.length && d[l] < d[s]) s = l;
        if (r < d.length && d[r] < d[s]) s = r;
        if (s === i) break;
        [d[s], d[i]] = [d[i], d[s]];
        [v[s], v[i]] = [v[i], v[s]];
        i = s;
      }
    }
    return [topD, topV];
  }
}

/**
 * The welded view of one geometry, plus the paint that sits on it.
 *
 * Built once per geometry and cached on the geometry itself, because building it
 * walks every triangle twice and a stroke would otherwise pay for that on every
 * stamp. Keyed on the geometry object rather than on the mesh: `prepareWire`
 * replaces a geometry with a non-indexed copy the first time the wireframe is
 * switched on, and a cache keyed on the mesh would then be describing a buffer
 * that is no longer there — silently, with every index off by however much the
 * expansion shifted things.
 */
const CACHE = new WeakMap();

function topologyOf(geometry) {
  const cached = CACHE.get(geometry);
  if (cached) return cached;

  const position = geometry.attributes.position;
  const renderCount = position.count;

  geometry.computeBoundingSphere();
  const scale = geometry.boundingSphere?.radius || 1;
  // A grid fine enough that two points a person would call distinct never share
  // a cell, and coarse enough that the identical floats an exporter writes for
  // the two sides of a seam always do.
  const eps = Math.max(scale * 1e-5, 1e-9);

  const weldOf = new Uint32Array(renderCount);
  const seen = new Map();
  const wx = [];
  const wy = [];
  const wz = [];
  const px = position.array;
  const stride = position.itemSize;
  for (let i = 0; i < renderCount; i++) {
    const x = px[i * stride];
    const y = px[i * stride + 1];
    const z = px[i * stride + 2];
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
    let w = seen.get(key);
    if (w === undefined) {
      w = wx.length;
      seen.set(key, w);
      wx.push(x);
      wy.push(y);
      wz.push(z);
    }
    weldOf[i] = w;
  }
  const count = wx.length;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = wx[i];
    pos[i * 3 + 1] = wy[i];
    pos[i * 3 + 2] = wz[i];
  }

  // Triangles, in welded ids, and the one-ring as a CSR pair. Two passes so the
  // neighbour list is one flat array rather than `count` little ones: on a
  // million point mesh that is the difference between eight megabytes and a
  // garbage collector pause in the middle of a stroke.
  const index = geometry.index;
  const triCount = (index ? index.count : renderCount) / 3;
  const tri = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const r = index ? index.getX(t * 3 + k) : t * 3 + k;
      tri[t * 3 + k] = weldOf[r];
    }
  }

  const degree = new Uint32Array(count + 1);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      degree[tri[t * 3 + k]] += 2;
    }
  }
  const start = new Uint32Array(count + 1);
  let running = 0;
  for (let i = 0; i < count; i++) {
    start[i] = running;
    running += degree[i];
  }
  start[count] = running;
  const list = new Uint32Array(running);
  const fill = start.slice(0, count);
  for (let t = 0; t < triCount; t++) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    list[fill[a]++] = b;
    list[fill[a]++] = c;
    list[fill[b]++] = a;
    list[fill[b]++] = c;
    list[fill[c]++] = a;
    list[fill[c]++] = b;
  }

  const topo = {
    geometry,
    weldOf,
    count,
    renderCount,
    pos,
    tri,
    triCount,
    start,
    list,
    radius: scale,
    layers: {
      density: new Float32Array(count),
      freeze: new Float32Array(count),
      region: new Float32Array(count),
    },
    // The attribute the overlay reads. One vec3 per *render* vertex, refreshed
    // from the welded layers after every stamp.
    attribute: null,
    /** Median edge length, for deciding how close a sample has to be. */
    edge: 0,
  };

  // Median rather than mean: one degenerate sliver in a model of a hundred
  // thousand triangles drags a mean by a factor of ten, and this number decides
  // how far the engine will look for a painted point.
  const sampleCount = Math.min(triCount, 4096);
  const step = Math.max(1, Math.floor(triCount / sampleCount));
  const lengths = [];
  for (let t = 0; t < triCount; t += step) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const dx = pos[a * 3] - pos[b * 3];
    const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    lengths.push(Math.hypot(dx, dy, dz));
  }
  lengths.sort((p, q) => p - q);
  topo.edge = lengths[lengths.length >> 1] || scale * 1e-3;

  CACHE.set(geometry, topo);
  return topo;
}

/**
 * Everything within `radius` of the seeds, measured along the edges.
 *
 * Returns the visited points and their distances rather than applying anything,
 * so a stamp can be previewed, undone and blended without three copies of this
 * walk existing.
 */
function walkSurface(topo, seeds, radius) {
  const { start, list, pos } = topo;
  const dist = new Map();
  const heap = new Heap();
  for (const s of seeds) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      heap.push(0, s);
    }
  }
  const out = [];
  while (heap.size) {
    const [d, v] = heap.pop();
    // A stale entry: this point was reached again by a shorter path after it
    // went into the queue. Cheaper than a decrease-key.
    if (d > (dist.get(v) ?? Infinity)) continue;
    out.push([v, d]);
    const vx = pos[v * 3];
    const vy = pos[v * 3 + 1];
    const vz = pos[v * 3 + 2];
    for (let i = start[v]; i < start[v + 1]; i++) {
      const n = list[i];
      const nd =
        d +
        Math.hypot(pos[n * 3] - vx, pos[n * 3 + 1] - vy, pos[n * 3 + 2] - vz);
      if (nd > radius) continue;
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd);
        heap.push(nd, n);
      }
    }
  }
  return out;
}

/** Smooth at the centre, zero at the rim, and no corner in between. */
function falloffAt(t, hardness) {
  const x = Math.min(1, Math.max(0, 1 - t));
  const smooth = x * x * (3 - 2 * x);
  // Hardness pulls the curve toward a flat disc without ever reaching one: a
  // truly hard edge aliases against the triangle grid and looks like damage.
  return smooth * (1 - hardness) + Math.min(1, x * 3) * hardness;
}

/**
 * The painting, and the pen that makes it.
 *
 * @param {object} deps
 * @param {any} deps.viewer the viewer, for its canvas, camera and scene
 * @param {any} deps.wireUniforms the shared overlay uniforms, so the paint view
 *   is a mode of the one patched shader rather than a second one
 */
export function createPainting({ viewer, wireUniforms }) {
  /** Which brush is live, or null when the pen just orbits the camera. */
  let tool = null;
  let guideKind = "crease";
  /** +1 adds, −1 takes away. The eraser end of a pen flips it for you. */
  let polarity = 1;

  const brush = {
    /** As a share of the model's radius, so it means the same on any model. */
    size: 0.06,
    strength: 0.6,
    hardness: 0.25,
    /** Pen pressure drives the radius, the strength, both or neither. */
    pressureSize: true,
    pressureStrength: true,
  };

  /** Guides, each one bound to the mesh it was drawn on. */
  const guides = [];
  /** Meshes that carry paint, so a sidecar knows what to look at. */
  const painted = new Set();

  /** One entry per stroke: enough to put the layers back exactly. */
  const undoStack = [];
  const redoStack = [];

  let onChange = null;
  const changed = () => {
    viewer.invalidate?.();
    onChange?.();
  };

  // ---------------------------------------------------------------------------
  // The paint, on the surface
  // ---------------------------------------------------------------------------

  /**
   * Refresh the shader attribute from the welded layers.
   *
   * Whole-buffer rather than by range. The range would have to be the union of
   * every render vertex mapping onto every welded point a stamp touched, and on
   * a seam those are scattered across the buffer: the union is nearly the whole
   * thing on any model where it would have mattered.
   */
  function syncAttribute(mesh) {
    const topo = topologyOf(mesh.geometry);
    let attr = mesh.geometry.attributes.aPaint;
    if (!attr || attr.count !== topo.renderCount) {
      attr = new THREE.BufferAttribute(new Float32Array(topo.renderCount * 3), 3);
      mesh.geometry.setAttribute("aPaint", attr);
      topo.attribute = attr;
    }
    const { density, freeze, region } = topo.layers;
    const a = attr.array;
    for (let r = 0; r < topo.renderCount; r++) {
      const w = topo.weldOf[r];
      a[r * 3] = density[w];
      a[r * 3 + 1] = freeze[w];
      a[r * 3 + 2] = region[w];
    }
    attr.needsUpdate = true;
  }

  /** Does any mesh carry a region, anywhere? The shader greys out the rest. */
  function anyRegion() {
    for (const mesh of painted) {
      const topo = CACHE.get(mesh.geometry);
      if (!topo) continue;
      for (let i = 0; i < topo.count; i++) if (topo.layers.region[i] > 0.5) return true;
    }
    return false;
  }

  function refreshUniforms() {
    if (!wireUniforms) return;
    wireUniforms.uPaint.value = tool || showPaint ? 1 : 0;
    wireUniforms.uPaintRegion.value = anyRegion() ? 1 : 0;
  }

  let showPaint = true;

  // ---------------------------------------------------------------------------
  // One stamp
  // ---------------------------------------------------------------------------

  /** Values changed during the stroke in progress, so it can be taken back. */
  let strokeEdits = null;
  /** How much of the stroke's target each point has already received. */
  let strokeReach = null;

  function beginStroke() {
    strokeEdits = new Map();
    strokeReach = new Map();
  }

  /**
   * Record a point's value before this stroke touches it.
   *
   * Once per point per stroke, never on repeat: a stroke that crosses itself
   * would otherwise record the half-painted value from its own first pass, and
   * undo would put *that* back.
   */
  function remember(mesh, layer, index, value) {
    let perMesh = strokeEdits.get(mesh);
    if (!perMesh) strokeEdits.set(mesh, (perMesh = new Map()));
    let perLayer = perMesh.get(layer);
    if (!perLayer) perMesh.set(layer, (perLayer = new Map()));
    if (!perLayer.has(index)) perLayer.set(index, value);
  }

  /**
   * Put one dab of paint on one mesh.
   *
   * @param {any} hit a three.js intersection, so face and point are already
   *   resolved against the geometry the person is actually looking at
   * @param {number} pressure 0..1, straight off the pen
   */
  function stamp(hit, pressure) {
    const mesh = hit.object;
    const geometry = mesh.geometry;
    if (!geometry?.attributes?.position || !hit.face) return;
    const topo = topologyOf(geometry);

    // The brush is a size on the model, and the model has a scale. Working in
    // the geometry's own units means a mesh scaled to a tenth does not get a
    // brush ten times too big — which is what happens whenever a model arrives
    // in centimetres and the importer normalises it.
    const worldScale = new THREE.Vector3();
    mesh.getWorldScale(worldScale);
    const unit = Math.max(1e-6, (worldScale.x + worldScale.y + worldScale.z) / 3);
    const size = brush.size * (brush.pressureSize ? 0.35 + 0.65 * pressure : 1);
    const radius = Math.max(topo.edge * 1.5, topo.radius * size);

    // The three corners of the triangle under the pointer, in welded ids, are
    // the seeds. Seeding from the nearest one alone puts the centre of the brush
    // at a vertex rather than under the pen, which is visible as soon as the
    // triangles are larger than the brush.
    const face = hit.face;
    const seeds = [topo.weldOf[face.a], topo.weldOf[face.b], topo.weldOf[face.c]];

    const reached = walkSurface(topo, seeds, radius);
    if (!reached.length) return;

    const layer = tool === "guide" ? null : tool;
    if (!layer) return;
    const values = topo.layers[layer];
    const flow = brush.strength * (brush.pressureStrength ? 0.15 + 0.85 * pressure : 1);

    for (const [v, d] of reached) {
      const w = falloffAt(d / radius, brush.hardness) * flow;
      if (w <= 0) continue;

      // Within one stroke a point takes the *strongest* dab it received, not the
      // sum of all of them. Summing is how a slow stroke comes out darker than a
      // fast one over the same ground, which is a brush that responds to the
      // speed of your hand rather than to your hand.
      const key = `${layer}:${v}`;
      const already = strokeReach.get(key) || 0;
      if (w <= already) continue;
      strokeReach.set(key, w);

      remember(mesh, layer, v, values[v]);
      const before = strokeEdits.get(mesh).get(layer).get(v);

      if (layer === "density") {
        // Toward the pole the brush is on, never past it, and the eraser is
        // simply the other pole: painting −1 over +1 walks it back through
        // neutral rather than leaving a hole to be found later.
        const target = polarity > 0 ? 1 : -1;
        values[v] = before + (target - before) * w;
      } else {
        // Freeze and region are yes or no questions. The falloff still decides
        // *whether* a point is caught at the rim, so the boundary follows the
        // brush rather than the mesh's triangles.
        values[v] = polarity > 0 ? (w > 0.35 ? 1 : before) : w > 0.35 ? 0 : before;
      }
    }

    painted.add(mesh);
    syncAttribute(mesh);
  }

  function endStroke() {
    if (!strokeEdits || !strokeEdits.size) {
      strokeEdits = strokeReach = null;
      return;
    }
    undoStack.push(strokeEdits);
    // A new stroke is a branch nobody took: the redos ahead of it described a
    // painting that no longer exists.
    redoStack.length = 0;
    strokeEdits = strokeReach = null;
    refreshUniforms();
    changed();
  }

  /** Swap an edit set for the values it replaced, and hand back the inverse. */
  function applyEdits(edits) {
    const inverse = new Map();
    for (const [mesh, byLayer] of edits) {
      const topo = CACHE.get(mesh.geometry);
      if (!topo) continue;
      const invLayers = new Map();
      for (const [layer, byIndex] of byLayer) {
        const values = topo.layers[layer];
        const inv = new Map();
        for (const [i, v] of byIndex) {
          inv.set(i, values[i]);
          values[i] = v;
        }
        invLayers.set(layer, inv);
      }
      inverse.set(mesh, invLayers);
      syncAttribute(mesh);
    }
    refreshUniforms();
    changed();
    return inverse;
  }

  // ---------------------------------------------------------------------------
  // Guides
  // ---------------------------------------------------------------------------

  /**
   * The curve being drawn, in the mesh's own space.
   *
   * Local rather than world, so the orientation buttons and the transform
   * handles move a guide with the thing it was drawn on. A guide in world space
   * would stay hanging in the air the first time the model is turned.
   */
  let liveGuide = null;

  const GUIDE_COLOUR = { crease: 0xffb020, flow: 0x30c8ff };

  /** The tube, and the scaffolding that keeps it out of everything's way. */
  function buildGuideObject(guide) {
    const points = guide.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points);
    const topo = CACHE.get(guide.mesh.geometry);
    const thickness = (topo?.edge || 0.01) * 0.9;
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.min(512, Math.max(8, points.length * 2)),
      thickness,
      6,
      false
    );
    /*
     * A dummy barycentric attribute, and the material marked as already
     * patched.
     *
     * Both are there to keep the wireframe overlay's hands off this object.
     * `prepareWire` skips a geometry that already carries `aBary`, and
     * `patchWire` skips a material that says it has been done: without the two,
     * opening the wireframe would un-index this tube, draw its own edges over it
     * and count its triangles into the mode's own counters.
     */
    geometry.setAttribute(
      "aBary",
      new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3)
    );
    const material = new THREE.MeshBasicMaterial({
      color: GUIDE_COLOUR[guide.kind] || 0xffffff,
      toneMapped: false,
      depthTest: true,
      transparent: true,
      opacity: 0.95,
    });
    material.userData.wirePatched = true;
    const object = new THREE.Mesh(geometry, material);
    object.name = `guide-${guide.kind}`;
    object.userData.albedoGuide = true;
    // Never in the way of the brush, and never picked as if it were the model.
    object.raycast = () => {};
    object.renderOrder = 5;
    return object;
  }

  function drawGuide(guide) {
    guide.object?.geometry?.dispose();
    guide.object?.material?.dispose();
    guide.object?.parent?.remove(guide.object);
    guide.object = buildGuideObject(guide);
    if (guide.object) guide.mesh.add(guide.object);
  }

  /**
   * Thin a hand-drawn stroke down to the points that carry its shape.
   *
   * Ramer–Douglas–Peucker. A pen at a hundred and twenty hertz produces several
   * hundred points across a short curve, nearly all of them saying the same
   * thing as their neighbours, and every one of them becomes a band of
   * constrained vertices at the far end. Thinning first is what keeps a guide a
   * guide rather than a wall.
   */
  function simplify(points, tolerance) {
    if (points.length < 3) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const p = new THREE.Vector3();
    while (stack.length) {
      const [lo, hi] = stack.pop();
      if (hi - lo < 2) continue;
      a.fromArray(points[lo]);
      b.fromArray(points[hi]);
      const ab = b.clone().sub(a);
      const len2 = ab.lengthSq();
      let worst = -1;
      let at = -1;
      for (let i = lo + 1; i < hi; i++) {
        p.fromArray(points[i]);
        const t = len2 > 0 ? Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / len2)) : 0;
        const d = p.distanceTo(a.clone().addScaledVector(ab, t));
        if (d > worst) {
          worst = d;
          at = i;
        }
      }
      if (worst > tolerance && at > 0) {
        keep[at] = 1;
        stack.push([lo, at], [at, hi]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // ---------------------------------------------------------------------------
  // The pen
  // ---------------------------------------------------------------------------

  const canvas = viewer.canvas;
  const ray = new THREE.Raycaster();
  let drawing = false;
  let activePointer = null;
  /** When a pen was last seen, so a palm resting on the glass is ignored. */
  let lastPen = 0;
  /** Where the last sample landed on screen, for filling in a fast stroke. */
  let lastScreen = null;

  /** The ring under the pointer, so the size of the brush is visible. */
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.0, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  );
  cursor.visible = false;
  cursor.renderOrder = 999;
  cursor.raycast = () => {};
  cursor.name = "brush-cursor";
  viewer.scene.add(cursor);

  const CURSOR_COLOUR = {
    density: 0xffd166,
    freeze: 0xb98cff,
    region: 0x4ade80,
    guide: 0xffb020,
  };

  function ndc(e) {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  /** What the pointer is over, restricted to what the mode may paint on. */
  function pickSurface(e) {
    const p = ndc(e);
    ray.setFromCamera(p, viewer.camera);
    const hits = ray.intersectObject(viewer.root, true);
    for (const hit of hits) {
      const o = hit.object;
      if (!o.visible || (!o.isMesh && !o.isSkinnedMesh)) continue;
      if (o.userData.albedoGuide) continue;
      let up = o.parent;
      let shown = true;
      while (up && shown) {
        if (!up.visible) shown = false;
        up = up.parent;
      }
      if (shown) return hit;
    }
    return null;
  }

  function moveCursor(hit, pressure) {
    if (!hit) {
      if (cursor.visible) {
        cursor.visible = false;
        viewer.invalidate?.();
      }
      return;
    }
    const topo = topologyOf(hit.object.geometry);
    const worldScale = new THREE.Vector3();
    hit.object.getWorldScale(worldScale);
    const unit = (worldScale.x + worldScale.y + worldScale.z) / 3 || 1;
    const size = brush.size * (brush.pressureSize && drawing ? 0.35 + 0.65 * pressure : 1);
    const radius = Math.max(topo.edge * 1.5, topo.radius * size) * unit;

    cursor.position.copy(hit.point);
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
    cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.normalize());
    // Off the surface by a hair, or the ring z-fights with what it is drawn on.
    cursor.position.addScaledVector(normal, radius * 0.02);
    cursor.scale.setScalar(radius);
    cursor.material.color.setHex(CURSOR_COLOUR[tool] || 0xffffff);
    cursor.visible = true;
    viewer.invalidate?.();
  }

  /**
   * One pointer sample, from wherever it came.
   *
   * Called for the event itself and for every coalesced sample behind it, so a
   * fast stroke on a hundred and twenty hertz digitiser paints the curve the
   * hand drew rather than the six points a sixty hertz frame loop saw of it.
   */
  function sample(e) {
    const pressure = e.pointerType === "mouse" ? 1 : e.pressure > 0 ? e.pressure : 0.5;
    const hit = pickSurface(e);
    moveCursor(hit, pressure);
    if (!drawing || !hit) return;

    if (tool === "guide") {
      if (!liveGuide) {
        liveGuide = {
          mesh: hit.object,
          kind: guideKind,
          points: [],
          object: null,
          radiusScale: brush.size,
          strength: brush.strength,
        };
      }
      // A guide belongs to one mesh: a curve that wandered onto the next object
      // would be recorded in that object's coordinates and drawn in these.
      if (hit.object !== liveGuide.mesh) return;
      const local = hit.object.worldToLocal(hit.point.clone());
      const last = liveGuide.points.at(-1);
      const topo = topologyOf(hit.object.geometry);
      // One point per third of an edge at most: closer than that is the
      // digitiser's noise, not the hand's intention.
      if (
        !last ||
        Math.hypot(local.x - last[0], local.y - last[1], local.z - last[2]) > topo.edge * 0.33
      ) {
        liveGuide.points.push([local.x, local.y, local.z]);
        if (liveGuide.points.length >= 2) drawGuide(liveGuide);
        viewer.invalidate?.();
      }
      return;
    }

    stamp(hit, pressure);

    /*
     * Fill in the gap since the last sample.
     *
     * Even at the digitiser's own rate a fast stroke moves further between two
     * samples than the brush is wide, and what lands on the model is a row of
     * dots. The gap is walked in screen space and each step re-picked, because
     * interpolating on the surface would need a geodesic between two points that
     * may be on opposite sides of a fold.
     */
    const here = new THREE.Vector2(e.clientX, e.clientY);
    if (lastScreen) {
      const gap = here.distanceTo(lastScreen);
      const stepPx = Math.max(4, cursorRadiusPx(hit) * 0.4);
      const steps = Math.min(24, Math.floor(gap / stepPx));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const fake = {
          clientX: lastScreen.x + (here.x - lastScreen.x) * t,
          clientY: lastScreen.y + (here.y - lastScreen.y) * t,
          pointerType: e.pointerType,
        };
        const midHit = pickSurface(fake);
        if (midHit) stamp(midHit, pressure);
      }
    }
    lastScreen = here;
    viewer.invalidate?.();
  }

  /** The brush's radius as it appears on screen, for spacing the fill-in. */
  function cursorRadiusPx(hit) {
    const topo = topologyOf(hit.object.geometry);
    const worldScale = new THREE.Vector3();
    hit.object.getWorldScale(worldScale);
    const unit = (worldScale.x + worldScale.y + worldScale.z) / 3 || 1;
    const radius = Math.max(topo.edge * 1.5, topo.radius * brush.size) * unit;
    const distance = viewer.camera.position.distanceTo(hit.point);
    const fov = (viewer.camera.fov * Math.PI) / 180;
    const height = 2 * Math.tan(fov / 2) * Math.max(distance, 1e-6);
    return (radius / height) * canvas.clientHeight;
  }

  /**
   * Take or give back the pointer, and survive being refused.
   *
   * `setPointerCapture` throws `NotFoundError` whenever the id is not an active
   * pointer — a synthetic event, a pen the browser has already released, a
   * pointer some other element captured first. Unguarded, that exception aborts
   * the listener *before* the stroke starts, and what the person sees is a brush
   * that does nothing at all, intermittently, with no error anywhere they would
   * look.
   *
   * Capture is a convenience: it keeps a stroke attached to the pen when it
   * wanders off the canvas. Losing it costs that and nothing else, so being
   * refused is worth carrying on through rather than dying over.
   */
  function capture(id, on) {
    try {
      if (on) canvas.setPointerCapture?.(id);
      else canvas.releasePointerCapture?.(id);
    } catch (_) {
      /* see above: not having the pointer captured is not a reason to stop */
    }
  }

  function onPointerDown(e) {
    if (!tool) return;
    // Only the drawing button. The middle and right buttons still belong to the
    // camera, which is what makes it possible to turn the model mid-stroke
    // without putting the pen down.
    if (e.button !== 0) return;
    if (e.pointerType === "pen") lastPen = performance.now();
    // A palm on the glass reports as a touch a few milliseconds after the pen
    // arrives. Nothing else in this application uses touch on the canvas, so the
    // rule can be this blunt.
    if (e.pointerType === "touch" && performance.now() - lastPen < 1500) return;

    const hit = pickSurface(e);
    if (!hit) return;

    e.preventDefault();
    e.stopPropagation();
    capture(e.pointerId, true);
    activePointer = e.pointerId;
    drawing = true;
    lastScreen = null;
    // The barrel button on a stylus, and the eraser end, both mean "the other
    // way round" — which is what they mean in every application that has a
    // brush, so it is not a shortcut to be learnt here.
    polarity = e.buttons & 32 || e.altKey || e.ctrlKey ? -1 : 1;
    // The camera lets go for the duration. Same mechanism the light and lens
    // drags in `navigation.js` use, so there is one way this is done.
    if (viewer.controls) viewer.controls.enabled = false;
    beginStroke();
    if (tool !== "guide") sample(e);
    else sample(e);
  }

  function onPointerMove(e) {
    if (!tool) return;
    if (drawing && e.pointerId !== activePointer) return;
    if (e.pointerType === "pen") lastPen = performance.now();
    if (!drawing) {
      // Not drawing: this is only the ring following the pointer, and it must
      // not eat the event — the camera is still the pointer's business.
      sample(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const queue = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (queue.length) {
      for (const c of queue) sample(c);
    } else {
      sample(e);
    }
  }

  function onPointerUp(e) {
    if (!drawing || e.pointerId !== activePointer) return;
    e.preventDefault();
    e.stopPropagation();
    drawing = false;
    activePointer = null;
    lastScreen = null;
    capture(e.pointerId, false);
    if (viewer.controls) viewer.controls.enabled = true;

    if (tool === "guide" && liveGuide) {
      const topo = topologyOf(liveGuide.mesh.geometry);
      liveGuide.points = simplify(liveGuide.points, topo.edge * 0.4);
      if (liveGuide.points.length >= 2) {
        drawGuide(liveGuide);
        guides.push(liveGuide);
        undoStack.push({ guide: liveGuide });
        redoStack.length = 0;
        changed();
      } else {
        // A tap rather than a stroke. Nothing to keep, and nothing to leave
        // hanging in the scene either.
        liveGuide.object?.parent?.remove(liveGuide.object);
      }
      liveGuide = null;
      return;
    }
    endStroke();
  }

  function onPointerLeave() {
    if (drawing) return;
    if (cursor.visible) {
      cursor.visible = false;
      viewer.invalidate?.();
    }
  }

  /**
   * The wheel resizes the brush, the way it does in every tool with one.
   *
   * Captured before the camera's own wheel handler, and only while a brush is
   * live: with no tool selected the wheel is the zoom and nothing else.
   */
  function onWheel(e) {
    if (!tool || !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    brush.size = Math.min(0.5, Math.max(0.005, brush.size * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    onChange?.();
    const hit = pickSurface(e);
    moveCursor(hit, 1);
  }

  // Capture phase throughout: `navigation.js` and `main.js` both listen for
  // pointers on this canvas, and a brush that lets a stroke reach them turns the
  // camera while it paints.
  const opts = { capture: true, passive: false };
  canvas.addEventListener("pointerdown", onPointerDown, opts);
  canvas.addEventListener("pointermove", onPointerMove, opts);
  canvas.addEventListener("pointerup", onPointerUp, opts);
  canvas.addEventListener("pointercancel", onPointerUp, opts);
  canvas.addEventListener("pointerleave", onPointerLeave, opts);
  canvas.addEventListener("wheel", onWheel, opts);

  // ---------------------------------------------------------------------------
  // What leaves for the engine
  // ---------------------------------------------------------------------------

  /**
   * One mesh's painting, as the bytes the engine reads.
   *
   * Positions are in **world** space, which is the space the exported GLB is in:
   * three's exporter writes the node chain that leads to the mesh, and the
   * engine's reader multiplies it back through. Handing over local coordinates
   * would put every painted point wherever the model happened to be before it
   * was placed on the stand.
   *
   * Only painted points travel. A model of a million vertices with a thumbprint
   * of paint on it is a few thousand samples, and the engine reads "not in the
   * file" as "neutral" rather than needing a zero for every vertex.
   *
   * @returns {Uint8Array|null} null when this mesh carries nothing
   */
  function sidecarFor(mesh) {
    const topo = CACHE.get(mesh.geometry);
    const mine = guides.filter((g) => g.mesh === mesh && g.points.length >= 2);
    if (!topo && !mine.length) return null;

    const rows = [];
    let hasRegion = false;
    if (topo) {
      const { density, freeze, region } = topo.layers;
      for (let i = 0; i < topo.count; i++) if (region[i] > 0.5) hasRegion = true;
      for (let i = 0; i < topo.count; i++) {
        const d = density[i];
        const f = freeze[i] > 0.5;
        const r = region[i] > 0.5;
        // Neutral, unfrozen, and either inside a region nobody painted or
        // outside one that was: nothing to say about this point.
        if (Math.abs(d) < 1e-3 && !f && !r) continue;
        rows.push([i, d, f, r]);
      }
    }
    if (!rows.length && !mine.length) return null;

    const toWorld = new THREE.Vector3();
    mesh.updateWorldMatrix(true, false);

    let bytes = 8 + 4 + 4 + 4 + 4 + rows.length * 20;
    for (const g of mine) bytes += 16 + g.points.length * 12;
    const buffer = new ArrayBuffer(bytes);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    for (let i = 0; i < 8; i++) u8[i] = MAGIC.charCodeAt(i);

    let at = 8;
    view.setUint32(at, hasRegion ? 1 : 0, true);
    at += 4;
    /*
     * How close a mesh vertex has to be to a sample to *be* that sample.
     *
     * A quarter of a median edge. Wide enough to absorb the float round trip
     * through the GLB — the exporter writes single precision, and the world
     * transform is applied on both sides in a different order — and narrow
     * enough that a point can never claim its neighbour's paint.
     */
    const scale = new THREE.Vector3();
    mesh.getWorldScale(scale);
    const unit = (scale.x + scale.y + scale.z) / 3 || 1;
    view.setFloat32(at, (topo?.edge || 1e-3) * unit * 0.25, true);
    at += 4;
    view.setUint32(at, rows.length, true);
    at += 4;
    view.setUint32(at, mine.length, true);
    at += 4;

    for (const [i, d, f, r] of rows) {
      toWorld.set(topo.pos[i * 3], topo.pos[i * 3 + 1], topo.pos[i * 3 + 2]);
      mesh.localToWorld(toWorld);
      view.setFloat32(at, toWorld.x, true);
      view.setFloat32(at + 4, toWorld.y, true);
      view.setFloat32(at + 8, toWorld.z, true);
      view.setFloat32(at + 12, d, true);
      view.setUint32(at + 16, (f ? 1 : 0) | (r ? 2 : 0), true);
      at += 20;
    }

    for (const g of mine) {
      const gtopo = CACHE.get(g.mesh.geometry);
      view.setUint32(at, GUIDE_KIND[g.kind] ?? 0, true);
      // The band the guide reaches, in world units: the same brush size the
      // curve was drawn with, so what the person saw under the pen is what the
      // engine constrains.
      const reach = Math.max((gtopo?.edge || 1e-3) * 1.5, (gtopo?.radius || 1) * g.radiusScale);
      view.setFloat32(at + 4, reach * unit, true);
      view.setFloat32(at + 8, g.strength, true);
      view.setUint32(at + 12, g.points.length, true);
      at += 16;
      for (const p of g.points) {
        toWorld.set(p[0], p[1], p[2]);
        mesh.localToWorld(toWorld);
        view.setFloat32(at, toWorld.x, true);
        view.setFloat32(at + 4, toWorld.y, true);
        view.setFloat32(at + 8, toWorld.z, true);
        at += 12;
      }
    }

    return u8;
  }

  /**
   * The share of a mesh's triangles the region covers, or 1 when none was
   * painted.
   *
   * The budget slider is a percentage, and a percentage of *what* stops being
   * obvious the moment a run is confined to part of a model: asking for ten
   * percent of a head while only the face may be touched is a target the engine
   * cannot reach, and it would grind through every candidate before giving up.
   * The caller spends the percentage on the region and leaves the rest alone.
   */
  function regionShare(mesh) {
    const topo = CACHE.get(mesh.geometry);
    if (!topo) return 1;
    let any = false;
    for (let i = 0; i < topo.count; i++) {
      if (topo.layers.region[i] > 0.5) {
        any = true;
        break;
      }
    }
    if (!any) return 1;
    let inside = 0;
    for (let t = 0; t < topo.triCount; t++) {
      const a = topo.tri[t * 3];
      const b = topo.tri[t * 3 + 1];
      const c = topo.tri[t * 3 + 2];
      if (
        topo.layers.region[a] > 0.5 &&
        topo.layers.region[b] > 0.5 &&
        topo.layers.region[c] > 0.5
      ) {
        inside++;
      }
    }
    return topo.triCount ? inside / topo.triCount : 1;
  }

  // ---------------------------------------------------------------------------
  // The api
  // ---------------------------------------------------------------------------

  const api = {
    get tool() {
      return tool;
    },
    get brush() {
      return brush;
    },
    get guideKind() {
      return guideKind;
    },
    setTool(next) {
      tool = next || null;
      // Nothing to drag the camera by while a brush is live, and the ring is
      // gone the moment there is no brush.
      canvas.style.cursor = tool ? "crosshair" : "";
      canvas.style.touchAction = tool ? "none" : "";
      if (!tool) {
        cursor.visible = false;
        if (viewer.controls) viewer.controls.enabled = true;
      }
      refreshUniforms();
      changed();
    },
    setGuideKind(next) {
      guideKind = next === "flow" ? "flow" : "crease";
      onChange?.();
    },
    setBrush(patch) {
      Object.assign(brush, patch);
      onChange?.();
    },
    setView(on) {
      showPaint = !!on;
      refreshUniforms();
      changed();
    },
    get view() {
      return showPaint;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      if (entry.guide) {
        const i = guides.indexOf(entry.guide);
        if (i >= 0) guides.splice(i, 1);
        entry.guide.object?.parent?.remove(entry.guide.object);
        redoStack.push(entry);
        changed();
        return true;
      }
      redoStack.push(applyEdits(entry));
      return true;
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      if (entry.guide) {
        guides.push(entry.guide);
        drawGuide(entry.guide);
        if (entry.guide.object) entry.guide.mesh.add(entry.guide.object);
        undoStack.push(entry);
        changed();
        return true;
      }
      undoStack.push(applyEdits(entry));
      return true;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },

    /** Wipe one layer, or the guides, or everything. */
    clear(what = "all") {
      if (what === "guides" || what === "all") {
        for (const g of guides) {
          g.object?.geometry?.dispose();
          g.object?.material?.dispose();
          g.object?.parent?.remove(g.object);
        }
        guides.length = 0;
      }
      for (const mesh of painted) {
        const topo = CACHE.get(mesh.geometry);
        if (!topo) continue;
        for (const layer of LAYERS) {
          if (what === "all" || what === layer) topo.layers[layer].fill(0);
        }
        syncAttribute(mesh);
      }
      // The history described a painting that no longer exists.
      undoStack.length = 0;
      redoStack.length = 0;
      refreshUniforms();
      changed();
    },

    /** What is on the model, for the panel to say out loud. */
    stats() {
      let density = 0;
      let freeze = 0;
      let region = 0;
      let meshes = 0;
      for (const mesh of painted) {
        const topo = CACHE.get(mesh.geometry);
        if (!topo) continue;
        let touched = false;
        for (let i = 0; i < topo.count; i++) {
          if (Math.abs(topo.layers.density[i]) > 1e-3) {
            density++;
            touched = true;
          }
          if (topo.layers.freeze[i] > 0.5) {
            freeze++;
            touched = true;
          }
          if (topo.layers.region[i] > 0.5) {
            region++;
            touched = true;
          }
        }
        if (touched) meshes++;
      }
      return {
        density,
        freeze,
        region,
        meshes,
        guides: guides.length,
        creases: guides.filter((g) => g.kind === "crease").length,
        flows: guides.filter((g) => g.kind === "flow").length,
      };
    },

    /** Is there anything at all for the engine to read? */
    get empty() {
      const s = api.stats();
      return !s.density && !s.freeze && !s.region && !s.guides;
    },

    /** Every mesh that carries something, so the run knows which to hand over. */
    meshesWithPaint() {
      const out = new Set();
      for (const mesh of painted) {
        const topo = CACHE.get(mesh.geometry);
        if (!topo) continue;
        for (let i = 0; i < topo.count; i++) {
          if (
            Math.abs(topo.layers.density[i]) > 1e-3 ||
            topo.layers.freeze[i] > 0.5 ||
            topo.layers.region[i] > 0.5
          ) {
            out.add(mesh);
            break;
          }
        }
      }
      for (const g of guides) out.add(g.mesh);
      return out;
    },

    sidecarFor,
    regionShare,

    /**
     * Park this document's painting, and pick another one up.
     *
     * A painting belongs to a model, not to the mode, exactly like the run
     * history beside it: carrying it across a tab switch would offer a frozen
     * region on a model that has no such region, drawn on meshes that are not in
     * the scene any more.
     *
     * Only the bookkeeping travels. The values themselves live on the geometry,
     * through the cache at the top of this file, so a parked document that still
     * holds its objects still holds its paint — and one whose objects have been
     * released takes its paint with them, which is the right answer and costs
     * nothing to arrange.
     */
    snapshot() {
      return {
        painted: new Set(painted),
        guides: guides.slice(),
        undo: undoStack.slice(),
        redo: redoStack.slice(),
      };
    },
    restore(state) {
      for (const g of guides) if (g.object) g.object.visible = false;
      painted.clear();
      guides.length = 0;
      undoStack.length = 0;
      redoStack.length = 0;
      for (const m of state?.painted || []) painted.add(m);
      for (const g of state?.guides || []) {
        guides.push(g);
        if (g.object) g.object.visible = true;
      }
      undoStack.push(...(state?.undo || []));
      redoStack.push(...(state?.redo || []));
      refreshUniforms();
      changed();
    },

    /** Hide the guide tubes while something walks the scene. */
    withGuidesHidden(fn) {
      const hidden = [];
      for (const g of guides) {
        if (g.object?.visible) {
          g.object.visible = false;
          hidden.push(g.object);
        }
      }
      try {
        return fn();
      } finally {
        for (const o of hidden) o.visible = true;
      }
    },

    set onChange(cb) {
      onChange = cb;
    },

    dispose() {
      canvas.removeEventListener("pointerdown", onPointerDown, opts);
      canvas.removeEventListener("pointermove", onPointerMove, opts);
      canvas.removeEventListener("pointerup", onPointerUp, opts);
      canvas.removeEventListener("pointercancel", onPointerUp, opts);
      canvas.removeEventListener("pointerleave", onPointerLeave, opts);
      canvas.removeEventListener("wheel", onWheel, opts);
      cursor.geometry.dispose();
      cursor.material.dispose();
      cursor.parent?.remove(cursor);
      api.clear("all");
      canvas.style.cursor = "";
      canvas.style.touchAction = "";
      if (viewer.controls) viewer.controls.enabled = true;
    },
  };

  return api;
}
