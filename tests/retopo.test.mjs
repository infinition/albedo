import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { totalReport } from "../src/retopo/report.js";
import { prepareWire } from "../src/viewer/wire.js";

test("multi-object reports combine counts and retain the largest deviation", () => {
  const result = totalReport([
    { inputTriangles: 1000, outputTriangles: 100, quads: 40, deviationMax: 0.9, millis: 20, hits: 10, misses: 2, maps: ["Normal"], recoveredQuads: 3 },
    { inputTriangles: 500, outputTriangles: 50, quads: 10, deviationMax: 0.1, millis: 30, hits: 20, misses: 1, maps: ["Normal", "Color"], recoveredQuads: 2 },
  ]);
  assert.equal(result.deviationMax, 0.9);
  assert.equal(result.outputTriangles, 150);
  assert.equal(result.quads, 50);
  assert.equal(result.quadFraction, 100 / 150);
  assert.equal(result.recoveredQuads, 5);
  assert.equal(result.hits, 30);
  assert.equal(result.misses, 3);
  assert.equal(result.millis, 50);
  assert.deepEqual(result.maps, ["Normal", "Color"]);
});

test("deviation uses the shared GLB vertex accessor for every material primitive", () => {
  const positions = new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3);
  const object = new THREE.Group();
  for (const indices of [[0,1,2], [0,2,3]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", positions);
    g.setIndex(indices);
    object.add(new THREE.Mesh(g));
  }
  prepareWire(object, [3,6], null, [10,20,30,40]);
  assert.deepEqual([...object.children[0].geometry.attributes.aDev.array], [10,20,30]);
  assert.deepEqual([...object.children[1].geometry.attributes.aDev.array], [10,30,40]);
  assert.deepEqual([...object.children[1].geometry.attributes.aEdges.array], [6,6,6]);
  prepareWire(object);
  assert.deepEqual([...object.children[1].geometry.attributes.aDev.array], [10,30,40]);
});
