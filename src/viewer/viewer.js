import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Scene host: renders on demand only.
 *
 * A viewer that redraws 60 times a second while nothing moves burns battery
 * and makes the whole window feel sluggish under load. Every mutation calls
 * invalidate(); the loop otherwise idles.
 */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.needsRender = true;
    this.clock = new THREE.Clock();
    this.mixer = null;
    this.current = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    this.camera.position.set(2.5, 1.8, 3);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener("change", () => this.invalidate());

    // Neutral studio lighting, generated: no HDRI to ship, no license to track
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 6, 4);
    this.scene.add(key);

    this.grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x272c35);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    this.scene.add(this.grid);

    this.boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x4c8dff);
    this.boxHelper.visible = false;
    this.scene.add(this.boxHelper);

    this.skeletons = new THREE.Group();
    this.skeletons.visible = false;
    this.scene.add(this.skeletons);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.loop();
  }

  invalidate() {
    this.needsRender = true;
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = this.clock.getDelta();
    if (this.onFrame) this.onFrame(dt);
    if (this.mixer && this.playing) {
      this.mixer.update(dt);
      this.needsRender = true;
    }
    if (this.controls.enableDamping) this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    this.root.clear();
    this.skeletons.clear();
    this.mixer = null;
    this.current = null;
    this.invalidate();
  }

  /** Put a loaded object in the scene, frame it, and collect its stats. */
  setModel(object, animations = []) {
    this.clear();
    this.root.add(object);
    this.current = object;

    // Each model starts from the user's own preference, not the last model's
    this.skeletons.visible = this._skeletonVisible === true;
    let meshCount = 0;
    object.traverse((o) => {
      if (o.isMesh || o.isPoints) meshCount++;
      if (o.isSkinnedMesh && o.skeleton) {
        const helper = new THREE.SkeletonHelper(o);
        helper.material.linewidth = 2;
        this.skeletons.add(helper);
      }
    });
    // Skeleton files carry a bone tree and no geometry: without the helper the
    // viewport would simply be empty, so it is shown by default there.
    if (object.userData.boneTree && !this.skeletons.children.length) {
      const helper = new THREE.SkeletonHelper(object);
      helper.material.linewidth = 2;
      this.skeletons.add(helper);
      if (meshCount === 0) this.skeletons.visible = true;
    }

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) {
      // No geometry to measure: fall back to where the nodes actually are
      const p = new THREE.Vector3();
      object.updateMatrixWorld(true);
      object.traverse((o) => box.expandByPoint(p.setFromMatrixPosition(o.matrixWorld)));
    }
    this.boxHelper.box.copy(box);
    this.frame(box);
    this.scaleGrid(box);

    if (animations.length) {
      this.mixer = new THREE.AnimationMixer(object);
      this.clips = animations;
    } else {
      this.clips = [];
    }
    this.invalidate();
    return this.stats();
  }

  frame(box) {
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-4);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15;

    this.camera.near = Math.max(radius / 1000, 1e-4);
    this.camera.far = radius * 1000;
    this.camera.updateProjectionMatrix();

    const dir = new THREE.Vector3(1, 0.55, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
    this.invalidate();
  }

  /** Re-frame the model currently in the scene. */
  frameCurrent() {
    if (!this.current) return;
    this.frame(new THREE.Box3().setFromObject(this.current));
  }

  /** Keep the floor grid readable whatever the model scale is. */
  scaleGrid(box) {
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, 1e-3);
    const step = Math.pow(10, Math.round(Math.log10(span)) - 1);
    const divisions = 20;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(step * divisions, divisions, 0x3a4150, 0x272c35);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.7;
    this.grid.position.y = box.min.y;
    this.grid.visible = this._gridVisible !== false;
    this.scene.add(this.grid);
  }

  stats() {
    let tris = 0;
    let meshes = 0;
    const materials = new Set();
    const textures = new Set();
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      meshes++;
      const g = o.geometry;
      if (g) {
        const count = g.index ? g.index.count : g.attributes.position?.count || 0;
        tris += count / 3;
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        materials.add(m);
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture) textures.add(v);
        }
      }
    });
    return {
      triangles: Math.round(tris),
      meshes,
      materials: materials.size,
      textures: textures.size,
    };
  }

  sceneTree(maxLines = 200) {
    const lines = [];
    const walk = (o, depth) => {
      if (lines.length >= maxLines) return;
      const kind = o.isSkinnedMesh
        ? "SkinnedMesh"
        : o.isMesh
          ? "Mesh"
          : o.isBone
            ? "Bone"
            : o.type;
      lines.push(`${"  ".repeat(depth)}${o.name || "(sans nom)"} · ${kind}`);
      for (const c of o.children) walk(c, depth + 1);
    };
    for (const c of this.root.children) walk(c, 0);
    return lines.join("\n") || "—";
  }

  setGrid(v) {
    this._gridVisible = v;
    this.grid.visible = v;
    this.invalidate();
  }
  setBounds(v) {
    this.boxHelper.visible = v;
    this.invalidate();
  }
  setSkeleton(v) {
    this._skeletonVisible = v;
    this.skeletons.visible = v;
    this.invalidate();
  }
  setExposure(v) {
    this.renderer.toneMappingExposure = v;
    this.invalidate();
  }
}
