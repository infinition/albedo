import * as THREE from "three";
import * as texturePaint from "./texture.js";

/**
 * Painting on the model, so the retopology can be told where to care.
 *
 * The rest of this mode asks one question, how many triangles, and applies the
 * answer everywhere. That is the right shape for a first pass and the wrong
 * shape for the work that follows it. The face needs its detail and the back of
 * the skull does not. The bolt heads have to survive and the plate they sit on
 * can lose ninety percent. That fold across the shoulder is a real edge and no
 * cost function is going to guess it. Every one of those is knowledge the person
 * looking at the screen already has, and there was nowhere to put it.
 *
 * So: four brushes and a pen.
 *
 * - **Densité** where triangles are worth spending, from −1 to +1. Neutral
 *   everywhere by default, which is the identity: an unpainted model decimates
 *   exactly as it always did.
 * - **Geler** never touch this. Hard, not a preference.
 * - **Zone** the only part of the model this run may modify at all. Paint the
 *   face, run, and the hands come back untouched, vertex for vertex.
 * - **Guides** curves drawn along the surface. A *pli* is a promise that the
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
 * that is no longer there, silently, with every index off by however much the
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
  const px = position.array;
  const stride = position.itemSize;

  /*
   * Welding by a hashed integer key, not by a string one.
   *
   * `\`${qx},${qy},${qz}\`` is the obvious way to write this and it builds a
   * string per vertex, hashes it, and leaves it for the collector: on a million
   * vertex mesh that is a million short-lived strings before a single stroke has
   * been drawn, and the pause before the brush answers is what people feel. The
   * quantised coordinates are integers, so they can be mixed into one number and
   * the buckets compared exactly, the hash only has to find the candidates, the
   * comparison decides.
   */
  const buckets = new Map();
  const qx = new Int32Array(renderCount);
  const qy = new Int32Array(renderCount);
  const qz = new Int32Array(renderCount);
  const wx = [];
  const wy = [];
  const wz = [];
  for (let i = 0; i < renderCount; i++) {
    const x = px[i * stride];
    const y = px[i * stride + 1];
    const z = px[i * stride + 2];
    const a = Math.round(x / eps);
    const b = Math.round(y / eps);
    const c = Math.round(z / eps);
    // Three odd multipliers, the ones every spatial hash uses: they scatter
    // neighbouring cells into different buckets, which is exactly the case a
    // mesh presents.
    const key = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    let bucket = buckets.get(key);
    let w = -1;
    if (bucket === undefined) {
      buckets.set(key, (bucket = []));
    } else {
      for (const candidate of bucket) {
        if (qx[candidate] === a && qy[candidate] === b && qz[candidate] === c) {
          w = weldOf[candidate];
          break;
        }
      }
    }
    if (w < 0) {
      w = wx.length;
      wx.push(x);
      wy.push(y);
      wz.push(z);
    }
    bucket.push(i);
    qx[i] = a;
    qy[i] = b;
    qz[i] = c;
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
    /** Built on the first pick rather than here: see `buildBvh`. */
    bvh: null,
    /** The pose the hierarchy was built over; see `bvhOf`. */
    bvhPose: -1,
    /** A welded point back to the render vertices that share it, as CSR. */
    renderStart: null,
    renderList: null,
    /** A welded point to the triangles that touch it, as CSR. */
    triStart: null,
    triList: null,
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

/**
 * A bounding volume hierarchy over one geometry's triangles.
 *
 * **This exists because three's own raycast is linear, and a brush asks the
 * question forty times a second.** Measured here, on a thirty one thousand
 * triangle model, a small one, `Raycaster.intersectObject` cost eighteen
 * milliseconds a call. The brush asks it for every pointer move, for every
 * coalesced sample behind that move, and again for each step of the fill-in
 * between two samples, so one flick of the pen asked it a hundred times: the
 * paint arrived a second after the hand. The stamp itself, the geodesic walk
 * and the attribute write, measured about one millisecond, so everything else
 * was already fast enough and none of it was the problem.
 *
 * Median split over centroids, eight triangles a leaf, flat typed arrays. Not
 * the surface area heuristic: this build happens while somebody is waiting to
 * paint, and what SAH buys a query is worth much less here than what it costs
 * the pause before the first stroke.
 */
const LEAF_SIZE = 8;

function buildBvh(topo, geometry, posed = null) {
  const attribute = geometry.attributes.position;
  // `posed` is the deformed copy a skinned mesh hands in: same layout, three
  // floats a vertex, so everything below is indifferent to where it came from.
  const position = posed || attribute.array;
  const stride = posed ? 3 : attribute.itemSize;
  const index = geometry.index;
  const triCount = topo.triCount;

  // Render-vertex ids per triangle, beside the welded ones the rest of this
  // file uses: a hit has to name the corners the *geometry* holds, because that
  // is what the caller reads a normal and a position out of.
  const corners = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      corners[t * 3 + k] = index ? index.getX(t * 3 + k) : t * 3 + k;
    }
  }

  const centroid = new Float32Array(triCount * 3);
  const bounds = new Float32Array(triCount * 6);
  for (let t = 0; t < triCount; t++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const o = corners[t * 3 + k] * stride;
      const x = position[o];
      const y = position[o + 1];
      const z = position[o + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    bounds[t * 6] = minX;
    bounds[t * 6 + 1] = minY;
    bounds[t * 6 + 2] = minZ;
    bounds[t * 6 + 3] = maxX;
    bounds[t * 6 + 4] = maxY;
    bounds[t * 6 + 5] = maxZ;
    centroid[t * 3] = (minX + maxX) * 0.5;
    centroid[t * 3 + 1] = (minY + maxY) * 0.5;
    centroid[t * 3 + 2] = (minZ + maxZ) * 0.5;
  }

  const order = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) order[t] = t;

  // A binary tree over N leaves of eight holds fewer than 2N/8 nodes. The slack
  // is so a degenerate split cannot run off the end of the arrays.
  const maxNodes = Math.max(4, 4 * Math.ceil(triCount / LEAF_SIZE) + 4);
  const nodeBounds = new Float32Array(maxNodes * 6);
  const nodeLeft = new Int32Array(maxNodes).fill(-1);
  const nodeStart = new Uint32Array(maxNodes);
  const nodeCount = new Uint32Array(maxNodes);
  let used = 1;

  const stack = [[0, 0, triCount]];
  while (stack.length) {
    const [node, from, to] = stack.pop();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = from; i < to; i++) {
      const t = order[i] * 6;
      if (bounds[t] < minX) minX = bounds[t];
      if (bounds[t + 1] < minY) minY = bounds[t + 1];
      if (bounds[t + 2] < minZ) minZ = bounds[t + 2];
      if (bounds[t + 3] > maxX) maxX = bounds[t + 3];
      if (bounds[t + 4] > maxY) maxY = bounds[t + 4];
      if (bounds[t + 5] > maxZ) maxZ = bounds[t + 5];
    }
    const b = node * 6;
    nodeBounds[b] = minX;
    nodeBounds[b + 1] = minY;
    nodeBounds[b + 2] = minZ;
    nodeBounds[b + 3] = maxX;
    nodeBounds[b + 4] = maxY;
    nodeBounds[b + 5] = maxZ;

    const n = to - from;
    if (n <= LEAF_SIZE || used + 2 > maxNodes) {
      nodeStart[node] = from;
      nodeCount[node] = n;
      continue;
    }

    /*
     * Longest axis, split at the middle of the box, partitioned in place.
     *
     * This was a sort per node, `Array.from(subarray).sort(comparator)`, which
     * is a fresh JavaScript array and a comparator call per pair at every level
     * of the tree. It is also more than the question needs: a split does not
     * care about the order within each half, only which half each triangle is
     * in, and that is one linear pass.
     *
     * The spatial midpoint rather than the median count, because it is what
     * makes the boxes tight; when it degenerates, every centroid on one side,
     * which a flat cap or a lathe of coplanar triangles really does produce,
     * the halfway index is the fallback, and the tree stays balanced instead of
     * turning into a list.
     */
    const ex = maxX - minX;
    const ey = maxY - minY;
    const ez = maxZ - minZ;
    const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2;
    const at = axis === 0 ? (minX + maxX) * 0.5 : axis === 1 ? (minY + maxY) * 0.5 : (minZ + maxZ) * 0.5;
    let lo = from;
    let hi = to - 1;
    while (lo <= hi) {
      if (centroid[order[lo] * 3 + axis] < at) {
        lo++;
      } else {
        const swap = order[lo];
        order[lo] = order[hi];
        order[hi] = swap;
        hi--;
      }
    }
    const mid = lo === from || lo === to ? from + (n >> 1) : lo;

    const left = used++;
    const right = used++;
    nodeLeft[node] = left;
    nodeCount[node] = 0;
    stack.push([left, from, mid], [right, mid, to]);
  }

  return { order, corners, nodeBounds, nodeLeft, nodeStart, nodeCount, position, stride };
}

