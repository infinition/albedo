import * as THREE from "three";

/**
 * A baked texture you can paint into.
 *
 * The maps that come back from a bake arrive as ordinary textures: an image
 * decoded by the loader, uploaded once, and read-only from then on. Correcting a
 * defect in one means getting at those pixels, changing a few thousand of them,
 * and getting the result back onto the card — none of which a `THREE.Texture`
 * over an `ImageBitmap` offers.
 *
 * So the first stroke swaps the map for a canvas holding the same pixels. From
 * then on painting is `putImageData` and one `needsUpdate`, and the exporter is
 * happy because three writes a canvas out exactly as it writes an image.
 *
 * # What this deliberately does not do
 *
 * **It edits the base colour and nothing else.** A clone stamp over a normal map
 * is a plausible-looking way to produce nonsense: normals are a direction field,
 * so copying a patch from elsewhere writes vectors that belong to a different
 * part of the surface, and the lighting goes wrong in a way that looks like a
 * bake error rather than like paint. Fixing the colour and re-baking the rest is
 * the honest workflow, and it is available because a bake can now be a patch.
 */

/**
 * The editable state of one material's base colour map.
 *
 * Kept on the material rather than in a map keyed by it, so it cannot outlive
 * what it describes: dropping the model drops the material and this with it.
 */
export function editable(material) {
  if (!material?.map?.image) return null;
  const held = material.userData.albedoPaint;
  if (held) return held;

  const source = material.map;
  const image = source.image;
  const width = image.width || image.videoWidth || 0;
  const height = image.height || image.videoHeight || 0;
  if (!width || !height || source.isCompressedTexture) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  /*
   * Every setting is carried across, and the list is not padding.
   *
   * A texture is a sampler as much as it is pixels: getting `flipY` wrong turns
   * the model upside down in texture space, `colorSpace` wrong washes the whole
   * model out, and the wrap modes wrong put a seam where there was none. Each of
   * those looks like a painting bug and none of them is.
   */
  texture.wrapS = source.wrapS;
  texture.wrapT = source.wrapT;
  texture.magFilter = source.magFilter;
  texture.minFilter = source.minFilter;
  texture.anisotropy = source.anisotropy;
  texture.colorSpace = source.colorSpace;
  texture.flipY = source.flipY;
  texture.offset.copy(source.offset);
  texture.repeat.copy(source.repeat);
  texture.center.copy(source.center);
  texture.rotation = source.rotation;
  texture.channel = source.channel;
  texture.needsUpdate = true;

  material.map = texture;
  material.needsUpdate = true;

  const state = {
    material,
    canvas,
    ctx,
    texture,
    width,
    height,
    /** The map as it was, so the whole thing can be put back. */
    original: source,
    /** Pixels as they stood when the current stroke began. */
    baseline: null,
  };
  material.userData.albedoPaint = state;
  return state;
}

/** Read the whole surface once, for sampling a source that is being painted over. */
export function snapshot(state) {
  return state.ctx.getImageData(0, 0, state.width, state.height);
}

/**
 * Bilinear sample, in texture coordinates, of a snapshot.
 *
 * Bilinear rather than nearest because a clone offset is never a whole number of
 * texels: nearest sampling makes a copied patch crawl and alias along its edge,
 * which is exactly the artefact somebody reached for this tool to remove.
 */
export function sample(image, u, v, flipY, out) {
  const w = image.width;
  const h = image.height;
  // Wrap, matching the default glTF sampler, so an offset that runs off the
  // edge of the atlas comes back rather than clamping into a smear.
  let x = (u - Math.floor(u)) * w - 0.5;
  let y = ((flipY ? 1 - v : v) % 1 + 1) % 1 * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xi, yi) => {
    const cx = ((xi % w) + w) % w;
    const cy = ((yi % h) + h) % h;
    return (cy * w + cx) * 4;
  };
  const p00 = at(x0, y0);
  const p10 = at(x0 + 1, y0);
  const p01 = at(x0, y0 + 1);
  const p11 = at(x0 + 1, y0 + 1);
  const d = image.data;
  for (let k = 0; k < 4; k++) {
    const top = d[p00 + k] + (d[p10 + k] - d[p00 + k]) * fx;
    const bottom = d[p01 + k] + (d[p11 + k] - d[p01 + k]) * fx;
    out[k] = top + (bottom - top) * fy;
  }
  return out;
}

/**
 * Remember the pixels a stroke is about to change, so it can be taken back.
 *
 * The whole surface, and that is a deliberate trade. Tracking the exact
 * rectangle a stroke touches means growing it dab by dab and reading the canvas
 * back mid-stroke, which is the one operation that stalls a GPU pipeline; a
 * two-thousand square map is sixteen megabytes copied once at `pointerdown`,
 * which nobody notices. It is also what lets a clone sample its source from
 * *before* the stroke, so painting over a region does not feed on itself and
 * smear.
 */
export function beginStroke(state) {
  state.baseline = snapshot(state);
  return state.baseline;
}

export function endStroke(state) {
  const before = state.baseline;
  state.baseline = null;
  return before;
}

/** Put a whole surface back, for an undo. */
export function restore(state, image) {
  state.ctx.putImageData(image, 0, 0);
  state.texture.needsUpdate = true;
}

/**
 * Give the material its original map back and forget the canvas.
 *
 * Used when a painting is wiped: the point of a wipe is that nothing is left,
 * and a canvas holding a copy of the same pixels is not nothing — it is a second
 * texture on the card and a different object in the exported file.
 */
export function discard(material) {
  const state = material?.userData?.albedoPaint;
  if (!state) return;
  material.map = state.original;
  material.needsUpdate = true;
  state.texture.dispose();
  delete material.userData.albedoPaint;
}
