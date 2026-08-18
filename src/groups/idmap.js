import * as THREE from "three";

/**
 * The group map: the segmentation, drawn into the atlas.
 *
 * The one output that leaves the application. A split gives you objects in
 * Albedo; this gives you a PNG that Substance Painter, Blender, Marmoset and
 * every other texturing tool already know what to do with, because an ID map is
 * how that whole family of software has masked materials for a decade. The mesh
 * is not touched, nothing is renamed, and the file survives every export the
 * model goes through afterwards.
 *
 * ## Why it is rasterised by hand
 *
 * Canvas 2D antialiases every path it fills, and an antialiased ID map is a
 * broken one: the blended pixels along each border belong to no group, so a
 * selection by colour in the tool downstream picks up a fringe of nothing around
 * every part. Filling scanline by scanline gives hard edges, which is the entire
 * requirement.
 *
 * ## The colours are the ones on screen
 *
 * Same hash as `chartColour` in the shader, so the part that is orange in the
 * viewport is orange in the file. A map whose colours were merely *distinct*
 * would work as a mask and would make the person holding it do the matching
 * again from scratch.
 */

/**
 * A colour per group id, matching the shader's.
 *
 * `Math.imul` for the multiply because the hash relies on 32-bit overflow, and
 * `>>>` for the shifts because it relies on them being unsigned. Written with
 * `*` and `>>` this produces plausible colours that are not the same ones.
 */
export function groupColour(id) {
  const h = Math.imul(id >>> 0, 2654435761) >>> 0;
  const hue = ((h >>> 8) & 1023) / 1023;
  const sat = 0.45 + (((h >>> 18) & 63) / 63) * 0.35;
  const val = 0.55 + (((h >>> 24) & 63) / 63) * 0.35;
  const out = [];
  for (const n of [5, 3, 1]) {
    const k = (n + hue * 6) % 6;
    out.push(val - val * sat * Math.min(Math.max(Math.min(k, 4 - k), 0), 1));
  }
  return out.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
}

/** Fill one triangle, no antialiasing, top-left rule left deliberately loose. */
function fillTriangle(px, size, a, b, c, rgb) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!area) return;
  const inv = 1 / area;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Sampled at the texel centre, which is where a sampler will read it.
      const px0 = x + 0.5;
      const py0 = y + 0.5;
      const w0 = ((b[0] - a[0]) * (py0 - a[1]) - (b[1] - a[1]) * (px0 - a[0])) * inv;
      const w1 = ((px0 - a[0]) * (c[1] - a[1]) - (py0 - a[1]) * (c[0] - a[0])) * inv;
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
      const i = (y * size + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = 255;
    }
  }
}

/**
 * Grow every painted region outwards by `steps` texels.
 *
 * Not decoration. A UV island's border lands between texels, so a sampler
 * filtering near it reads the background and every part gets a dark rim in
 * whatever the map is masking. Smearing the colour outwards is what the bake
 * already does for its own maps, under the name bleed.
 */
function bleedOutwards(px, size, steps) {
  for (let pass = 0; pass < steps; pass++) {
    const before = px.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (before[i + 3] > 0) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = (ny * size + nx) * 4;
          if (before[j + 3] === 0) continue;
          px[i] = before[j];
          px[i + 1] = before[j + 1];
          px[i + 2] = before[j + 2];
          px[i + 3] = 255;
          break;
        }
      }
    }
  }
}

/**
 * Soften every border by a box blur, run `radius` times.
 *
 * **Off by default, and that is not timidity.** The main use of an ID map is
 * selecting a part by its colour in the tool downstream, and a blurred map has a
 * band of blended pixels along every border that belongs to no group at all — so
 * the selection picks up a fringe of nothing around everything. Hard edges are
 * not a limitation of this map, they are the feature.
 *
 * It is here because the *other* use is real too: somebody blending two
 * materials across a boundary wants that boundary soft, and doing it here beats
 * doing it by hand on ten masks. Two uses, one setting, and the default belongs
 * to the one that breaks if it is wrong.
 */
function soften(px, size, radius) {
  for (let pass = 0; pass < radius; pass++) {
    const before = px.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (before[i + 3] === 0) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const j = (ny * size + nx) * 4;
            if (before[j + 3] === 0) continue;
            r += before[j];
            g += before[j + 1];
            b += before[j + 2];
            n++;
          }
        }
        if (!n) continue;
        px[i] = r / n;
        px[i + 1] = g / n;
        px[i + 2] = b / n;
      }
    }
  }
}

