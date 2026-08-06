import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";

export const SUPPORTED = [
  "glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf",
  "3ds", "usdz", "wrl", "vrml", "vox", "amf", "pcd", "xyz",
  "nif", "kf", "kfa",
];

// Formats people ask for that no browser-side loader handles today.
export const KNOWN_UNSUPPORTED = {
  usd: "USD binaire/ASCII : seul l'emballage .usdz est lisible ici",
  usda: "USD ASCII : seul l'emballage .usdz est lisible ici",
  usdc: "USD binaire : seul l'emballage .usdz est lisible ici",
  blend: "Fichier Blender : format interne, à exporter en glTF",
  max: "3ds Max : format propriétaire fermé",
  ma: "Maya ASCII : format propriétaire",
  mb: "Maya binaire : format propriétaire",
};

const ext = (url) => {
  const hint = url.match(/#.([a-z0-9]+)$/i);
  if (hint) return hint[1].toLowerCase();
  const clean = url.split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
};

const dirOf = (url) => url.slice(0, url.lastIndexOf("/") + 1);
const nameOf = (url) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "");

let gltfLoader = null;

function getGLTFLoader(renderer) {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader().setDecoderPath(
    "https://www.gstatic.com/draco/versioned/decoders/1.5.6/"
  );
  const ktx2 = new KTX2Loader().setTranscoderPath(
    "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/"
  );
  if (renderer) ktx2.detectSupport(renderer);
  gltfLoader = new GLTFLoader()
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder);
  return gltfLoader;
}

/**
 * Load a model from a URL the webview can fetch (asset protocol or blob).
 * Sibling resources (.bin, textures, .mtl) resolve relative to it.
 * @returns {Promise<{object: THREE.Object3D, animations: THREE.AnimationClip[]}>}
 */
export async function loadModel(url, { renderer, onProgress, candidates, findTextures } = {}) {
  const kind = ext(url);
  const progress = (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  };

  switch (kind) {
    case "nif":
    case "kf":
    case "kfa": {
      const { loadNIF } = await import("./nif/index.js");
      const { object, animations, info } = await loadNIF(url, { candidates, findTextures });
      return { object, animations, info };
    }
    case "glb":
    case "gltf": {
      const gltf = await getGLTFLoader(renderer).loadAsync(url, progress);
      return { object: gltf.scene, animations: gltf.animations || [] };
    }
    case "fbx": {
      const obj = await new FBXLoader().loadAsync(url, progress);
      return { object: obj, animations: obj.animations || [] };
    }
    case "obj": {
      const loader = new OBJLoader();
      // An .mtl next to the .obj is the usual convention; ignore it if absent
      const mtlUrl = url.replace(/\.obj(\?|#|$)/i, ".mtl$1");
      try {
        const mtl = await new MTLLoader()
          .setResourcePath(dirOf(url))
          .loadAsync(mtlUrl);
        mtl.preload();
        loader.setMaterials(mtl);
      } catch (_) {
        /* no material library, plain geometry */
      }
      const obj = await loader.loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "stl": {
      const geo = await new STLLoader().loadAsync(url, progress);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.65, metalness: 0.05 })
      );
      mesh.name = nameOf(url);
      return { object: mesh, animations: [] };
    }
    case "ply": {
      const geo = await new PLYLoader().loadAsync(url, progress);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: !!geo.attributes.color,
          color: geo.attributes.color ? 0xffffff : 0xb9c0cc,
          roughness: 0.7,
        })
      );
      mesh.name = nameOf(url);
      return { object: mesh, animations: [] };
    }
    case "dae": {
      const res = await new ColladaLoader().loadAsync(url, progress);
      return { object: res.scene, animations: res.scene.animations || [] };
    }
    case "3mf": {
      const obj = await new ThreeMFLoader().loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      const obj = await new TDSLoader().loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "usdz": {
      const { USDZLoader } = await import("three/examples/jsm/loaders/USDZLoader.js");
      const obj = await new USDZLoader().loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "wrl":
    case "vrml": {
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
      const scene = await new VRMLLoader().loadAsync(url, progress);
      return { object: scene, animations: [] };
    }
    case "vox": {
      const { VOXLoader, VOXMesh } = await import("three/examples/jsm/loaders/VOXLoader.js");
      const chunks = await new VOXLoader().loadAsync(url, progress);
      const group = new THREE.Group();
      for (const chunk of chunks) group.add(new VOXMesh(chunk));
      return { object: group, animations: [] };
    }
    case "amf": {
      const { AMFLoader } = await import("three/examples/jsm/loaders/AMFLoader.js");
      const obj = await new AMFLoader().loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "pcd": {
      const { PCDLoader } = await import("three/examples/jsm/loaders/PCDLoader.js");
      const points = await new PCDLoader().loadAsync(url, progress);
      return { object: points, animations: [] };
    }
    case "xyz": {
      const { XYZLoader } = await import("three/examples/jsm/loaders/XYZLoader.js");
      const geo = await new XYZLoader().loadAsync(url, progress);
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ size: 0.01, vertexColors: !!geo.attributes.color })
      );
      return { object: points, animations: [] };
    }
    default: {
      const why = KNOWN_UNSUPPORTED[kind];
      throw new Error(why || `Format non pris en charge : .${kind || "?"}`);
    }
  }
}
