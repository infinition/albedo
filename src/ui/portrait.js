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
 * Three things make it affordable, and all three matter:
 *
 * 1. **The existing renderer is borrowed**, not a second one built. A second
 *    WebGL context costs a few megabytes and, on a machine with a modest GPU, a
 *    visible stutter the moment it is created.
 * 2. **Every portrait is cached** against the geometry it came from, so opening
 *    and closing branches, toggling eyes and repainting the tree draw nothing.
 * 3. **Materials are borrowed too, never cloned.** A clone would compile a fresh
 *    shader program per portrait, which is the one cost here that would actually
 *    be felt.
 */

const SIZE = 28;

/** Portraits already drawn, keyed by what they are portraits of. */
const cache = new Map();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
// Two lights and no environment: an environment map would make the portrait
// depend on the scene's lighting, so the same mesh would look different in two
// files and stop being recognisable, which is the whole point.
scene.add(new THREE.AmbientLight(0xffffff, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(0.6, 1, 0.8);
scene.add(key);

const target = new THREE.WebGLRenderTarget(SIZE, SIZE, {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
});

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

/**
 * Draw one portrait and hand back a data URL, or null when it cannot be drawn.
 *
 * `only` is the index of the material to feature; everything else on the mesh is
 * drawn muted. Leave it out for a portrait of the whole mesh.
 */
export function portrait(renderer, mesh, only = -1) {
  const geometry = mesh?.geometry;
  if (!renderer || !geometry?.attributes?.position) return null;

  const id = `${geometry.uuid}|${only}`;
  if (cache.has(id)) return cache.get(id);

  const stand = new THREE.Mesh(geometry, flat);
  if (only >= 0 && geometry.groups?.length) {
    // One material slot lit, the rest of the same mesh ghosted behind it, so the
    // portrait says *where on this part* the material sits rather than merely
    // what colour it is.
    stand.material = geometry.groups.map((g) => (g.materialIndex === only ? flat : muted));
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
