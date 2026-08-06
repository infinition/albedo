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
import { SpecularGlossinessExtension } from "./specgloss.js";

export const SUPPORTED = [
  "glb", "gltf", "fbx", "obj", "stl", "ply", "dae", "3mf",
  "3ds", "usdz", "usd", "usda", "wrl", "vrml", "vox", "amf", "pcd", "xyz",
  "nif", "kf", "kfa",
];

// Formats people ask for that no browser-side loader handles today.
export const KNOWN_UNSUPPORTED = {
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

/**
 * Make sibling files resolve under Tauri's asset protocol.
 *
 * `convertFileSrc` percent-encodes the whole path into a single URL segment,
 * so `http://asset.localhost/C%3A%2F...%2Fscene.gltf` has exactly one segment.
 * Any relative reference inside the file, a .bin buffer, an .mtl library, a
 * texture, therefore resolves against the host root and arrives as
 * `http://asset.localhost/scene.bin`, which is nowhere. Every loader routes
 * its requests through the manager, so putting the folder back here fixes the
 * whole family at once.
 */
export function siblingManager(url, resolveSibling) {
  const manager = new THREE.LoadingManager();
  if (!resolveSibling) return manager;

  manager.setURLModifier((requested) => {
    if (!requested || requested === url) return requested;
    if (/^(blob|data):/i.test(requested)) return requested;
    const m = /^https?:\/\/asset\.localhost\/(.*)$/i.exec(requested);
    if (!m) return requested;
    let rel;
    try {
      rel = decodeURIComponent(m[1]);
    } catch (_) {
      return requested;
    }
    // Already a full path: the asset protocol produced it, leave it alone.
    if (/^[a-z]:[\\/]/i.test(rel) || rel.startsWith("\\\\") || rel.startsWith("/")) {
      return requested;
    }
    return resolveSibling(rel.split(/[?#]/)[0]) || requested;
  });
  return manager;
}

let gltfLoader = null;

function getGLTFLoader(renderer, manager) {
  if (gltfLoader) {
    gltfLoader.manager = manager;
    return gltfLoader;
  }
  const draco = new DRACOLoader().setDecoderPath(
    "https://www.gstatic.com/draco/versioned/decoders/1.5.6/"
  );
  const ktx2 = new KTX2Loader().setTranscoderPath(
    "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/"
  );
  if (renderer) ktx2.detectSupport(renderer);
  gltfLoader = new GLTFLoader(manager)
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder);
  // three dropped specular-glossiness; without this, files written with it
  // lose their diffuse texture and render as bare metal
  gltfLoader.register((parser) => new SpecularGlossinessExtension(parser));
  return gltfLoader;
}

/**
 * Load a model from a URL the webview can fetch (asset protocol or blob).
 * Sibling resources (.bin, textures, .mtl) resolve relative to it.
 * @returns {Promise<{object: THREE.Object3D, animations: THREE.AnimationClip[]}>}
 */
export async function loadModel(
  url,
  { renderer, onProgress, candidates, findTextures, resolveSibling } = {}
) {
  const kind = ext(url);
  const progress = (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  };
  const manager = siblingManager(url, resolveSibling);

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
      const gltf = await getGLTFLoader(renderer, manager).loadAsync(url, progress);
      return { object: gltf.scene, animations: gltf.animations || [] };
    }
    case "fbx": {
      const obj = await new FBXLoader(manager).loadAsync(url, progress);
      return { object: obj, animations: obj.animations || [] };
    }
    case "obj": {
      const loader = new OBJLoader(manager);
      // An .mtl next to the .obj is the usual convention; ignore it if absent
      const mtlUrl = url.replace(/\.obj(\?|#|$)/i, ".mtl$1");
      try {
        const mtl = await new MTLLoader(manager)
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
      const geo = await new STLLoader(manager).loadAsync(url, progress);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.65, metalness: 0.05 })
      );
      mesh.name = nameOf(url);
      return { object: mesh, animations: [] };
    }
    case "ply": {
      const geo = await new PLYLoader(manager).loadAsync(url, progress);
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
      const res = await new ColladaLoader(manager).loadAsync(url, progress);
      return { object: res.scene, animations: res.scene.animations || [] };
    }
    case "3mf": {
      const obj = await new ThreeMFLoader(manager).loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      const obj = await new TDSLoader(manager).loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "usdz": {
      const { USDZLoader } = await import("three/examples/jsm/loaders/USDZLoader.js");
      const obj = await new USDZLoader(manager).loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "usd":
    case "usda":
    case "usdc": {
      const { loadUSD } = await import("./usd.js");
      return loadUSD(url, { findTextures, resolveSibling });
    }
    case "wrl":
    case "vrml": {
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
      const scene = await new VRMLLoader(manager).loadAsync(url, progress);
      return { object: scene, animations: [] };
    }
    case "vox": {
      const { VOXLoader, VOXMesh } = await import("three/examples/jsm/loaders/VOXLoader.js");
      const chunks = await new VOXLoader(manager).loadAsync(url, progress);
      const group = new THREE.Group();
      for (const chunk of chunks) group.add(new VOXMesh(chunk));
      return { object: group, animations: [] };
    }
    case "amf": {
      const { AMFLoader } = await import("three/examples/jsm/loaders/AMFLoader.js");
      const obj = await new AMFLoader(manager).loadAsync(url, progress);
      return { object: obj, animations: [] };
    }
    case "pcd": {
      const { PCDLoader } = await import("three/examples/jsm/loaders/PCDLoader.js");
      const points = await new PCDLoader(manager).loadAsync(url, progress);
      return { object: points, animations: [] };
    }
    case "xyz": {
      const { XYZLoader } = await import("three/examples/jsm/loaders/XYZLoader.js");
      const geo = await new XYZLoader(manager).loadAsync(url, progress);
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
