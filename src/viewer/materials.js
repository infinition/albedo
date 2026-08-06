import * as THREE from "three";

/**
 * Bring every format onto the same PBR footing.
 *
 * FBX, OBJ, DAE and 3DS all produce Phong or Lambert materials. Under a scene
 * environment three lights them through `envMap` at full reflectivity, which
 * washes the model out under a white veil. Converting to MeshStandardMaterial
 * fixes that and makes the inspection channels meaningful, since roughness and
 * metalness then exist for real.
 */

const COPY_MAPS = [
  "map",
  "normalMap",
  "bumpMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "displacementMap",
  "lightMap",
];

function shininessToRoughness(shininess) {
  // Blinn-Phong exponent to a perceptual roughness, the usual approximation
  const s = Math.max(0, Math.min(1000, shininess ?? 30));
  return Math.min(1, Math.max(0.04, Math.sqrt(2 / (s + 2))));
}

/** @returns {number} how many materials were converted */
export function normalizeMaterials(object) {
  let converted = 0;
  const cache = new Map();

  const convert = (mat) => {
    if (!mat) return mat;
    if (!mat.isMeshPhongMaterial && !mat.isMeshLambertMaterial) return mat;
    if (cache.has(mat)) return cache.get(mat);

    const std = new THREE.MeshStandardMaterial({
      name: mat.name,
      color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
      emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
      emissiveIntensity: mat.emissiveIntensity ?? 1,
      roughness: mat.isMeshPhongMaterial ? shininessToRoughness(mat.shininess) : 0.9,
      metalness: 0,
      transparent: mat.transparent,
      opacity: mat.opacity,
      alphaTest: mat.alphaTest,
      side: mat.side,
      vertexColors: mat.vertexColors,
      flatShading: mat.flatShading,
      depthWrite: mat.depthWrite,
      wireframe: mat.wireframe,
    });

    for (const key of COPY_MAPS) {
      if (mat[key]) std[key] = mat[key];
    }
    if (mat.normalScale && std.normalScale) std.normalScale.copy(mat.normalScale);
    if (mat.bumpScale !== undefined) std.bumpScale = mat.bumpScale;

    // A Phong specular map is the closest thing to a gloss map: invert it
    if (mat.specularMap && !std.roughnessMap) {
      std.roughnessMap = mat.specularMap;
      std.roughness = 1;
    }
    // Keep reflections subtle: these formats were never authored for IBL
    std.envMapIntensity = 0.6;
    std.needsUpdate = true;

    cache.set(mat, std);
    converted++;
    return std;
  };

  object.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
  });
  return converted;
}

/**
 * Textures coming from formats that predate colour management are almost
 * always sRGB for the base colour and linear for the data maps.
 */
export function fixColorSpaces(object) {
  const linear = new Set([
    "normalMap", "roughnessMap", "metalnessMap", "aoMap", "displacementMap",
    "bumpMap", "alphaMap",
  ]);
  object.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      for (const key of linear) {
        if (m[key]) m[key].colorSpace = THREE.NoColorSpace;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * aoMap needs a second UV set; most loaders only fill uv. Duplicate it rather
 * than dropping ambient occlusion on the floor.
 */
export function ensureAoUv(object) {
  object.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const g = o.geometry;
    if (!g || !g.attributes.uv || g.attributes.uv1) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && m.aoMap)) {
      g.setAttribute("uv1", g.attributes.uv);
    }
  });
}
