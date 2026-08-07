import {
  WebGLRenderer,
  Scene,
  OrthographicCamera,
  MeshBasicMaterial,
  Mesh,
  PlaneGeometry,
  TextureLoader,
  SRGBColorSpace,
} from "three";

/**
 * Pictures for the grid.
 *
 * Models go through the same path Explorer uses: a cached PNG, rendered on a
 * miss by `albedo.exe --thumbnail`. The manager deliberately does not draw them
 * itself, because the two share one cache and a second renderer would drift
 * from the first, showing two different pictures for one file.
 *
 * Textures are their own picture, but half of them are formats no browser
 * decodes: DDS, KTX2, TGA, EXR. Those are decoded with the readers the viewer
 * already carries and drawn once to a canvas.
 */

/** Formats an <img> handles on its own. */
const NATIVE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
/** How many renders may run at once. Each is a process. */
const LANES = 2;

const pending = [];
let running = 0;
let preview = null;
let previewIdle = null;
/**
 * Which repaint the queued work belongs to.
 *
 * Every miss costs a process, so a queue of them is a queue of processes. Walk
 * three folders quickly and the third one waits behind renders nobody will ever
 * look at. Work is stamped with the repaint that asked for it and dropped when
 * a newer one arrives.
 */
let era = 0;

/** Forget what was asked for before now. Nothing already running is killed. */
export function cancelPending() {
  era++;
  for (const item of pending.splice(0)) item.resolve(null);
}

/** Run at most LANES renders at a time; the rest wait their turn. */
function enqueue(job) {
  const mine = era;
  return new Promise((resolve, reject) => {
    pending.push({ job, resolve, reject, era: mine });
    pump();
  });
}

function pump() {
  while (running < LANES && pending.length) {
    const { job, resolve, reject, era: asked } = pending.shift();
    if (asked !== era) {
      resolve(null);
      continue;
    }
    running++;
    job()
      .then(resolve, reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

export async function thumbnailFor(entry, { call, tauri, size }) {
  if (entry.kind === "texture") return texturePicture(entry, { call, tauri, size });

  const hits = await call("thumbnails_lookup", { paths: [entry.path], size }).catch(() => null);
  const cached = hits?.[0]?.cached;
  if (cached) return srcFor(cached, tauri);

  const made = await enqueue(() => call("thumbnail_render", { path: entry.path, size }));
  return made ? srcFor(made, tauri) : null;
}

const srcFor = (path, tauri) => (tauri ? tauri.core.convertFileSrc(path) : path);

/** Let go of the WebGL surface kept for decoding exotic textures. */
export function releaseThumbnails() {
  disposePreview();
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

async function texturePicture(entry, { call, tauri, size }) {
  const src = srcFor(entry.path, tauri);
  if (NATIVE.test(entry.path)) return src;

  // The decoded picture joins the models' cache rather than living in memory:
  // a DDS was otherwise decoded on the GPU again at every visit, and again at
  // every search that repainted the grid.
  const hits = await call("thumbnails_lookup", { paths: [entry.path], size }).catch(() => null);
  const cached = hits?.[0]?.cached;
  if (cached) return srcFor(cached, tauri);

  try {
    const picture = await decodeExotic(src, entry.ext);
    if (!picture) return null;
    const stored = await call("thumbnail_save", { path: entry.path, size, data: picture }).catch(
      () => null
    );
    return stored ? srcFor(stored, tauri) : picture;
  } catch (_) {
    return null;
  }
}

/**
 * Decode a texture the browser cannot, and flatten it to a picture.
 *
 * Compressed formats live on the GPU by definition: there is no way to read a
 * DXT block into a 2D canvas without decompressing it, so a small WebGL surface
 * draws the texture once and the result is captured. The same surface serves
 * every card, and is dropped once the grid goes quiet.
 */
async function decodeExotic(url, ext) {
  const texture = await loadTexture(url, ext);
  if (!texture) return null;

  const surface = ensurePreview();
  const width = texture.image?.width || 256;
  const height = texture.image?.height || 256;
  const side = 256;
  surface.renderer.setSize(side, side, false);

  surface.material.map = texture;
  surface.material.needsUpdate = true;
  // Fit the image inside the square rather than stretching it
  const aspect = width / height;
  surface.mesh.scale.set(aspect >= 1 ? 1 : aspect, aspect >= 1 ? 1 / aspect : 1, 1);

  surface.renderer.render(surface.scene, surface.camera);
  // A data URL rather than a blob: it is what the cache stores, and it needs no
  // revoking if the picture never reaches the disk.
  const picture = surface.renderer.domElement.toDataURL("image/png");
  texture.dispose();
  scheduleDispose();
  return picture;
}

async function loadTexture(url, ext) {
  const kind = (ext || "").toLowerCase();
  if (kind === "dds") {
    const { DDSLoader } = await import("three/examples/jsm/loaders/DDSLoader.js");
    return new DDSLoader().loadAsync(url);
  }
  if (kind === "tga") {
    const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
    return new TGALoader().loadAsync(url);
  }
  if (kind === "exr") {
    const { EXRLoader } = await import("three/examples/jsm/loaders/EXRLoader.js");
    return new EXRLoader().loadAsync(url);
  }
  if (kind === "hdr") {
    const { RGBELoader } = await import("three/examples/jsm/loaders/RGBELoader.js");
    return new RGBELoader().loadAsync(url);
  }
  if (kind === "ktx2") {
    const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
    const loader = new KTX2Loader().setTranscoderPath(
      "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/"
    );
    loader.detectSupport(ensurePreview().renderer);
    return loader.loadAsync(url);
  }
  return new TextureLoader().loadAsync(url);
}

function ensurePreview() {
  clearTimeout(previewIdle);
  if (preview) return preview;

  const renderer = new WebGLRenderer({ antialias: false, alpha: true });
  renderer.outputColorSpace = SRGBColorSpace;
  const scene = new Scene();
  const camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 10);
  camera.position.z = 1;
  const material = new MeshBasicMaterial({ transparent: true, toneMapped: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  scene.add(mesh);
  preview = { renderer, scene, camera, material, mesh };
  return preview;
}

/** A WebGL context is a scarce thing; do not hold one for a grid at rest. */
function scheduleDispose() {
  clearTimeout(previewIdle);
  previewIdle = setTimeout(disposePreview, 8000);
}

function disposePreview() {
  if (!preview) return;
  preview.mesh.geometry.dispose();
  preview.material.dispose();
  preview.renderer.dispose();
  preview.renderer.forceContextLoss?.();
  preview = null;
}
