import { loadModel } from "./loaders.js";
import { normalizeMaterials, fixColorSpaces, ignoreDeadVertexColors, ensureAoUv, resolveTransparency } from "./materials.js";
import { applyFoundTextures } from "./textures.js";

export function neutralThumbnailLook(viewer) {
  viewer.setExposure(1);
  viewer.setEnvironmentIntensity(1);
  viewer.envLighting = true;
  viewer.setKeyLight(true);
  viewer.setKeyLightPower(1.6);
  viewer.setKeyLightColour("#ffffff");
  viewer.setEnvironment("studio");
  viewer.setClipping({ on: false });
}

/** One renderer and material pipeline for Explorer, Quick Look and Linux. */
export async function thumbnail(viewer, { url, name = "", size = 512, candidates = [], findTextures, resolveSibling }) {
  neutralThumbnailLook(viewer);
  const { object, animations } = await loadModel(url, { renderer: viewer.renderer, candidates, findTextures, resolveSibling });
  normalizeMaterials(object);
  fixColorSpaces(object);
  ignoreDeadVertexColors(object);
  ensureAoUv(object);
  viewer.setModel(object, animations, name);
  await applyFoundTextures(object, candidates, name);
  const maps = [];
  object.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) for (const v of Object.values(m)) if (v?.isTexture) maps.push(v);
    }
  });
  const until = performance.now() + 8000;
  while (performance.now() < until && !maps.every((t) => t.image && (t.image.width || t.image.data || t.mipmaps?.length))) {
    await new Promise((r) => setTimeout(r, 40));
  }
  resolveTransparency(object);
  return viewer.snapshot(Math.max(32, Math.min(2048, size)), { transparent: true });
}
