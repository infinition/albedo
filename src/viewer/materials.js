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

/** Perceived brightness of a colour, in plain sRGB. */
function luminance(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

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

    // FBX, OBJ and 3DS exporters write a neutral grey diffuse factor by
    // default, where glTF's equivalent is white. Multiplying a texture by that
    // grey is why one model looked a fifth darker depending on which file it
    // came from. A coloured tint is a decision and is kept; a grey one next to
    // a texture is a default nobody chose.
    const tint = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
    if (mat.map && tint.r === tint.g && tint.g === tint.b) tint.setRGB(1, 1, 1);

    // How hard the highlight is, which Phong states and PBR would otherwise
    // invent. An exporter writing a near black specular is saying the surface
    // is matte; dropping that on the floor and keeping only the shininess gave
    // every FBX a uniform plastic sheen, the veil over models that came from
    // anywhere but glTF. This is the same correction the specular-glossiness
    // path makes, so one asset now reads the same whatever it arrived in.
    const specular = mat.isMeshPhongMaterial && mat.specular ? mat.specular : null;
    const strength = specular ? luminance(specular) : null;
    const physical = strength !== null;

    const std = new (physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({
      name: mat.name,
      color: tint,
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
    if (physical) {
      // A mid grey specular is what an exporter writes for an ordinary
      // dielectric, so that maps to a full strength highlight and anything
      // darker damps it. The hue is kept: a tinted specular is a decision.
      //
      // The reflection factor is folded in with it. Phong keeps the highlight
      // and the environment reflection apart, and PBR does not: one term drives
      // both. In a viewer lit by an environment, a file that says it reflects
      // nothing is asking for no specular at all. Reading only the colour is
      // what left the same alligator matte as glTF and varnished as FBX, since
      // that exporter writes a bright specular next to a reflection factor of
      // zero.
      const reflect = mat.reflectivity ?? 1;
      std.specularIntensity = Math.min(1, Math.max(0, strength * 2 * reflect));
      const peak = Math.max(specular.r, specular.g, specular.b);
      if (peak > 0) std.specularColor.setRGB(specular.r / peak, specular.g / peak, specular.b / peak);
    }
    // The same footing as glTF. Dimming the environment here was meant to keep
    // reflections subtle on formats not authored for IBL, and its real effect
    // was that one alligator looked flatter than the next depending on the
    // container it arrived in.
    std.envMapIntensity = 1;
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
 * Turn a material into one that can describe glass.
 *
 * Exporters that lose a refraction setting leave a plain standard material
 * behind, and no amount of tweaking makes such a material transmit light. This
 * is the one conversion the inspector offers, so a badly exported window can be
 * put right by hand instead of being written off.
 */
/**
 * Repairs, offered as presets, not a shader zoo.
 *
 * Marmoset and Substance do not hand out a list of materials to pick from:
 * they let each channel of one physical model be swapped, and what looks like a
 * library is a saved set of values. A viewer showing what a file contains has
 * even less business inventing types. These exist for one reason, which is that
 * exporters lose things: a refraction that became an opaque slab, a metal that
 * arrived with no metalness. Each is a starting point the sliders then argue
 * with, and each can be undone back to what the file said.
 */
export const PRESETS = {
  verre: (m, span) => {
    m.transmission = 1;
    m.ior = 1.5;
    m.roughness = 0.05;
    m.metalness = 0;
    m.thickness = span * 0.05;
    m.transparent = false;
    m.opacity = 1;
  },
  liquide: (m, span) => {
    m.transmission = 1;
    m.ior = 1.33;
    m.roughness = 0.02;
    m.metalness = 0;
    m.thickness = span * 0.12;
    m.transparent = false;
    m.opacity = 1;
  },
  metal: (m) => {
    m.metalness = 1;
    m.roughness = Math.min(m.roughness ?? 0.3, 0.25);
    m.transmission = 0;
  },
  irise: (m) => {
    // Iridescence is a thin film, so it sits on top of whatever is underneath
    m.iridescence = 1;
    m.iridescenceIOR = 1.3;
    m.iridescenceThicknessRange = [100, 400];
  },
  verni: (m) => {
    m.clearcoat = 1;
    m.clearcoatRoughness = 0.05;
  },
};

export function toPhysical(material, { span = 1 } = {}) {
  if (!material || material.isMeshPhysicalMaterial) return material;
  const physical = new THREE.MeshPhysicalMaterial();
  // The physical copy reads fields a standard material never has, clearcoat
  // among them, and throws on the first one. Borrowing the parent class's copy
  // moves exactly what the two have in common.
  THREE.MeshStandardMaterial.prototype.copy.call(physical, material);
  physical.name = material.name;
  physical.transmission = 1;
  physical.ior = 1.5;
  physical.roughness = Math.min(material.roughness ?? 0.5, 0.1);
  physical.transparent = false;
  physical.opacity = 1;
  // Transmission with no thickness is a pane of nothing: light passes straight
  // through, unbent and untinted, and the surface reads as a hole. A thickness
  // proportional to the model is what makes it look like glass, and the slider
  // is right there to argue with.
  physical.thickness = span * 0.05;
  physical.needsUpdate = true;
  return physical;
}

/**
 * Build the material a preset describes, from the one that is there.
 *
 * @param {THREE.Material} material
 * @param {keyof PRESETS} name
 * @param {{span?: number}} [options] the model's own extent, for thicknesses
 */
export function applyPreset(material, name, { span = 1 } = {}) {
  const recipe = PRESETS[name];
  if (!recipe) return material;
  // Always a copy, never the file's own material. On a model that already
  // carries a physical material the recipe would otherwise write straight into
  // it, and there would be nothing left to go back to.
  const physical = material.isMeshPhysicalMaterial
    ? material.clone()
    : toPhysical(material, { span });
  physical.name = material.name;
  recipe(physical, span);
  physical.needsUpdate = true;
  return physical;
}

/** The map slots worth showing, in the order an artist thinks of them. */
export const MAP_SLOTS = [
  ["map", "Albedo"],
  ["normalMap", "Normale"],
  ["roughnessMap", "Rugosité"],
  ["metalnessMap", "Métal"],
  ["aoMap", "AO"],
  ["emissiveMap", "Émissif"],
  ["alphaMap", "Alpha"],
  ["bumpMap", "Relief"],
  ["displacementMap", "Déplacement"],
  ["lightMap", "Lumière"],
];

const DATA_SLOTS = new Set([
  "normalMap", "roughnessMap", "metalnessMap", "aoMap", "alphaMap",
  "bumpMap", "displacementMap",
]);

/**
 * Put a different image in one of a material's map slots.
 *
 * The new texture inherits the orientation, wrapping and tiling of the one it
 * replaces, because those belong to the model's UVs and not to the image: a
 * texture swapped in with three's defaults would come out upside down on half
 * the formats. With nothing to inherit from, another map on the same material
 * is asked instead.
 *
 * @returns {Promise<THREE.Texture>}
 */
export async function replaceMap(material, slot, url, name) {
  const isTga = /\.tga(\?|#|$)/i.test(url) || /\.tga$/i.test(name || "");
  let texture;
  if (isTga) {
    const { TGALoader } = await import("three/examples/jsm/loaders/TGALoader.js");
    texture = await new TGALoader().loadAsync(url);
  } else {
    texture = await new THREE.TextureLoader().loadAsync(url);
  }

  const previous = material[slot] || MAP_SLOTS.map(([k]) => material[k]).find(Boolean) || null;
  texture.name = name || "";
  texture.colorSpace = DATA_SLOTS.has(slot) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  texture.flipY = previous ? previous.flipY : false;
  texture.wrapS = previous ? previous.wrapS : THREE.RepeatWrapping;
  texture.wrapT = previous ? previous.wrapT : THREE.RepeatWrapping;
  if (previous) {
    texture.repeat.copy(previous.repeat);
    texture.offset.copy(previous.offset);
    texture.center.copy(previous.center);
    texture.rotation = previous.rotation;
  }
  texture.needsUpdate = true;
  material[slot] = texture;
  material.needsUpdate = true;
  return texture;
}

/**
 * Ignore a vertex colour that can only annihilate the texture.
 *
 * glTF multiplies COLOR_0 into the base colour, unconditionally. Some exporters
 * carry over a colour array from a scene where the renderer only applied vertex
 * colours when the material asked for it, and when that array is all zeros the
 * mesh comes out black however detailed its albedo is: skin, cloth, everything.
 *
 * Nothing is invented here, unlike guessing a missing map. An array that is
 * zero on every channel multiplies to zero everywhere, so the only thing it can
 * describe is a black surface under a texture nobody would then have shipped.
 * The material is marked so the inspector can say the file is defective rather
 * than let the repair pass unnoticed.
 *
 * @returns {number} how many materials stopped being multiplied by nothing
 */
export function ignoreDeadVertexColors(object) {
  let fixed = 0;
  const judged = new Map();

  const allZero = (geometry) => {
    const attr = geometry?.attributes.color;
    if (!attr) return false;
    if (judged.has(attr)) return judged.get(attr);
    const { array, itemSize } = attr;
    let dead = true;
    for (let i = 0; i < array.length && dead; i += itemSize) {
      // Alpha says nothing about brightness, so only the colour is judged
      for (let c = 0; c < Math.min(3, itemSize); c++) {
        if (array[i + c] !== 0) {
          dead = false;
          break;
        }
      }
    }
    judged.set(attr, dead);
    return dead;
  };

  object.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!allZero(o.geometry)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || !m.vertexColors) continue;
      // Without a texture the vertex colour is the whole look, and a black
      // model is then what the file really says.
      if (!m.map) continue;
      m.vertexColors = false;
      m.userData.deadVertexColors = true;
      m.needsUpdate = true;
      fixed++;
    }
  });
  return fixed;
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
