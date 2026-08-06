import { USDZLoader } from "three/examples/jsm/loaders/USDZLoader.js";
import * as fflate from "three/examples/jsm/libs/fflate.module.js";

/**
 * Loose USD files.
 *
 * three only reads USD through its .usdz path, which expects a zip archive and
 * pulls textures from inside it. A bare .usd or .usda on disk has neither, so
 * it is repackaged here: the layer becomes the first entry of an in-memory
 * archive, and everything it references by path is fetched from beside it and
 * added alongside. The loader then resolves it exactly as it would a .usdz.
 *
 * Binary crate files are a different format altogether and three cannot read
 * them, so they get an answer that says what to do instead of a stack trace.
 */

const CRATE = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]; // "PXR-USDC"
const ZIP = [0x50, 0x4b, 0x03, 0x04];

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

const dirOf = (url) => url.slice(0, url.lastIndexOf("/") + 1);
const baseName = (p) => p.split(/[\\/]/).pop() || p;

/** Asset paths in USD are written between @ signs. */
const REFERENCE = /@([^@\n\r]+)@/g;
const IMAGE = /\.(png|jpe?g|webp|bmp|gif|tga|exr|hdr)$/i;
const LAYER = /\.(usda?|usdc)$/i;

export async function loadUSD(url, { findTextures, resolveSibling } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lecture impossible (${res.status})`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (startsWith(bytes, CRATE)) {
    // A loose crate: its textures sit beside it on disk.
    const { CrateFile, buildFromCrate } = await import("./usdc/index.js");
    const object = buildFromCrate(new CrateFile(bytes), {
      resolveTexture: (file) =>
        resolveSibling ? resolveSibling(file) : new URL(file, new URL(url, document.baseURI)).href,
    });
    return { object, animations: [] };
  }

  // A .usd that is really a package.
  if (startsWith(bytes, ZIP)) return loadPackage(bytes, buffer);

  const text = fflate.strFromU8(bytes);
  const files = { "root.usda": bytes }; // must stay first: three reads entry 0
  await collectAssets(text, url, files, findTextures, resolveSibling);

  const zipped = fflate.zipSync(files, { level: 0 });
  const object = new USDZLoader().parse(zipped.buffer);
  return { object, animations: [] };
}

/**
 * A .usdz archive.
 *
 * Its first entry is the stage. Nearly every package in circulation stores it
 * as a binary crate, which three refuses, so that case is decoded here and the
 * archive's own images are handed over as textures. An ASCII stage still goes
 * through three's reader, which handles it well.
 */
export async function loadPackage(bytes, buffer) {
  const zip = fflate.unzipSync(bytes);
  const names = Object.keys(zip);
  const stage = names[0];
  const isCrate = stage && startsWith(zip[stage], CRATE);

  if (!isCrate) {
    return { object: new USDZLoader().parse(buffer), animations: [] };
  }

  const { CrateFile, buildFromCrate } = await import("./usdc/index.js");
  // Entries are addressed exactly as the stage names them, but a leading "./"
  // and case differences do turn up in the wild.
  const lookup = new Map(names.map((n) => [n.replace(/^\.\//, "").toLowerCase(), n]));
  const urls = new Map();
  const resolveTexture = (file) => {
    const key = file.replace(/^\.\//, "").toLowerCase();
    const entry = lookup.get(key) || lookup.get(key.split("/").pop());
    if (!entry) return null;
    if (!urls.has(entry)) {
      urls.set(entry, URL.createObjectURL(new Blob([zip[entry]], { type: mimeOf(entry) })));
    }
    return urls.get(entry);
  };

  const object = buildFromCrate(new CrateFile(zip[stage]), { resolveTexture });
  return { object, animations: [] };
}

function mimeOf(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "application/octet-stream";
}

/**
 * Fetch everything the layer references and put it in the archive.
 *
 * Textures are stored under a .png name whatever they were, because that is
 * the only extension the loader picks up; anything else is transcoded first so
 * the name is not a lie.
 */
async function collectAssets(text, url, files, findTextures, resolveSibling) {
  // A document-relative folder is not a valid URL base, so it is made absolute
  const base = new URL(dirOf(url), document.baseURI);
  const wanted = new Set();
  for (const m of text.matchAll(REFERENCE)) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith("/") || /^[a-z]+:/i.test(ref)) continue;
    if (IMAGE.test(ref) || LAYER.test(ref)) wanted.add(ref);
  }
  if (!wanted.size) return;

  // Anything not sitting beside the file is looked up by name, the same way
  // the NIF reader finds the textures a model names.
  let byName = null;
  const fallback = async (ref) => {
    if (!findTextures) return null;
    if (!byName) {
      const found = await findTextures([...wanted].map(baseName)).catch(() => []);
      byName = new Map((found || []).map((f) => [f.name.toLowerCase(), f.url]));
    }
    return byName.get(baseName(ref).toLowerCase()) || null;
  };

  await Promise.all(
    [...wanted].map(async (ref) => {
      // Under the asset protocol a relative URL loses its folder, so the
      // resolver is asked first and plain URL joining is the fallback.
      const sibling = resolveSibling ? resolveSibling(ref) : new URL(ref, base).href;
      let data = await fetchBytes(sibling);
      if (!data) {
        const alt = await fallback(ref);
        if (alt) data = await fetchBytes(alt);
      }
      if (!data) return;

      if (LAYER.test(ref)) {
        files[ref] = data;
        return;
      }
      if (/\.png$/i.test(ref)) {
        files[ref] = data;
        return;
      }
      const png = await toPng(data, ref);
      if (png) files[ref.replace(IMAGE, ".png")] = png;
    })
  );
}

async function fetchBytes(href) {
  try {
    const res = await fetch(href);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (_) {
    return null;
  }
}

/** Re-encode an image the loader would otherwise ignore. */
async function toPng(bytes, name) {
  try {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!out) return null;
    return new Uint8Array(await out.arrayBuffer());
  } catch (_) {
    console.warn(`[albedo] texture USD illisible : ${name}`);
    return null;
  }
}