/**
 * Where a skinned mesh's vertices actually are.
 *
 * A `SkinnedMesh` keeps its bind pose in the buffer and lets the GPU move it, so
 * a hierarchy built over `position` describes a shape that is not on screen. The
 * brush would then land somewhere the surface used to be, worse than slow,
 * because it looks like it worked.
 *
 * This was the whole of the performance complaint, and it was hiding: skinned
 * meshes were sent down `Raycaster.intersectObject` instead, which is the linear
 * path the hierarchy exists to avoid. A test model that happened to be rigged
 * therefore got none of the speed-up and the brush stayed at twenty two
 * milliseconds a move.
 *
 * The pose is a key rather than a subscription: rebuilt when the animation has
 * moved since the last look, and on a model that is not playing, which is every
 * model anyone paints on, computed exactly once.
 */
function poseKey(mesh, viewer) {
  if (!mesh.isSkinnedMesh) return 0;
  return viewer?.mixer ? viewer.mixer.time : 0;
}

function skinnedPositions(mesh) {
  const attribute = mesh.geometry.attributes.position;
  const n = attribute.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  mesh.skeleton?.update?.();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(attribute, i);
    // `applyBoneTransform` is three's own skinning, so what this indexes is what
    // the shader draws rather than a second implementation that can drift.
    mesh.applyBoneTransform(i, v);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

function bvhOf(topo, mesh, viewer) {
  const key = poseKey(mesh, viewer);
  if (topo.bvh && topo.bvhPose === key) return topo.bvh;
  const posed = mesh.isSkinnedMesh ? skinnedPositions(mesh) : null;
  topo.bvh = buildBvh(topo, mesh.geometry, posed);
  topo.bvhPose = key;
  return topo.bvh;
}

/** Scratch for the traversal, so a pick allocates nothing. */
const BVH_STACK = new Int32Array(64);

/**
 * The nearest triangle a ray meets, in the geometry's own space.
 *
 * Möller–Trumbore, culling nothing: a model being retopologised is as likely to
 * be an open shell seen from behind as a closed one, and a brush that refuses to
 * paint a back face is a brush that stops working halfway round.
 *
 * @returns {{t:number, tri:number, u:number, v:number}|null}
 */
function bvhRaycast(bvh, ox, oy, oz, dx, dy, dz) {
  const { order, corners, nodeBounds, nodeLeft, nodeStart, nodeCount, position, stride } = bvh;
  const ix = 1 / dx;
  const iy = 1 / dy;
  const iz = 1 / dz;
  let best = Infinity;
  let bestTri = -1;
  let bestU = 0;
  let bestV = 0;

  let top = 0;
  BVH_STACK[top++] = 0;
  while (top > 0) {
    const node = BVH_STACK[--top];
    const b = node * 6;
    /*
     * Slab test. The min/max dance handles a negative direction component
     * without branching on its sign, and a NaN out of a zero component falls
     * through as a miss rather than as a hit, which is the safe way to fail.
     */
    const t1 = (nodeBounds[b] - ox) * ix;
    const t2 = (nodeBounds[b + 3] - ox) * ix;
    const t3 = (nodeBounds[b + 1] - oy) * iy;
    const t4 = (nodeBounds[b + 4] - oy) * iy;
    const t5 = (nodeBounds[b + 2] - oz) * iz;
    const t6 = (nodeBounds[b + 5] - oz) * iz;
    const near = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
    const far = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
    if (!(far >= 0 && near <= far && near < best)) continue;

    const left = nodeLeft[node];
    if (left >= 0) {
      // The stack is fixed: a tree deeper than this cannot happen from a median
      // split, and dropping a node would silently lose part of the model.
      if (top + 2 <= BVH_STACK.length) {
        BVH_STACK[top++] = left;
        BVH_STACK[top++] = left + 1;
      }
      continue;
    }

    const from = nodeStart[node];
    const to = from + nodeCount[node];
    for (let i = from; i < to; i++) {
      const tri = order[i];
      const a = corners[tri * 3] * stride;
      const bi = corners[tri * 3 + 1] * stride;
      const c = corners[tri * 3 + 2] * stride;
      const ax = position[a];
      const ay = position[a + 1];
      const az = position[a + 2];
      const e1x = position[bi] - ax;
      const e1y = position[bi + 1] - ay;
      const e1z = position[bi + 2] - az;
      const e2x = position[c] - ax;
      const e2y = position[c + 1] - ay;
      const e2z = position[c + 2] - az;
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax;
      const ty = oy - ay;
      const tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-6 && t < best) {
        best = t;
        bestTri = tri;
        bestU = u;
        bestV = v;
      }
    }
  }
  return bestTri < 0 ? null : { t: best, tri: bestTri, u: bestU, v: bestV };
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

  /**
   * Mirror every stroke across the model's own middle.
   *
   * Off by default, because it is wrong on anything that is not symmetric and
   * silently doubles work when it is on by surprise.
   */
  const symmetry = { on: false, axis: "x" };

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
  /** Said by the host, which owns the words: no source yet, or no texture. */
  let onNeedSource = null;
  let onNeedTexture = null;
  const changed = () => {
    viewer.invalidate?.();
    onChange?.();
  };

  // ---------------------------------------------------------------------------
  // The paint, on the surface
  // ---------------------------------------------------------------------------

  /**
   * A welded point back to the render vertices that carry it.
   *
   * The reverse of `weldOf`, as CSR, built once. Without it the only way to push
   * a changed value into the shader attribute is to walk the whole vertex buffer
   * looking for the ones that mention it, which is what `syncAttribute` used to
   * do on every single dab.
   */
  function renderMapOf(topo) {
    if (topo.renderStart) return topo;
    const degree = new Uint32Array(topo.count + 1);
    for (let r = 0; r < topo.renderCount; r++) degree[topo.weldOf[r]]++;
    const start = new Uint32Array(topo.count + 1);
    let running = 0;
    for (let i = 0; i < topo.count; i++) {
      start[i] = running;
      running += degree[i];
    }
    start[topo.count] = running;
    const list = new Uint32Array(running);
    const fill = start.slice(0, topo.count);
    for (let r = 0; r < topo.renderCount; r++) list[fill[topo.weldOf[r]]++] = r;
    topo.renderStart = start;
    topo.renderList = list;
    return topo;
  }

  function attributeOf(mesh, topo) {
    let attr = mesh.geometry.attributes.aPaint;
    if (!attr || attr.count !== topo.renderCount) {
      attr = new THREE.BufferAttribute(new Float32Array(topo.renderCount * 3), 3);
      mesh.geometry.setAttribute("aPaint", attr);
      topo.attribute = attr;
    }
    return attr;
  }

  /**
   * Welded points whose value has moved since the last frame, per mesh.
   *
   * Painting used to rewrite the whole vertex buffer after every dab, three
   * floats per render vertex, then a full upload to the GPU, and a stroke is
   * hundreds of dabs. Now a dab only records which points it touched, and one
   * pass a frame writes those and nothing else.
   */
  const dirty = new Map();
  let flushQueued = false;

  function touch(mesh, welded) {
    let set = dirty.get(mesh);
    if (!set) dirty.set(mesh, (set = new Set()));
    set.add(welded);
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flushPaint);
  }

  /** Push everything painted since the last frame into the shader attribute. */
  function flushPaint() {
    flushQueued = false;
    if (!dirty.size) return;
    for (const [mesh, points] of dirty) {
      const topo = CACHE.get(mesh.geometry);
      if (!topo) continue;
      renderMapOf(topo);
      const attr = attributeOf(mesh, topo);
      const a = attr.array;
      const { density, freeze, region } = topo.layers;
      for (const w of points) {
        for (let i = topo.renderStart[w]; i < topo.renderStart[w + 1]; i++) {
          const r = topo.renderList[i];
          a[r * 3] = density[w];
          a[r * 3 + 1] = freeze[w];
          a[r * 3 + 2] = region[w];
        }
      }
      attr.needsUpdate = true;
    }
    dirty.clear();
    viewer.invalidate?.();
  }

  /**
   * Rewrite one mesh's whole attribute.
   *
   * Only for the wholesale changes, an undo, a wipe, a document coming back,
   * where "which points moved" is "all of them" and tracking them individually
   * would cost more than the pass it saves.
   */
  function syncAttribute(mesh) {
    const topo = topologyOf(mesh.geometry);
    const attr = attributeOf(mesh, topo);
    const { density, freeze, region } = topo.layers;
    const a = attr.array;
    for (let r = 0; r < topo.renderCount; r++) {
      const w = topo.weldOf[r];
      a[r * 3] = density[w];
      a[r * 3 + 1] = freeze[w];
      a[r * 3 + 2] = region[w];
    }
    attr.needsUpdate = true;
    dirty.delete(mesh);
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
    const on = attached && showPaint;
    wireUniforms.uPaint.value = on ? 1 : 0;
    wireUniforms.uPaintRegion.value = on && anyRegion() ? 1 : 0;
  }

  let showPaint = true;

  /**
   * Whether the mode this painting belongs to is on screen.
   *
   * **The overlay outlives the chrome that controls it, so it has to be lifted
   * by hand.** `uPaint` is a uniform on materials, and the materials stay on the
   * meshes when the bar goes away: closing the mode left the model tinted amber
   * and violet with no brush, no eye button and nothing at all on screen to say
   * why, or how to stop it. The only way back was to reopen a mode you had just
   * decided to leave.
   *
   * This is the same trap `uSide` fell into with the comparison curtain, and it
   * has the same shape: state that belongs to *looking at* the model, held on
   * the model rather than on the surface that offers it.
   *
   * The painting itself is untouched, it is work, and closing a panel is not a
   * reason to throw work away. It comes back, drawn, when the mode does.
   */
  let attached = true;

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
    cloneOffset = null;
    cloneTouched.clear();
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

    // The brush is a size on the model, and the model has a scale. The walk
    // below runs in the geometry's own units, so a mesh scaled to a tenth must
    // not get a brush ten times too big, which is what happens whenever a model
    // arrives in centimetres and the importer normalises it.
    mesh.getWorldScale(_scale);
    const unit = Math.max(1e-6, (_scale.x + _scale.y + _scale.z) / 3);
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
      touch(mesh, v);

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
  }

  /**
   * A welded point back to the triangles that touch it.
   *
   * Built like the render map beside it, and for the same reason: the clone
   * brush knows which *points* are under it, and has to rasterise the triangles
   * those points belong to.
   */
  function triMapOf(topo) {
    if (topo.triStart) return topo;
    const degree = new Uint32Array(topo.count + 1);
    for (let t = 0; t < topo.triCount; t++) {
      for (let k = 0; k < 3; k++) degree[topo.tri[t * 3 + k]]++;
    }
    const start = new Uint32Array(topo.count + 1);
    let running = 0;
    for (let i = 0; i < topo.count; i++) {
      start[i] = running;
      running += degree[i];
    }
    start[topo.count] = running;
    const list = new Uint32Array(running);
    const fill = start.slice(0, topo.count);
    for (let t = 0; t < topo.triCount; t++) {
      for (let k = 0; k < 3; k++) list[fill[topo.tri[t * 3 + k]]++] = t;
    }
    topo.triStart = start;
    topo.triList = list;
    return topo;
  }

  /** Where the clone reads from: a point on the surface, and its coordinates. */
  let cloneSource = null;
  /** Set on the first dab of a stroke: how far, in texture space, to reach. */
  let cloneOffset = null;
  /** The marker showing where the source sits. */
  const sourceMark = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, toneMapped: false, depthTest: false })
  );
  sourceMark.visible = false;
  sourceMark.renderOrder = 1000;
  sourceMark.raycast = () => {};
  sourceMark.name = "clone-source";
  viewer.scene.add(sourceMark);

  /** Where the clone reads from, and the little sphere that says so. */
  function setCloneSource(hit) {
    const uv = uvAt(hit);
    if (!uv) {
      onNeedTexture?.();
      return;
    }
    cloneSource = { mesh: hit.object, uv, point: hit.point.clone() };
    cloneOffset = null;
    sourceMark.position.copy(hit.point);
    sourceMark.scale.setScalar(Math.max(1e-4, brushRadius(hit.object) * 0.12));
    sourceMark.visible = true;
    changed();
  }

  /** The one material the clone may write into, for a given hit. */
  function albedoMaterialOf(mesh) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    return m?.map ? m : null;
  }

  /** Texture coordinate under a hit, interpolated across the triangle. */
  function uvAt(hit) {
    const uv = hit.object.geometry.attributes.uv;
    if (!uv) return null;
    const { a, b, c } = hit.face;
    const { u, v } = hit.bary;
    const w = 1 - u - v;
    return [
      uv.getX(a) * w + uv.getX(b) * u + uv.getX(c) * v,
      uv.getY(a) * w + uv.getY(b) * u + uv.getY(c) * v,
    ];
  }

  /**
   * Put down one dab of cloned texture.
   *
   * The footprint is found on the *surface* and then rasterised into the
   * texture, never the other way round. A round brush in texture space is not a
   * round brush on the model, the atlas stretches, and the same disc covers a
   * thumbnail of surface on a dense island and a hand's width on a sparse one.
   * Walking the mesh first and rasterising second is what makes the mark the
   * size it looks.
   */
  function cloneStamp(hit, pressure) {
    if (!cloneSource) return;
    const mesh = hit.object;
    const material = albedoMaterialOf(mesh);
    if (!material) return;
    const state = texturePaint.editable(material);
    if (!state || !state.baseline) return;

    const uvAttr = mesh.geometry.attributes.uv;
    if (!uvAttr) return;
    const here = uvAt(hit);
    if (!here) return;
    if (!cloneOffset) {
      // Measured once per stroke, from where the pen went down: a stroke starts
      // copying at the source and carries that displacement along with it, which
      // is what makes covering a blemish predictable.
      cloneOffset = [cloneSource.uv[0] - here[0], cloneSource.uv[1] - here[1]];
    }

    const topo = triMapOf(topologyOf(mesh.geometry));
    /*
     * The hierarchy is asked for the triangles' corners and positions, and both
     * matter for a reason the other brushes never meet.
     *
     * **Corners**, because a welded point is several render vertices wherever a
     * seam runs through it, and they do not share a texture coordinate, that
     * disagreement *is* the seam. Taking any one of them gives a triangle whose
     * coordinates come from both sides of the cut, which in texture space is not
     * a triangle at all, and the dab lands nowhere.
     *
     * **Positions**, because on a skinned mesh the buffer holds the bind pose
     * while the pen is touching the posed surface. Measuring the brush falloff
     * from one against the other puts every texel further away than it is, and
     * the whole footprint falls outside the radius.
     */
    const bvh = bvhOf(topo, mesh, viewer);
    mesh.getWorldScale(_scale);
    const unit = Math.max(1e-6, (_scale.x + _scale.y + _scale.z) / 3);
    const size = brush.size * (brush.pressureSize ? 0.35 + 0.65 * pressure : 1);
    const radius = Math.max(topo.edge * 1.5, topo.radius * size);
    const flow = brush.strength * (brush.pressureStrength ? 0.15 + 0.85 * pressure : 1);

    const centre = mesh.worldToLocal(hit.point.clone());
    const seeds = [topo.weldOf[hit.face.a], topo.weldOf[hit.face.b], topo.weldOf[hit.face.c]];
    const reached = walkSurface(topo, seeds, radius);
    if (!reached.length) return;

    // Every triangle touching a point the brush reached, once.
    const faces = new Set();
    for (const [v] of reached) {
      for (let i = topo.triStart[v]; i < topo.triStart[v + 1]; i++) faces.add(topo.triList[i]);
    }

    const { width: tw, height: th, flipY } = { ...state, flipY: state.texture.flipY };
    const toY = (v) => (flipY ? 1 - v : v) * th;

    // The rectangle of texels this dab can possibly touch, so the canvas is read
    // and written once over a brush-sized patch rather than a map-sized one.
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    const corners = [];
    for (const t of faces) {
      const r = [bvh.corners[t * 3], bvh.corners[t * 3 + 1], bvh.corners[t * 3 + 2]];
      const uv = r.map((i) => [uvAttr.getX(i), uvAttr.getY(i)]);
      corners.push({ r, uv });
      for (const [u, v] of uv) {
        lo[0] = Math.min(lo[0], u * tw);
        lo[1] = Math.min(lo[1], toY(v));
        hi[0] = Math.max(hi[0], u * tw);
        hi[1] = Math.max(hi[1], toY(v));
      }
    }
    const x0 = Math.max(0, Math.floor(lo[0]) - 1);
    const y0 = Math.max(0, Math.floor(lo[1]) - 1);
    const x1 = Math.min(tw, Math.ceil(hi[0]) + 1);
    const y1 = Math.min(th, Math.ceil(hi[1]) + 1);
    if (x1 <= x0 || y1 <= y0) return;

    const patch = state.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const out = patch.data;
    const src = [0, 0, 0, 0];
    const pos = bvh.position;
    const st = bvh.stride;
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    const pc = new THREE.Vector3();
    const at = new THREE.Vector3();
    let painted = 0;

    for (const { r, uv } of corners) {
      const [ua, ub, uc] = uv;
      const den = (ub[1] - uc[1]) * (ua[0] - uc[0]) + (uc[0] - ub[0]) * (ua[1] - uc[1]);
      if (Math.abs(den) < 1e-12) continue;
      pa.set(pos[r[0] * st], pos[r[0] * st + 1], pos[r[0] * st + 2]);
      pb.set(pos[r[1] * st], pos[r[1] * st + 1], pos[r[1] * st + 2]);
      pc.set(pos[r[2] * st], pos[r[2] * st + 1], pos[r[2] * st + 2]);

      const bx0 = Math.max(x0, Math.floor(Math.min(ua[0], ub[0], uc[0]) * tw) - 1);
      const bx1 = Math.min(x1, Math.ceil(Math.max(ua[0], ub[0], uc[0]) * tw) + 1);
      const by0 = Math.max(y0, Math.floor(Math.min(toY(ua[1]), toY(ub[1]), toY(uc[1]))) - 1);
      const by1 = Math.min(y1, Math.ceil(Math.max(toY(ua[1]), toY(ub[1]), toY(uc[1]))) + 1);

      for (let y = by0; y < by1; y++) {
        for (let x = bx0; x < bx1; x++) {
          const u = (x + 0.5) / tw;
          const vRow = (y + 0.5) / th;
          const v = flipY ? 1 - vRow : vRow;
          // Barycentric in texture space: which part of this triangle is here.
          const l0 = ((ub[1] - uc[1]) * (u - uc[0]) + (uc[0] - ub[0]) * (v - uc[1])) / den;
          const l1 = ((uc[1] - ua[1]) * (u - uc[0]) + (ua[0] - uc[0]) * (v - uc[1])) / den;
          const l2 = 1 - l0 - l1;
          if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;

          // The same weights on the positions: where this texel is on the model.
          at.set(
            pa.x * l0 + pb.x * l1 + pc.x * l2,
            pa.y * l0 + pb.y * l1 + pc.y * l2,
            pa.z * l0 + pb.z * l1 + pc.z * l2
          );
          const w = falloffAt(at.distanceTo(centre) / radius, brush.hardness) * flow;
          if (w <= 0.002) continue;

          /*
           * Read from the picture as it stood before the stroke.
           *
           * Sampling the live canvas is how a clone brush eats its own tail: a
           * stroke that crosses its own source copies what it has just painted,
           * and the pattern smears into a streak within one gesture.
           */
          texturePaint.sample(state.baseline, u + cloneOffset[0], v + cloneOffset[1], flipY, src);
          const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
          for (let k = 0; k < 4; k++) {
            out[o + k] = Math.round(out[o + k] + (src[k] - out[o + k]) * w);
          }
          painted++;
        }
      }
    }

    if (!painted) return;
    state.ctx.putImageData(patch, x0, y0);
    state.texture.needsUpdate = true;
    cloneTouched.add(material);
    cloneEdited.add(material);
    viewer.invalidate?.();
  }

  /** Materials this stroke has written into, so one undo puts them all back. */
  const cloneTouched = new Set();
  /** Every material the clone has ever written into, for the wipe. */
  const cloneEdited = new Set();

  function endStroke() {
    /*
     * The last dabs reach the shader here, rather than waiting for a frame.
     *
     * Painting batches its attribute writes into one pass per animation frame,
     * which is what makes a stroke cheap. A frame that never comes, a window
     * put behind another one, a tab in the background, would then leave the end
     * of a stroke painted in the data and missing from the picture.
     */
    flushPaint();

    /*
     * A clone stroke is undone as pixels, not as values.
     *
     * The other brushes record numbers on welded points and can put back exactly
     * what they replaced. This one has written into an image, and the honest way
     * back is the image as it stood when the pen went down, which is already in
     * hand, because the clone had to read from it anyway to avoid sampling its
     * own output.
     */
    if (cloneTouched.size) {
      const shots = [];
      for (const material of cloneTouched) {
        const state = material.userData.albedoPaint;
        if (!state) continue;
        shots.push({ material, before: texturePaint.endStroke(state), after: texturePaint.snapshot(state) });
      }
      cloneTouched.clear();
      if (shots.length) {
        undoStack.push({ pixels: shots });
        redoStack.length = 0;
        changed();
      }
    }

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
  /** The same curve on the far side of the mirror, drawn at the same time. */
  let liveTwin = null;

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
    clone: 0x7cc4ff,
  };

  /** Scratch for picking, so a pointer move at pen rate allocates nothing. */
  const _ndc = new THREE.Vector2();
  const _inv = new THREE.Matrix4();
  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _ab = new THREE.Vector3();
  const _ac = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _va = new THREE.Vector3();
  const _vb = new THREE.Vector3();
  const _vc = new THREE.Vector3();

  /**
   * Is this something the brush may land on?
   *
   * Hidden meshes and anything hidden above them are out, and so are this
   * module's own guide tubes: they are drawn on the model, so without this the
   * first stroke along a guide would paint the guide.
   */
  function paintable(o) {
    if (!o.visible || (!o.isMesh && !o.isSkinnedMesh)) return false;
    if (o.userData.albedoGuide || !o.geometry?.attributes?.position) return false;
    let up = o.parent;
    while (up) {
      if (!up.visible) return false;
      up = up.parent;
    }
    return true;
  }

  /**
   * What the pointer is over, restricted to what the mode may paint on.
   *
   * Through this module's own hierarchy rather than `Raycaster.intersectObject`,
   * which walks every triangle of every mesh: see `buildBvh` for the measurement
   * that made this necessary. Skinned meshes go through it too, over their posed
   * vertices, see `bvhOf`.
   */
  function pickSurface(e) {
    const r = canvas.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    ray.setFromCamera(_ndc, viewer.camera);
    return pickRay(ray.ray.origin, ray.ray.direction);
  }

  /**
   * The same pick, from a ray somebody else built.
   *
   * Split out for symmetry, which is a *ray* mirrored rather than a hit
   * mirrored. Reflecting the point the pen landed on and looking for the nearest
   * surface there sounds equivalent and is not: on anything thin, a fin, an
   * ear, the far wall of a cylinder, the nearest surface to the mirrored point
   * is as often the wrong side as the right one, and the paint lands inside the
   * model. Mirroring the ray asks the same question from the other side, and
   * gets the same kind of answer.
   */
  function pickRay(origin, direction) {
    let best = null;
    let bestDistance = Infinity;

    viewer.root.traverse((o) => {
      if (!paintable(o)) return;
      const topo = topologyOf(o.geometry);
      const bvh = bvhOf(topo, o, viewer);

      // The ray goes into the mesh's space rather than the mesh's triangles
      // coming out into the world: one matrix against a hundred thousand.
      _inv.copy(o.matrixWorld).invert();
      _o.copy(origin).applyMatrix4(_inv);
      _d.copy(direction).transformDirection(_inv);

      const hit = bvhRaycast(bvh, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z);
      if (!hit) return;

      _p.copy(_d).multiplyScalar(hit.t).add(_o).applyMatrix4(o.matrixWorld);
      // Compared in world units, because `hit.t` is in each mesh's own scale and
      // two meshes at different scales cannot be ranked by it.
      const distance = origin.distanceTo(_p);
      if (distance >= bestDistance) return;

      const a = bvh.corners[hit.tri * 3];
      const b = bvh.corners[hit.tri * 3 + 1];
      const c = bvh.corners[hit.tri * 3 + 2];
      // Out of the hierarchy's own positions, not the geometry's: on a skinned
      // mesh those are the posed ones, and a normal taken from the bind pose
      // would tilt the brush ring off the surface it is drawn on.
      const pos = bvh.position;
      const st = bvh.stride;
      _va.set(pos[a * st], pos[a * st + 1], pos[a * st + 2]);
      _vb.set(pos[b * st], pos[b * st + 1], pos[b * st + 2]);
      _vc.set(pos[c * st], pos[c * st + 1], pos[c * st + 2]);
      _ab.subVectors(_vb, _va);
      _ac.subVectors(_vc, _va);
      _n.crossVectors(_ab, _ac).normalize();

      bestDistance = distance;
      best = {
        object: o,
        distance,
        point: _p.clone(),
        face: { a, b, c, normal: _n.clone() },
        // Möller–Trumbore hands these back for free, and the clone brush needs
        // them: a texture coordinate at the point the pen is over is the whole
        // question it asks. `u` weights the second corner and `v` the third.
        bary: { u: hit.u, v: hit.v },
      };
    });

    return best;
  }

  const _scale = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 0, 1);

  /** The brush's radius on this mesh, in world units. */
  function brushRadius(object, pressure = 1) {
    const topo = topologyOf(object.geometry);
    object.getWorldScale(_scale);
    const unit = (_scale.x + _scale.y + _scale.z) / 3 || 1;
    const size = brush.size * (brush.pressureSize && drawing ? 0.35 + 0.65 * pressure : 1);
    return Math.max(topo.edge * 1.5, topo.radius * size) * unit;
  }

  const _mo = new THREE.Vector3();
  const _md = new THREE.Vector3();
  const _box = new THREE.Box3();
  const _centre = new THREE.Vector3();
  const _rootInv = new THREE.Matrix4();

  /**
   * The same ray, seen from the other side of the model.
   *
   * **In the model's own space, not the world's.** The orientation buttons turn
   * `viewer.root`, and a mirror across a world axis would therefore swing away
   * from the model's own symmetry the moment anybody turned it a quarter turn,
   * the plane has to belong to the thing being painted, not to the room.
   *
   * The plane passes through the middle of the model rather than through the
   * origin. Plenty of assets are authored centred and plenty are not, and one
   * exported with its feet at the origin would otherwise mirror to somewhere off
   * in space, which reads as symmetry simply not working.
   *
   * @returns {[THREE.Vector3, THREE.Vector3]|null} origin and direction, or null
   *   when there is nothing to mirror about
   */
  function mirrorRay(origin, direction) {
    if (!symmetry.on) return null;
    const root = viewer.root;
    root.updateMatrixWorld();
    _box.setFromObject(root);
    if (_box.isEmpty()) return null;
    _box.getCenter(_centre);

    const axis = symmetry.axis;
    _rootInv.copy(root.matrixWorld).invert();
    // Into the model's space, where the axis means what the person means by it.
    _mo.copy(origin).applyMatrix4(_rootInv);
    _md.copy(direction).transformDirection(_rootInv);
    const mid = _centre.clone().applyMatrix4(_rootInv)[axis];

    _mo[axis] = 2 * mid - _mo[axis];
    _md[axis] = -_md[axis];

    _mo.applyMatrix4(root.matrixWorld);
    _md.transformDirection(root.matrixWorld);
    return [_mo, _md];
  }

  /**
   * Build the welded topology and the hierarchy before they are needed.
   *
   * Both are built on demand, and on demand means "during the first stroke":
   * measured on a thirty one thousand triangle model that is a hundred and fifty
   * milliseconds, and it scales with the mesh, so a real asset spends seconds
   * there. What that looks like from the outside is a pen that does nothing for
   * a moment and then dumps a blob of paint where the hand has already moved on
   * from, the worst possible moment to make somebody wait, because it is the
   * moment they are judging whether the tool works.
   *
   * The same work done when the *brush is chosen* costs exactly as much and is
   * read completely differently: a button that takes a beat is a tool getting
   * ready. Handed to a task of its own rather than run in the click, so the
   * button shows itself pressed instead of appearing to have missed the click.
   *
   * A timeout and not `requestAnimationFrame`: frames stop being delivered to a
   * window that is not on screen, and a warm-up that only happens when somebody
   * is already looking is a warm-up that skips exactly the case it exists for,
   * the brush picked up on one monitor while the model is on the other.
   */
  function warm() {
    setTimeout(() => {
      if (!tool) return;
      viewer.root.traverse((o) => {
        if (!paintable(o)) return;
        bvhOf(topologyOf(o.geometry), o, viewer);
      });
    }, 0);
  }

  /**
   * What the pointer is over on the far side of the mirror, if anything.
   *
   * Nothing is a perfectly ordinary answer, and not an error: half the strokes
   * on a symmetric model run along the middle, where the mirrored ray leaves by
   * the same hole it came in. The stroke simply paints once there.
   */
  function pickMirror(e) {
    if (!symmetry.on) return null;
    const r = canvas.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    ray.setFromCamera(_ndc, viewer.camera);
    const m = mirrorRay(ray.ray.origin, ray.ray.direction);
    return m ? pickRay(m[0], m[1]) : null;
  }

  function moveCursor(hit, pressure) {
    if (!hit) {
      if (cursor.visible) {
        cursor.visible = false;
        viewer.invalidate?.();
      }
      return;
    }
    const radius = brushRadius(hit.object, pressure);
    cursor.position.copy(hit.point);
    if (hit.face) _normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    else viewer.camera.getWorldDirection(_normal).negate();
    _normal.normalize();
    cursor.quaternion.setFromUnitVectors(_up, _normal);
    // Off the surface by a hair, or the ring z-fights with what it is drawn on.
    cursor.position.addScaledVector(_normal, radius * 0.02);
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
  function sample(e, withCursor = true) {
    const pressure = e.pointerType === "mouse" ? 1 : e.pressure > 0 ? e.pressure : 0.5;
    const hit = pickSurface(e);
    // The ring is moved once per *event*, not once per coalesced sample behind
    // it: ten of them land in the same frame and only the last would be seen.
    if (withCursor) moveCursor(hit, pressure);
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

        /*
         * The mirrored curve is traced from its own hits, not by reflecting the
         * points of this one.
         *
         * Reflecting the coordinates would be one line and would put the curve
         * *through* the surface wherever the model is not perfectly symmetric,
         * which is most scanned or sculpted assets. Following the mirrored ray
         * keeps the twin on the surface it is drawn on, which is the only place
         * a guide means anything.
         */
        const twin = pickMirror(e);
        if (twin) {
          if (!liveTwin) {
            liveTwin = {
              mesh: twin.object,
              kind: guideKind,
              points: [],
              object: null,
              radiusScale: brush.size,
              strength: brush.strength,
            };
          }
          if (twin.object === liveTwin.mesh) {
            const p = twin.object.worldToLocal(twin.point.clone());
            liveTwin.points.push([p.x, p.y, p.z]);
            if (liveTwin.points.length >= 2) drawGuide(liveTwin);
          }
        }
        viewer.invalidate?.();
      }
      return;
    }

    const dab = tool === "clone" ? cloneStamp : stamp;
    dab(hit, pressure);
    const twin = pickMirror(e);
    if (twin) dab(twin, pressure);

    /*
     * Fill in the gap since the last sample.
     *
     * Even at the digitiser's own rate a fast stroke moves further between two
     * samples than the brush is wide, and what lands on the model is a row of
     * dots. The gap is walked in screen space and each step re-picked, because
     * interpolating on the surface would need a geodesic between two points that
     * may be on opposite sides of a fold.
     */
    if (lastScreen) {
      const gap = Math.hypot(e.clientX - lastScreen.x, e.clientY - lastScreen.y);
      /*
       * A step of two thirds of the brush, and never more than eight of them.
       *
       * The spacing has to come from the brush rather than from a fixed number
       * of pixels, the whole point is that consecutive dabs overlap, and the
       * cap has to be low. It was twenty four, which meant one flick of the pen
       * asked for two dozen extra picks *per coalesced sample*, hundreds in a
       * frame. Eight covers any gap a hand can leave between two samples at pen
       * rate; beyond that the pointer jumped, which is a teleport rather than a
       * stroke and joining it up would paint a line nobody drew.
       */
      const stepPx = Math.max(3, cursorRadiusPx(hit) * 0.66);
      const steps = Math.min(8, Math.floor(gap / stepPx));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const between = {
          clientX: lastScreen.x + (e.clientX - lastScreen.x) * t,
          clientY: lastScreen.y + (e.clientY - lastScreen.y) * t,
          pointerType: e.pointerType,
        };
        const midHit = pickSurface(between);
        if (midHit) dab(midHit, pressure);
        // The mirror applies to the filled-in dabs too, or a fast stroke comes
        // out solid on one side and dotted on the other.
        const midTwin = pickMirror(between);
        if (midTwin) dab(midTwin, pressure);
      }
    }
    if (!lastScreen) lastScreen = { x: 0, y: 0 };
    lastScreen.x = e.clientX;
    lastScreen.y = e.clientY;
  }

  /** The brush's radius as it appears on screen, for spacing the fill-in. */
  function cursorRadiusPx(hit) {
    const radius = brushRadius(hit.object);
    const distance = viewer.camera.position.distanceTo(hit.point);
    const fov = (viewer.camera.fov * Math.PI) / 180;
    const height = 2 * Math.tan(fov / 2) * Math.max(distance, 1e-6);
    return (radius / height) * canvas.clientHeight;
  }

  /**
   * Take or give back the pointer, and survive being refused.
   *
   * `setPointerCapture` throws `NotFoundError` whenever the id is not an active
   * pointer, a synthetic event, a pen the browser has already released, a
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
    // way round", which is what they mean in every application that has a
    // brush, so it is not a shortcut to be learnt here.
    polarity = e.buttons & 32 || e.altKey || e.ctrlKey ? -1 : 1;

    if (tool === "clone") {
      /*
       * Alt picks the source, because Alt picks the source in every application
       * that has ever had a clone stamp. Nothing here is worth teaching somebody
       * a different key for.
       */
      if (e.altKey || e.ctrlKey || e.buttons & 32) {
        setCloneSource(hit);
        drawing = false;
        if (viewer.controls) viewer.controls.enabled = true;
        return;
      }
      if (!cloneSource) {
        // Nothing to copy from. Said out loud by the caller, which owns the
        // words; here it is simply not a stroke.
        drawing = false;
        if (viewer.controls) viewer.controls.enabled = true;
        onNeedSource?.();
        return;
      }
      const material = albedoMaterialOf(hit.object);
      const state = material && texturePaint.editable(material);
      if (!state) {
        drawing = false;
        if (viewer.controls) viewer.controls.enabled = true;
        onNeedTexture?.();
        return;
      }
      texturePaint.beginStroke(state);
    }
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
      // not eat the event, the camera is still the pointer's business.
      sample(e);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const queue = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (queue.length) {
      for (const c of queue) sample(c, false);
      // Once, at the end, where the pen actually is.
      moveCursor(pickSurface(e), e.pressure > 0 ? e.pressure : 0.5);
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

    if (tool === "guide" && (liveGuide || liveTwin)) {
      const kept = [];
      for (const curve of [liveGuide, liveTwin]) {
        if (!curve) continue;
        const topo = topologyOf(curve.mesh.geometry);
        curve.points = simplify(curve.points, topo.edge * 0.4);
        if (curve.points.length >= 2) {
          drawGuide(curve);
          guides.push(curve);
          kept.push(curve);
        } else {
          // A tap rather than a stroke. Nothing to keep, and nothing to leave
          // hanging in the scene either.
          curve.object?.parent?.remove(curve.object);
        }
      }
      if (kept.length) {
        // One entry for the pair, so one undo takes back one gesture rather
        // than leaving half a symmetric guide behind.
        undoStack.push({ guides: kept });
        redoStack.length = 0;
        changed();
      }
      liveGuide = null;
      liveTwin = null;
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
     * through the GLB, the exporter writes single precision, and the world
     * transform is applied on both sides in a different order, and narrow
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
      const had = tool;
      tool = next || null;
      // Nothing to drag the camera by while a brush is live, and the ring is
      // gone the moment there is no brush.
      canvas.style.cursor = tool ? "crosshair" : "";
      canvas.style.touchAction = tool ? "none" : "";
      sourceMark.visible = tool === "clone" && !!cloneSource;
      if (!tool) {
        cursor.visible = false;
        if (viewer.controls) viewer.controls.enabled = true;
      }
      // Picking up a brush is the moment to pay for the indexes, not the moment
      // the pen first touches the model. See `warm`.
      if (tool && !had) warm();
      refreshUniforms();
      changed();
    },
    get symmetry() {
      return symmetry;
    },
    setSymmetry(patch) {
      Object.assign(symmetry, patch);
      onChange?.();
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

    /**
     * Put the overlay up or take it down, without touching what is painted.
     *
     * Called as the mode opens and closes. See `attached`.
     */
    attach(on) {
      attached = !!on;
      if (!attached) api.setTool(null);
      refreshUniforms();
      changed();
    },
    get view() {
      return showPaint;
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      if (entry.guides) {
        for (const g of entry.guides) {
          const i = guides.indexOf(g);
          if (i >= 0) guides.splice(i, 1);
          g.object?.parent?.remove(g.object);
        }
        redoStack.push(entry);
        changed();
        return true;
      }
      if (entry.pixels) {
        for (const shot of entry.pixels) {
          const state = shot.material.userData.albedoPaint;
          if (state) texturePaint.restore(state, shot.before);
        }
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
      if (entry.guides) {
        for (const g of entry.guides) {
          guides.push(g);
          drawGuide(g);
        }
        undoStack.push(entry);
        changed();
        return true;
      }
      if (entry.pixels) {
        for (const shot of entry.pixels) {
          const state = shot.material.userData.albedoPaint;
          if (state) texturePaint.restore(state, shot.after);
        }
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
      /*
       * The wipe means everything, cloned pixels included.
       *
       * They are a different kind of edit, an image rather than a value on a
       * point, and it would be defensible to leave them. It would also be a
       * button labelled "erase everything" that leaves something, which is the
       * kind of small lie nobody forgives twice. The map goes back to the one the
       * bake produced, and the canvas is dropped rather than kept holding an
       * identical copy of it.
       */
      if (what === "all") {
        for (const material of cloneEdited) texturePaint.discard(material);
        cloneEdited.clear();
        cloneTouched.clear();
        cloneSource = null;
        cloneOffset = null;
        sourceMark.visible = false;
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

    /**
     * Is there anything at all to wipe?
     *
     * Cloned pixels count, even though the engine never reads them: this answer
     * drives the wipe button, and a button greyed out over a model somebody has
     * just painted on is a button that lies about the state of their work.
     */
    get empty() {
      const s = api.stats();
      return !s.density && !s.freeze && !s.region && !s.guides && !cloneEdited.size;
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
     * holds its objects still holds its paint, and one whose objects have been
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
    set onNeedSource(cb) {
      onNeedSource = cb;
    },
    set onNeedTexture(cb) {
      onNeedTexture = cb;
    },
    get cloneReady() {
      return !!cloneSource;
    },
    clearCloneSource() {
      cloneSource = null;
      cloneOffset = null;
      sourceMark.visible = false;
      changed();
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
      sourceMark.geometry.dispose();
      sourceMark.material.dispose();
      sourceMark.parent?.remove(sourceMark);
      api.clear("all");
      canvas.style.cursor = "";
      canvas.style.touchAction = "";
      if (viewer.controls) viewer.controls.enabled = true;
    },
  };

  return api;
}
