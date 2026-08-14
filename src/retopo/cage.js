import * as THREE from "three";

/**
 * The bake cage, drawn.
 *
 * A cage distance is two numbers on two sliders, and neither of them means
 * anything without seeing the shell they describe. Too short and the rays miss
 * whatever pokes out of the low poly, so the detail never lands in the map. Too
 * long and they reach across a gap onto the *next part* and bake a doorframe
 * onto a door. There is no way to pick a number for that from a report after the
 * fact: you have to look at the shell and see whether it swallows the detail
 * without touching the neighbour.
 *
 * **The push happens in the vertex shader.** Rebuilding positions on the CPU
 * each time the slider moves is a full buffer upload per pixel of drag, which is
 * exactly the interaction where a stall is least forgivable. One uniform means
 * the shell follows the slider for free.
 *
 * The distances the panel shows are a share of the bounding box diagonal, not
 * model units, so the same 0.02 behaves the same on a ring and on a cathedral.
 * The diagonal is measured once when the shell is built and folded into the
 * uniform.
 */

const VERT = /* glsl */ `
uniform float uCage;
void main() {
  // Along the vertex normal, which is the same direction the baker fires its
  // rays. A shell offset any other way would draw a lie.
  vec3 p = position + normal * uCage;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

/**
 * Build a shell that mirrors an object, and return a handle to drive it.
 *
 * Returns `null` when there is nothing to wrap, so callers can treat "no cage"
 * and "no result yet" as the same thing.
 */
export function buildCage(object) {
  if (!object) return null;

  const box = new THREE.Box3().setFromObject(object);
  const diagonal = box.getSize(new THREE.Vector3()).length();
  if (!(diagonal > 0)) return null;

  const uniforms = {
    uCage: { value: 0 },
    uColor: { value: new THREE.Color(0.49, 0.77, 1.0) },
    uOpacity: { value: 0.16 },
  };

  object.updateWorldMatrix(true, false);
  const inverseObject = object.matrixWorld.clone().invert();

  const group = new THREE.Group();
  group.name = "retopo-cage";
  group.visible = false;
  // Not raycastable: the cage is a diagram, and picking a material through it
  // would select the shell instead of the model under it.
  group.raycast = () => {};

  object.traverse((n) => {
    if (!n.isMesh && !n.isSkinnedMesh) return;
    const g = n.geometry;
    if (!g?.attributes?.position) return;
    // Normals are what the whole thing is pushed along, so a mesh without them
    // gets them rather than being skipped and leaving a hole in the shell.
    if (!g.attributes.normal) g.computeVertexNormals();

    const mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        // Both faces, because the shell is a bubble and you are usually looking
        // at the inside of the far half of it.
        side: THREE.DoubleSide,
        // Never write depth: a translucent shell that occludes is a shell that
        // hides the very thing it was drawn to be compared against.
        depthWrite: false,
      })
    );
    mesh.raycast = () => {};
    // The shell shares the source geometry, so it has to land in the same place.
    // The group hangs off the object itself, which means each mesh's transform
    // has to be expressed *relative to that object* rather than in world space:
    // copying the world matrix under a parent that already has one applies the
    // parent's transform twice, and the shell drifts off the model by exactly
    // the amount the model is offset from the origin.
    n.updateWorldMatrix(true, false);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(inverseObject, n.matrixWorld);
    group.add(mesh);
  });

  if (!group.children.length) return null;

  return {
    object: group,
    /** `share` is a fraction of the bounding box diagonal, as the panel shows. */
    setDistance(share) {
      uniforms.uCage.value = share * diagonal;
    },
    setVisible(on) {
      group.visible = on;
    },
    dispose() {
      group.parent?.remove(group);
      for (const c of group.children) c.material.dispose();
    },
  };
}
