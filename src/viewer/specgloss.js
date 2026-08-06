import * as THREE from "three";

/**
 * KHR_materials_pbrSpecularGlossiness for GLTFLoader.
 *
 * three dropped this extension, so any file written with it loses its diffuse
 * texture entirely: the loader falls back to an empty pbrMetallicRoughness
 * block, which defaults to metalness 1 and roughness 1. The model then renders
 * as a bare metal shell lit only by the environment, which is the grey veil
 * over hand-painted assets. Plenty of published models still ship this way, so
 * the viewer reads it rather than showing them wrong.
 *
 * The conversion follows the glTF specification's own mapping: the diffuse
 * term becomes base colour, and the specular colour drives a dielectric
 * specular rather than metalness.
 */
export class SpecularGlossinessExtension {
  constructor(parser) {
    this.parser = parser;
    this.name = "KHR_materials_pbrSpecularGlossiness";
  }

  getMaterialType(materialIndex) {
    const def = this.parser.json.materials[materialIndex];
    if (!def.extensions || !def.extensions[this.name]) return null;
    // physical, for the specular colour and intensity this model needs
    return THREE.MeshPhysicalMaterial;
  }

  extendMaterialParams(materialIndex, params) {
    const def = this.parser.json.materials[materialIndex];
    const ext = def.extensions && def.extensions[this.name];
    if (!ext) return Promise.resolve();

    const pending = [];

    const diffuse = ext.diffuseFactor;
    params.color = new THREE.Color(1, 1, 1);
    params.opacity = 1;
    if (Array.isArray(diffuse)) {
      params.color.setRGB(diffuse[0], diffuse[1], diffuse[2], THREE.LinearSRGBColorSpace);
      params.opacity = diffuse[3];
    }
    if (ext.diffuseTexture !== undefined) {
      pending.push(
        this.parser.assignTexture(params, "map", ext.diffuseTexture, THREE.SRGBColorSpace)
      );
    }

    // Specular-glossiness has no metals: the conductor look comes from a bright
    // specular colour, which maps onto the dielectric specular instead.
    params.metalness = 0;
    const glossiness = ext.glossinessFactor !== undefined ? ext.glossinessFactor : 1;
    params.roughness = 1 - glossiness;

    const specular = Array.isArray(ext.specularFactor) ? ext.specularFactor : [1, 1, 1];
    params.specularColor = new THREE.Color().setRGB(
      specular[0],
      specular[1],
      specular[2],
      THREE.LinearSRGBColorSpace
    );
    // A black specular means a purely diffuse surface; keeping the default
    // intensity of 1 would put a sheen on artwork that asked for none.
    params.specularIntensity = Math.max(specular[0], specular[1], specular[2]);

    if (ext.specularGlossinessTexture !== undefined) {
      pending.push(
        this.parser.assignTexture(
          params,
          "specularColorMap",
          ext.specularGlossinessTexture,
          THREE.SRGBColorSpace
        )
      );
      // Glossiness lives in the alpha channel, roughness in the green one, and
      // they run opposite ways: the channel has to be rebuilt.
      pending.push(
        this.parser
          .assignTexture({}, "map", ext.specularGlossinessTexture)
          .then((tex) => {
            const rough = alphaToRoughness(tex);
            if (rough) {
              params.roughnessMap = rough;
              params.roughness = 1;
            }
          })
          .catch(() => {})
      );
    }

    return Promise.all(pending);
  }
}

/** Rebuild a roughness map from a glossiness alpha channel. */
function alphaToRoughness(texture) {
  const image = texture && texture.image;
  if (!image || !image.width) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const roughness = 255 - px[i + 3];
      px[i] = roughness;
      px[i + 1] = roughness; // three samples roughness from green
      px[i + 2] = roughness;
      px[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    const out = new THREE.CanvasTexture(canvas);
    out.wrapS = texture.wrapS;
    out.wrapT = texture.wrapT;
    out.flipY = false;
    out.colorSpace = THREE.NoColorSpace;
    out.needsUpdate = true;
    return out;
  } catch (_) {
    return null;
  }
}
