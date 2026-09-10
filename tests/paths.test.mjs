import test from "node:test";
import assert from "node:assert/strict";
import { resolveSiblingPath } from "../src/paths.js";
import { siblingManager } from "../src/viewer/siblings.js";

test("sidecars preserve POSIX roots, Windows volumes and UNC shares", () => {
  assert.equal(resolveSiblingPath("/home/me/Model/scene.gltf", "../textures/a b.png"), "/home/me/textures/a b.png");
  assert.equal(resolveSiblingPath("/scene.gltf", "../../a.bin"), "/a.bin");
  assert.equal(resolveSiblingPath("C:\\Model\\scene.gltf", "..\\textures\\a.png"), "C:\\textures\\a.png");
  assert.equal(resolveSiblingPath("\\\\server\\share\\scene.gltf", "../../../a.bin"), "\\\\server\\share\\a.bin");
});

test("both WebView2 and WKWebView asset schemes resolve relative buffers", () => {
  for (const base of ["http://asset.localhost/", "asset://localhost/"]) {
    const model = base + "%2Fhome%2Fscene.gltf";
    const manager = siblingManager(model, (rel) => "resolved:" + rel);
    assert.equal(manager.resolveURL(base + "scene.bin"), "resolved:scene.bin");
    assert.equal(manager.resolveURL(model), model);
    assert.equal(manager.resolveURL(base + "%2Fhome%2Ftex.png"), base + "%2Fhome%2Ftex.png");
  }
});