/**
 * Draw the segmentation into a texture the size of the atlas.
 *
 * @param {object} o
 * @param {any[]} o.meshes the meshes carrying `aGroup`, in run order
 * @param {ArrayLike<number>} o.labelOfSuper group id per superface
 * @param {number} o.size side of the square map, in texels
 * @param {number} o.bleed texels of smear past every island border
 * @param {number} o.smooth passes of softening. Zero keeps the borders hard.
 * @returns {{canvas: HTMLCanvasElement, groups: number, uncovered: number}}
 */
export function paintGroupMap({ meshes, labelOfSuper, size = 2048, bleed = 8, smooth = 0 }) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  const image = cx.createImageData(size, size);
  const px = image.data;

  const seen = new Set();
  let painted = 0;
  const uv2 = new THREE.Vector2();

  for (const mesh of meshes) {
    const geometry = mesh?.geometry;
    const group = geometry?.attributes?.aGroup;
    const uv = geometry?.attributes?.uv;
    if (!group || !uv) continue;

    /*
     * The material's own texture transform, applied here.
     *
     * three carries `KHR_texture_transform` on the *texture* rather than on the
     * geometry, so raw UVs and the atlas they address are not the same space
     * whenever an exporter used it — and quantising exporters use it constantly,
     * with the real range hidden in the scale. A map drawn without it lands one
     * sixteenth of the way across the image and looks like a bug in the
     * segmentation.
     */
    const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const map = first?.map;
    let matrix = null;
    if (map) {
      map.updateMatrix();
      matrix = map.matrix;
    }

    const triangles = geometry.attributes.position.count / 3;
    for (let t = 0; t < triangles; t++) {
      const superface = group.getX(t * 3);
      if (!(superface >= 0)) continue;
      const id = labelOfSuper[superface];
      if (id === undefined) continue;
      seen.add(id);
      const rgb = groupColour(id);

      const corner = [];
      for (let k = 0; k < 3; k++) {
        uv2.set(uv.getX(t * 3 + k), uv.getY(t * 3 + k));
        if (matrix) uv2.applyMatrix3(matrix);
        // glTF puts the UV origin at the top left with v growing downwards,
        // which is also where a canvas puts its own, so no flip belongs here.
        corner.push([uv2.x * size, uv2.y * size]);
      }
      fillTriangle(px, size, corner[0], corner[1], corner[2], rgb);
      painted++;
    }
  }

  // Bleed first, then soften: softening an island whose surroundings are still
  // empty pulls transparent black in from outside and darkens every border.
  /*
   * How many groups actually survived onto the image, counted before anything
   * smears or blurs them.
   *
   * This is not a statistic, it is the map's one honest failure mode. Plenty of
   * models reuse UV space — symmetric halves, repeated trim, anything built to
   * save texture memory — and two parts sharing the same texels cannot both own
   * them, so the later one simply overwrites the earlier. Measured on a game
   * asset: 86 groups painted 30 colours, identically at 512 and 2048 texels, so
   * neither resolution nor clipping was ever involved.
   *
   * Nothing here can fix that; a map is the wrong shape for the question. What
   * it can do is say so, instead of handing back a file that looks complete and
   * is missing two thirds of the answer.
   */
  const landed = new Set();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 0) landed.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
  }

  if (bleed > 0) bleedOutwards(px, size, bleed);
  if (smooth > 0) soften(px, size, smooth);

  let uncovered = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] === 0) uncovered++;

  cx.putImageData(image, 0, 0);
  return {
    canvas,
    groups: seen.size,
    resolved: landed.size,
    triangles: painted,
    uncovered,
  };
}

/**
 * One map per atlas, because UV space is not shared.
 *
 * Every texture is addressed by coordinates in the same `0..1` square, so a
 * model with three materials has three *different* images all claiming it. Drawn
 * into one picture they overwrite each other and the last one wins — measured on
 * a three-material model, where 134 groups produced a map holding 59 colours,
 * identically at 512 and at 2048 texels. Resolution was never the problem;
 * asking one image to be three was.
 *
 * On the input this mode exists for — one mesh, one material, one atlas — this
 * returns a single map and the whole question never arises.
 */
export function paintGroupMaps({ meshes, labelOfSuper, size, bleed, smooth }) {
  const buckets = new Map();
  for (const mesh of meshes) {
    const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    // Keyed on the image, not the material: two materials sharing one atlas
    // share one map, which is the same reasoning applied the other way round.
    const key = first?.map?.uuid || first?.uuid || "none";
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { label: first?.name || "", meshes: [] }));
    bucket.meshes.push(mesh);
  }

  const out = [];
  for (const bucket of buckets.values()) {
    const painted = paintGroupMap({
      meshes: bucket.meshes,
      labelOfSuper,
      size,
      bleed,
      smooth,
    });
    if (painted.triangles) out.push({ ...painted, label: bucket.label });
  }
  return out;
}
