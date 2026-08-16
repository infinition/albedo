import * as THREE from "three";

/**
 * A tiny portrait of each mesh, drawn from the mesh itself.
 *
 * The tree used to carry one glyph for every mesh in the file, which tells you
 * that a row is a mesh — something the indent already said — and nothing about
 * *which* mesh. On a model whose parts are called `Object_12` through
 * `Object_47`, that is the entire problem: the names are noise and the only
 * thing that distinguishes a visor from a jaw plate is what it looks like.
 *
 * So each row draws its own subject. A twenty-eight pixel render of that mesh
 * alone, framed to its own bounding box, in a flat colour against nothing. Not a
 * beauty shot: a silhouette with just enough shading to read as a solid, which
 * at this size is all that survives anyway.
 *
 * **Materials get the same treatment**, showing the mesh with every *other*
 * material struck out. That answers a question a colour swatch cannot: a swatch
 * says "this material is blue", the portrait says "this material is the visor".
 *
 * **And they are drawn with their own textures**, which is the whole difference
 * between an icon and a silhouette. A flat blue stand-in tells two armour plates
 * apart by outline alone; the painted one tells them apart at a glance, and on a
 * model whose parts really are near-identical shapes it is the only thing that
 * does.
 *
 * Three things make it affordable, and all three matter:
 *
 * 1. **The existing renderer is borrowed**, not a second one built. A second
 *    WebGL context costs a few megabytes and, on a machine with a modest GPU, a
 *    visible stutter the moment it is created.
 * 2. **Every portrait is cached** against the geometry *and the materials* it
 *    came from, so opening and closing branches, toggling eyes and repainting
 *    draw nothing — while a texture that finishes loading after the first paint
 *    still produces a new key and therefore a redrawn, textured portrait.
 * 3. **Materials are borrowed, never cloned.** A clone would compile a fresh
 *    shader program per portrait, which is the one cost here that would
 *    actually be felt. Borrowing costs one extra program per material, once,
 *    because this scene lights differently from the real one.
 *
 * That last point is why the lighting here is *only* an environment map, and the
 * scene's own by preference: no punctual lights at all means one lighting
 * configuration, so a material compiles one extra variant rather than one per
 * combination it happens to meet.
 */

const SIZE = 28;

/** Portraits already drawn, keyed by what they are portraits of. */
const cache = new Map();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
/**
 * The stand-in lighting, for a viewer that has no environment yet.
 *
 * Added and removed around the render rather than left in, so the ordinary path
 * — an environment map and nothing else — keeps its single lighting
 * configuration and its single compiled variant per material.
 */
const fallbackKey = new THREE.DirectionalLight(0xffffff, 2.1);
fallbackKey.position.set(0.6, 1, 0.8);
const fallbackFill = new THREE.AmbientLight(0xffffff, 1.15);

const target = new THREE.WebGLRenderTarget(SIZE, SIZE, {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
});

/** For a mesh whose materials cannot be borrowed, and only then. */
const flat = new THREE.MeshStandardMaterial({
  color: 0x9db8ff,
  roughness: 0.65,
  metalness: 0,
});
/** For the parts of a mesh a material portrait is *not* about. */
const muted = new THREE.MeshStandardMaterial({
  color: 0x2a2e35,
  roughness: 1,
  metalness: 0,
  transparent: true,
  opacity: 0.22,
});

const pixels = new Uint8Array(SIZE * SIZE * 4);
let canvas = null;

/** What a material's look depends on, flattened into a cache key. */
function materialStamp(list) {
  return list
    .map((m) => {
      if (!m) return "-";
      // The maps are part of the stamp because they arrive late: a portrait
      // drawn while the textures were still loading is a correct portrait of an
      // untextured material, and it must not be the one kept for ever.
      const maps = [m.map, m.emissiveMap, m.normalMap, m.aoMap]
        .map((t) => t?.uuid || "0")
        .join(",");
      return `${m.uuid}:${maps}`;
    })
    .join("|");
}

/**
 * Draw one portrait and hand back a data URL, or null when it cannot be drawn.
 *
 * @param {any} renderer the viewer's own renderer, borrowed mid-frame
 * @param {any} mesh the mesh to draw
 * @param {number} [only] index of the material to feature; everything else on
 *   the mesh is drawn muted. Leave it out for a portrait of the whole mesh.
 * @param {{materials?: any[], environment?: any}} [opts] `materials` is the
 *   mesh's *real* materials, which the caller has because a channel view may
 *   have swapped stand-ins onto the mesh itself; `environment` is the scene's
 *   probe, so a metal reads as metal rather than as a black hole.
 */
export function portrait(renderer, mesh, only = -1, opts = {}) {
  const geometry = mesh?.geometry;
  if (!renderer || !geometry?.attributes?.position) return null;

  const real = (opts.materials || (Array.isArray(mesh.material) ? mesh.material : [mesh.material]))
    .filter(Boolean);
  const id = `${geometry.uuid}|${only}|${materialStamp(real)}`;
  if (cache.has(id)) return cache.get(id);

  const stand = new THREE.Mesh(geometry, real.length ? (real.length === 1 ? real[0] : real) : flat);
  if (only >= 0 && geometry.groups?.length) {
    // One material slot lit, the rest of the same mesh ghosted behind it, so the
    // portrait says *where on this part* the material sits rather than merely
    // what colour it is.
    stand.material = geometry.groups.map((g) =>
      g.materialIndex === only ? real[only] || flat : muted
    );
  }

  // Framed on the geometry's own box, so a bolt and a hull both fill their
  // square: a portrait scaled to the model would make every small part a dot.
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere || !(sphere.radius > 0)) return null;

  const distance = (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15;
  camera.position.set(
    sphere.center.x + distance * 0.55,
    sphere.center.y + distance * 0.42,
    sphere.center.z + distance * 0.72
  );
  camera.lookAt(sphere.center);
  camera.near = Math.max(distance - sphere.radius * 2, 0.001);
  camera.far = distance + sphere.radius * 2;
  camera.updateProjectionMatrix();

  scene.add(stand);
  // The viewer's own probe, so a painted surface is lit rather than guessed at.
  // Without one there is nothing to light a standard material and every portrait
  // comes back black, which is worse than the flat blue this replaced.
  scene.environment = opts.environment || null;
  if (!scene.environment) scene.add(fallbackKey, fallbackFill);

  // Everything the renderer is holding is put back exactly as it was: this runs
  // in the middle of somebody else's frame loop.
  const oldTarget = renderer.getRenderTarget();
  const oldClear = renderer.getClearColor(new THREE.Color());
  const oldAlpha = renderer.getClearAlpha();
  let url = null;
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);

    canvas ||= document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const g = canvas.getContext("2d");
    const image = g.createImageData(SIZE, SIZE);
    // WebGL reads bottom-up and a canvas draws top-down, so the rows are copied
    // in reverse. Without this every portrait is upside down, which on a
    // symmetrical part looks merely odd and on a helmet looks broken.
    for (let y = 0; y < SIZE; y++) {
      const from = (SIZE - 1 - y) * SIZE * 4;
      image.data.set(pixels.subarray(from, from + SIZE * 4), y * SIZE * 4);
    }
    g.putImageData(image, 0, 0);
    url = canvas.toDataURL();
  } catch {
    url = null;
  } finally {
    scene.remove(stand);
    scene.remove(fallbackKey, fallbackFill);
    scene.environment = null;
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClear, oldAlpha);
  }

  cache.set(id, url);
  return url;
}

/** Forget everything, for when a different model arrives. */
export function forgetPortraits() {
  cache.clear();
}
