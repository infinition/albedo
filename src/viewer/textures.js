import * as THREE from "three";

/**
 * Texture rescue for formats that ship their maps loose.
 *
 * OBJ and FBX routinely arrive with absolute paths from someone else's machine,
 * or with no material library at all, while the maps sit in a sibling folder.
 * Rather than leaving a grey model, look around the file and match by the
 * naming conventions the industry actually uses.
 */

const ROLE_PATTERNS = [
  // order matters: the first match wins, so the specific ones come first
  ["normalMap", /(^|[-_. ])(nor(mal)?(gl|dx)?|nrm|_n)([-_. ]|$)/i],
  ["roughnessMap", /(^|[-_. ])(rough(ness)?|rgh|_r)([-_. ]|$)/i],
  ["metalnessMap", /(^|[-_. ])(metal(lic|ness)?|mtl|mt|_m)([-_. ]|$)/i],
  ["aoMap", /(^|[-_. ])(ao|ambient(occlusion)?|occlusion)([-_. ]|$)/i],
  ["emissiveMap", /(^|[-_. ])(emissive|emit|emis|glow|_e)([-_. ]|$)/i],
  ["displacementMap", /(^|[-_. ])(height|displace(ment)?|disp)([-_. ]|$)/i],
  ["alphaMap", /(^|[-_. ])(opacity|alpha([-_. ]?mask)?)([-_. ]|$)/i],
  ["map", /(^|[-_. ])(albedo|base[-_. ]?color|basecolor|diffuse|diff|color|col|_d|det)([-_. ]|$)/i],
];

// Packed masks (Unreal and friends) are not opacity and not albedo
const PACKED = /(^|[-_. ])(orm|rma|mrao|arm|mask|pbr|packed)([-_. ]|$)/i;

const SRGB_ROLES = new Set(["map", "emissiveMap"]);

const baseName = (p) => p.split(/[\\/]/).pop() || p;
const stem = (p) => baseName(p).replace(/\.[^.]+$/, "");

/** Guess which PBR slot a file name is meant for. */
export function roleOf(fileName) {
  const n = baseName(fileName);
  if (PACKED.test(n)) return null;
  for (const [role, re] of ROLE_PATTERNS) {
    if (re.test(n)) return role;
  }
  return null;
}

/**
 * Score how much a texture belongs to a given material.
 * Sharing a prefix with the material or the model name beats a bare role match.
 */
function affinity(fileStem, materialName, modelStem) {
  const f = fileStem.toLowerCase();
  const m = (materialName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const s = (modelStem || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const flat = f.replace(/[^a-z0-9]+/g, "");
  let score = 0;
  if (m && flat.startsWith(m)) score += 10;
  else if (m && flat.includes(m)) score += 6;
  if (s && flat.startsWith(s)) score += 3;
  else if (s && flat.includes(s)) score += 2;
  return score;
}

/**
 * Fill in the missing maps of every material in `object`.
 *
 * @param {THREE.Object3D} object
 * @param {{name: string, url: string}[]} candidates files found next to the model
 * @param {string} modelName file name of the model itself
 * @returns {Promise<{applied: number, roles: string[]}>}
 */
export async function applyFoundTextures(object, candidates, modelName) {
  if (!candidates.length) return { applied: 0, roles: [] };

  const pool = candidates
    .map((c) => ({ ...c, role: roleOf(c.name), stem: stem(c.name) }))
    .filter((c) => c.role);
  if (!pool.length) return { applied: 0, roles: [] };

  const loader = new THREE.TextureLoader();
  let tgaLoader = null;
  const cache = new Map();
  const load = async (url, srgb) => {
    const key = `${url}|${srgb}`;
    if (cache.has(key)) return cache.get(key);
    // TGA is still everywhere in FBX pipelines and no browser decodes it
    const isTga = /\.tga(\?|#|$)/i.test(url);
    const pick = async () => {
      if (!isTga) return loader.loadAsync(url);
      if (!tgaLoader) {
        const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
        tgaLoader = new TGALoader();
      }
      return tgaLoader.loadAsync(url);
    };
    const p = pick().then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return t;
    });
    cache.set(key, p);
    return p;
  };

  const materials = new Set();
  object.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) materials.add(m);
    }
  });

  const modelStem = stem(modelName || "");
  const usedRoles = new Set();
  let applied = 0;

  for (const mat of materials) {
    // only standard/physical materials expose the PBR slots
    if (!("roughness" in mat) && !("map" in mat)) continue;
    for (const [role] of ROLE_PATTERNS) {
      if (mat[role]) continue; // already textured, leave it alone
      const best = pool
        .filter((c) => c.role === role)
        .map((c) => ({ c, score: affinity(c.stem, mat.name, modelStem) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best) continue;
      // with several materials, require a real link to avoid cross-assigning
      if (materials.size > 1 && best.score === 0) continue;

      const tex = await load(best.c.url, SRGB_ROLES.has(role));
      mat[role] = tex;
      if (role === "aoMap" || role === "roughnessMap" || role === "metalnessMap") {
        // these slots are ignored unless their factor lets them through
        if (role === "roughnessMap") mat.roughness = 1;
        if (role === "metalnessMap") mat.metalness = 1;
        if (role === "aoMap") mat.aoMapIntensity = 1;
      }
      if (role === "alphaMap") {
        mat.transparent = true;
      }
      mat.needsUpdate = true;
      usedRoles.add(role);
      applied++;
    }
  }
  return { applied, roles: [...usedRoles] };
}
