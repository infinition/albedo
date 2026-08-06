import { Reader, VERSIONS as V, versionName } from "./reader.js";

/**
 * NIF (NetImmerse / Gamebryo) reader, versions 3.x through 10.2.
 *
 * The format stores no block sizes before 20.2, so an unknown block type is
 * fatal for everything after it: its length cannot be guessed. The parser
 * therefore knows every type it may meet, and when it does meet a stranger it
 * stops cleanly and keeps what it already read rather than emitting garbage.
 *
 * Written against the DAoC client corpus (2084 files, Gamebryo 10.1.0.0) and
 * the 4.x layout used by that era's props and weapons.
 */

const TRI_SHAPES = new Set(["NiTriShape", "NiTriStrips"]);

/** Blocks that carry no payload beyond NiObjectNET plus a uint16 flag word. */
const FLAG_ONLY = new Set([
  "NiDitherProperty",
  "NiSpecularProperty",
  "NiWireframeProperty",
  "NiShadeProperty",
  "NiFogProperty",
]);

export function parseNif(buffer) {
  const r = new Reader(buffer);
  const headerString = r.line();
  if (!/NetImmerse|Gamebryo/i.test(headerString)) {
    throw new Error("ce fichier n'est pas un NIF (en-tête absent)");
  }
  const version = r.u32();
  const ctx = {
    version,
    versionName: versionName(version),
    headerString,
    blocks: [],
    warnings: [],
    roots: [],
  };

  if (version > V.V10_1_0_106) {
    throw new Error(
      `NIF ${ctx.versionName} : seules les versions jusqu'à 10.1.0.106 ` +
        `(NetImmerse, Gamebryo, DAoC, Morrowind) sont lues ici`
    );
  }

  const modern = version >= V.V5_0_0_1;
  let blockTypes = [];
  let blockTypeIndex = [];
  let numBlocks = 0;

  if (modern) {
    if (version >= V.V10_0_1_8) r.u32(); // user version
    numBlocks = r.u32();
    const numTypes = r.u16();
    for (let i = 0; i < numTypes; i++) blockTypes.push(r.string(256));
    for (let i = 0; i < numBlocks; i++) blockTypeIndex.push(r.u16());
    if (version >= V.V10_0_1_8) r.u32(); // unknown, always 0 in the corpus
  } else {
    numBlocks = r.u32();
  }

  for (let bi = 0; bi < numBlocks; bi++) {
    let kind;
    try {
      if (modern) {
        // 5.0.0.1 .. 10.1.0.106 prefix each block with a zero word; a non-zero
        // value means the previous block was mis-sized, so stop before we
        // fabricate geometry out of misread bytes.
        const check = r.u32();
        const type = blockTypes[blockTypeIndex[bi]];
        if (check !== 0) {
          ctx.warnings.push(`désalignement au bloc ${bi} (${type}), lecture arrêtée`);
          break;
        }
        kind = type;
      } else {
        kind = r.string(64);
      }
      const block = readBlock(r, kind, version, ctx);
      ctx.blocks[bi] = block ? { ...block, kind, index: bi } : { kind, index: bi };
    } catch (e) {
      ctx.warnings.push(`bloc ${bi} (${kind || "?"}) illisible : ${e.message}`);
      break;
    }
  }

  // Footer: the declared roots. Only trustworthy when every block was read.
  if (ctx.blocks.length === numBlocks) {
    try {
      const n = r.u32();
      for (let i = 0; i < n && i < 4096; i++) ctx.roots.push(r.ref());
      ctx.complete = r.p === r.length;
      ctx.trailing = r.length - r.p;
    } catch (_) {
      /* truncated footer, roots get inferred below */
    }
  }
  if (!ctx.roots.length) ctx.roots = inferRoots(ctx.blocks);

  return ctx;
}

/** Roots are the nodes nobody declares as a child. */
function inferRoots(blocks) {
  const claimed = new Set();
  for (const b of blocks) {
    if (!b) continue;
    for (const c of b.children || []) claimed.add(c);
  }
  const roots = [];
  for (const b of blocks) {
    if (!b || !isSceneNode(b.kind)) continue;
    if (!claimed.has(b.index)) roots.push(b.index);
  }
  return roots;
}

const isSceneNode = (kind) =>
  kind === "NiNode" ||
  kind === "NiBillboardNode" ||
  kind === "NiLODNode" ||
  kind === "NiSwitchNode" ||
  TRI_SHAPES.has(kind);

// ---------------------------------------------------------------------------
// Common bases
// ---------------------------------------------------------------------------

const readBool = (r, version) => (version < V.V4_1_0_1 ? r.u32() !== 0 : r.u8() !== 0);

/** NiObjectNET: name, extra data, controller. */
function readObjectNET(r, version) {
  const name = r.string();
  const extra = [];
  if (version >= V.V10_0_1_0) {
    const n = r.u32();
    for (let i = 0; i < n; i++) extra.push(r.ref());
  } else {
    extra.push(r.ref());
  }
  const controller = r.ref();
  return { name, extra, controller };
}

/** NiAVObject: NiObjectNET plus a local transform and property list. */
function readAVObject(r, version) {
  const base = readObjectNET(r, version);
  const flags = r.u16();
  const translation = r.vec3();
  const rotation = r.mat33();
  const scale = r.f32();
  if (version <= V.V4_2_2_0) r.vec3(); // velocity
  const props = [];
  const n = r.u32();
  for (let i = 0; i < n; i++) props.push(r.ref());
  if (version <= V.V4_2_2_0) {
    if (readBool(r, version)) {
      // bounding volume: a sphere in this era
      r.vec3();
      r.f32();
    }
  }
  if (version >= V.V10_0_1_0) r.ref(); // collision object
  return { ...base, flags, transform: { translation, rotation, scale }, props };
}

/** NiDynamicEffect: the nodes a light or projector applies to. */
function readDynamicEffect(r, version) {
  if (version >= V.V10_1_0_106) r.u8(); // switch state
  const n = r.u32();
  for (let i = 0; i < n; i++) r.ref();
}

/** NiTimeController base, shared by every animation controller. */
function readTimeController(r) {
  const next = r.ref();
  const flags = r.u16();
  const frequency = r.f32();
  const phase = r.f32();
  const start = r.f32();
  const stop = r.f32();
  const target = r.ref();
  return { next, flags, frequency, phase, start, stop, target };
}

const readExtraDataBase = (r, version) => (version >= V.V10_0_1_0 ? r.string() : nextExtra(r));

function nextExtra(r) {
  // pre-10.0.1.0 NiExtraData is a linked list with a byte count
  r.ref();
  r.u32();
  return "";
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function readFloatKey(r, interp) {
  const time = r.f32();
  const value = r.f32();
  if (interp === 2) {
    r.f32();
    r.f32();
  } else if (interp === 3) {
    r.vec3();
  }
  return [time, value];
}

function readVecKey(r, interp) {
  const time = r.f32();
  const value = r.vec3();
  if (interp === 2) {
    r.vec3();
    r.vec3();
  } else if (interp === 3) {
    r.vec3();
  }
  return [time, value];
}

/** Quaternions are stored w,x,y,z. */
function readQuatKey(r, interp) {
  const time = r.f32();
  const [w, x, y, z] = r.vec4();
  if (interp === 3) r.vec3();
  return [time, [x, y, z, w]];
}

function readKeyGroup(r, reader) {
  const count = r.u32();
  if (count === 0) return [];
  const interp = r.u32();
  const keys = new Array(count);
  for (let i = 0; i < count; i++) keys[i] = reader(r, interp);
  return keys;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** NiGeometryData, the part shared by shapes and strips. */
function readGeomShared(r, version) {
  const numVertices = r.u16();
  if (version >= V.V10_1_0_0) {
    r.u8(); // keep flags
    r.u8(); // compress flags
  }
  let vertices = null;
  if (readBool(r, version)) {
    vertices = new Float32Array(numVertices * 3);
    for (let i = 0; i < numVertices * 3; i++) vertices[i] = r.f32();
  }

  // The uv-set count and the tangent-space flag are one uint16, but they moved:
  // before 10.0.1.0 they sit after the colours, afterwards right here.
  let uvSets = 0;
  let tspace = 0;
  const early = version >= V.V10_0_1_0;
  if (early) {
    uvSets = r.u8();
    tspace = r.u8();
  }

  let normals = null;
  if (readBool(r, version)) {
    normals = new Float32Array(numVertices * 3);
    for (let i = 0; i < numVertices * 3; i++) normals[i] = r.f32();
    if (early && (tspace & 0xf0) !== 0) {
      r.skip(numVertices * 12); // bitangents
      r.skip(numVertices * 12); // tangents
    }
  }

  r.vec3(); // bounding centre
  r.f32(); // bounding radius

  let colors = null;
  if (readBool(r, version)) {
    colors = new Float32Array(numVertices * 4);
    for (let i = 0; i < numVertices * 4; i++) colors[i] = r.f32();
  }

  if (!early) {
    uvSets = r.u8();
    tspace = r.u8();
  }

  let uvs = null;
  const setCount = uvSets & 63;
  for (let s = 0; s < setCount; s++) {
    if (s === 0) {
      uvs = new Float32Array(numVertices * 2);
      for (let i = 0; i < numVertices * 2; i++) uvs[i] = r.f32();
    } else {
      r.skip(numVertices * 8);
    }
  }

  if (version >= V.V10_0_1_0) r.u16(); // consistency flags

  return { numVertices, vertices, normals, colors, uvs, indices: null };
}

function readTriShapeData(r, version) {
  const g = readGeomShared(r, version);
  const numTriangles = r.u16();
  r.u32(); // triangle point count
  const hasTriangles = version >= V.V10_0_1_0 ? readBool(r, version) : true;
  if (hasTriangles && numTriangles) {
    g.indices = new Uint16Array(numTriangles * 3);
    for (let i = 0; i < numTriangles * 3; i++) g.indices[i] = r.u16();
  }
  const matchGroups = r.u16();
  for (let i = 0; i < matchGroups; i++) r.skip(r.u16() * 2);
  return g;
}

function readTriStripsData(r, version) {
  const g = readGeomShared(r, version);
  r.u16(); // triangle count, implied by the strips
  const numStrips = r.u16();
  const lengths = new Array(numStrips);
  for (let i = 0; i < numStrips; i++) lengths[i] = r.u16();
  const hasPoints = version >= V.V10_0_1_0 ? readBool(r, version) : true;
  const out = [];
  if (hasPoints) {
    for (const len of lengths) {
      const strip = new Array(len);
      for (let i = 0; i < len; i++) strip[i] = r.u16();
      stripToTriangles(strip, out);
    }
  }
  g.indices = Uint16Array.from(out);
  return g;
}

/** Triangle strips alternate winding; degenerate triangles are dropped. */
function stripToTriangles(strip, out) {
  for (let i = 0; i + 2 < strip.length; i++) {
    const a = strip[i];
    const b = strip[i + 1];
    const c = strip[i + 2];
    if (a === b || b === c || a === c) continue;
    if (i % 2 === 0) out.push(a, b, c);
    else out.push(b, a, c);
  }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function readTexDesc(r, version) {
  const source = r.ref();
  r.u32(); // clamp mode
  r.u32(); // filter mode
  const uvSet = r.u32();
  r.u16(); // ps2 L
  r.u16(); // ps2 K
  if (version <= V.V4_1_0_12) r.u16();
  if (version >= V.V10_1_0_0 && readBool(r, version)) {
    r.vec2(); // translation
    r.vec2(); // tiling
    r.f32(); // w rotation
    r.u32(); // transform type
    r.vec2(); // centre offset
  }
  return { source, uvSet };
}

const SLOTS = ["base", "dark", "detail", "gloss", "glow", "bump", "decal0", "decal1", "decal2", "decal3"];

function readTexturingProperty(r, version) {
  const base = readObjectNET(r, version);
  if (version <= V.V10_0_1_2) r.u16(); // flags
  r.u32(); // apply mode
  const count = Math.min(r.u32(), SLOTS.length);
  const maps = {};
  for (let i = 0; i < count; i++) {
    if (!readBool(r, version)) continue;
    const desc = readTexDesc(r, version);
    maps[SLOTS[i]] = desc;
    if (i === 5) {
      // bump map: luma scale and offset, then a 2x2 matrix
      r.f32();
      r.f32();
      r.vec3();
      r.f32();
    }
  }
  if (version >= V.V10_0_1_0) {
    const shaderCount = r.u32();
    for (let i = 0; i < shaderCount; i++) {
      if (readBool(r, version)) {
        readTexDesc(r, version);
        r.u32();
      }
    }
  }
  return { ...base, maps };
}

function readSourceTexture(r, version) {
  const base = readObjectNET(r, version);
  const external = readBool(r, version);
  let file = "";
  if (external) {
    file = r.string();
    if (version >= V.V10_1_0_0) r.ref(); // unknown link
  } else {
    if (version <= V.V10_0_1_0) r.u8();
    if (version >= V.V10_1_0_0) r.string();
    r.ref(); // embedded pixel data
  }
  r.u32(); // pixel layout
  r.u32(); // mipmaps
  r.u32(); // alpha format
  readBool(r, version); // is static
  if (version >= V.V10_1_0_106) readBool(r, version); // direct render
  return { ...base, file: file.trim() };
}

// ---------------------------------------------------------------------------
// Skinning
// ---------------------------------------------------------------------------

function readSkinData(r, version) {
  const rotation = r.mat33();
  const translation = r.vec3();
  const scale = r.f32();
  const numBones = r.u32();
  r.ref(); // skin partition, before 10.1.0.101
  const hasWeights = version >= V.V4_2_1_0 ? readBool(r, version) : true;
  const bones = [];
  if (hasWeights) {
    for (let i = 0; i < numBones; i++) {
      const rot = r.mat33();
      const tr = r.vec3();
      const sc = r.f32();
      r.vec3(); // bounding sphere offset
      r.f32(); // bounding sphere radius
      const n = r.u16();
      const indices = new Uint16Array(n);
      const weights = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        indices[k] = r.u16();
        weights[k] = r.f32();
      }
      bones.push({ transform: { translation: tr, rotation: rot, scale: sc }, indices, weights });
    }
  }
  return { transform: { translation, rotation, scale }, bones };
}

function readSkinPartition(r, version) {
  const n = r.u32();
  const modern = version >= V.V10_1_0_0;
  for (let i = 0; i < n; i++) {
    const numVertices = r.u16();
    const numTriangles = r.u16();
    const numBones = r.u16();
    const numStrips = r.u16();
    const numWeights = r.u16();
    r.skip(numBones * 2);
    if (modern ? readBool(r, version) : true) r.skip(numVertices * 2);
    if (modern ? readBool(r, version) : true) r.skip(numVertices * numWeights * 4);
    const lengths = new Array(numStrips);
    for (let k = 0; k < numStrips; k++) lengths[k] = r.u16();
    const hasFaces = modern ? readBool(r, version) : true;
    if (hasFaces) {
      if (numStrips) for (const len of lengths) r.skip(len * 2);
      else r.skip(numTriangles * 6);
    }
    if (readBool(r, version)) r.skip(numVertices * numWeights);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block dispatch
// ---------------------------------------------------------------------------

function readBlock(r, kind, version, ctx) {
  if (TRI_SHAPES.has(kind)) {
    const av = readAVObject(r, version);
    const data = r.ref();
    const skin = r.ref();
    if (version >= V.V10_0_1_0 && version <= V.V20_1_0_3) {
      if (readBool(r, version)) {
        r.string();
        r.u32();
      }
    }
    return { ...av, data, skin, strips: kind === "NiTriStrips" };
  }

  if (FLAG_ONLY.has(kind)) {
    const base = readObjectNET(r, version);
    r.u16();
    return base;
  }

  switch (kind) {
    case "NiNode":
    case "NiBillboardNode":
    case "NiSwitchNode":
    case "NiBSAnimationNode":
    case "NiBSParticleNode": {
      const av = readAVObject(r, version);
      const children = [];
      const n = r.u32();
      for (let i = 0; i < n; i++) children.push(r.ref());
      const e = r.u32();
      for (let i = 0; i < e; i++) r.ref(); // effects
      if (kind === "NiBillboardNode" && version >= V.V10_1_0_106) r.u16();
      if (kind === "NiSwitchNode") r.u32();
      return { ...av, children };
    }

    case "NiTriShapeData":
    case "NiTriShapeDataNew":
      return { geometry: readTriShapeData(r, version) };

    case "NiTriStripsData":
      return { geometry: readTriStripsData(r, version) };

    case "NiMaterialProperty": {
      const base = readObjectNET(r, version);
      if (version <= V.V10_0_1_2) r.u16();
      const ambient = r.vec3();
      const diffuse = r.vec3();
      const specular = r.vec3();
      const emissive = r.vec3();
      const glossiness = r.f32();
      const alpha = r.f32();
      return { ...base, ambient, diffuse, specular, emissive, glossiness, alpha };
    }

    case "NiVertexColorProperty": {
      const base = readObjectNET(r, version);
      const flags = r.u16();
      // 10.1.0.0 still carries the two enums the schema drops at 10.0.1.2
      let vertexMode = 2;
      let lightingMode = 1;
      if (version <= V.V10_0_1_2 || version === V.V10_1_0_0) {
        vertexMode = r.u32();
        lightingMode = r.u32();
      }
      return { ...base, flags, vertexMode, lightingMode };
    }

    case "NiZBufferProperty": {
      const base = readObjectNET(r, version);
      const flags = r.u16();
      if (version >= V.V4_1_0_12) r.u32(); // compare function
      return { ...base, flags };
    }

    case "NiAlphaProperty": {
      const base = readObjectNET(r, version);
      const flags = r.u16();
      const threshold = r.u8();
      return { ...base, flags, threshold };
    }

    case "NiStencilProperty": {
      const base = readObjectNET(r, version);
      if (version <= V.V10_0_1_2) r.u16();
      r.u8(); // enabled
      for (let i = 0; i < 7; i++) r.u32();
      return base;
    }

    case "NiTexturingProperty":
      return readTexturingProperty(r, version);

    case "NiSourceTexture":
      return readSourceTexture(r, version);

    case "NiExtraData":
      return { name: readExtraDataBase(r, version) };

    case "NiStringExtraData": {
      const name = readExtraDataBase(r, version);
      if (version <= V.V4_2_2_0) r.u32(); // bytes remaining
      return { name, value: r.string() };
    }

    case "NiStringsExtraData": {
      const name = readExtraDataBase(r, version);
      const n = r.u32();
      const values = [];
      for (let i = 0; i < n; i++) values.push(r.string());
      return { name, values };
    }

    case "NiIntegerExtraData":
      return { name: readExtraDataBase(r, version), value: r.u32() };

    case "NiFloatExtraData":
      return { name: readExtraDataBase(r, version), value: r.f32() };

    case "NiBooleanExtraData":
    case "NiBoolExtraData":
      return { name: readExtraDataBase(r, version), value: r.u8() !== 0 };

    case "NiColorExtraData":
      return { name: readExtraDataBase(r, version), value: r.vec3() };

    case "NiVectorExtraData": {
      const name = readExtraDataBase(r, version);
      const value = r.vec3();
      r.f32();
      return { name, value };
    }

    case "NiIntegersExtraData": {
      const name = readExtraDataBase(r, version);
      const n = r.u32();
      const values = new Int32Array(n);
      for (let i = 0; i < n; i++) values[i] = r.i32();
      return { name, values };
    }

    case "NiBinaryExtraData": {
      const name = readExtraDataBase(r, version);
      r.skip(r.u32());
      return { name };
    }

    case "NiTextKeyExtraData": {
      const name = readExtraDataBase(r, version);
      if (version <= V.V4_2_2_0) r.u32();
      const n = r.u32();
      const keys = [];
      for (let i = 0; i < n; i++) keys.push([r.f32(), r.string()]);
      return { name, keys };
    }

    case "NiKeyframeController":
    case "NiTransformController": {
      const tc = readTimeController(r);
      const data = r.ref();
      return { ...tc, data };
    }

    case "NiKeyframeData":
    case "NiTransformData": {
      const count = r.u32();
      const type = count ? r.u32() : 0;
      const rotations = [];
      const euler = [];
      if (type !== 4) {
        for (let i = 0; i < count; i++) rotations.push(readQuatKey(r, type));
      } else {
        r.f32(); // unknown float that precedes the euler curves
        for (let i = 0; i < 3; i++) euler.push(readKeyGroup(r, readFloatKey));
      }
      const translations = readKeyGroup(r, readVecKey);
      const scales = readKeyGroup(r, readFloatKey);
      return { rotations, euler, translations, scales };
    }

    case "NiGeomMorpherController": {
      const tc = readTimeController(r);
      if (version >= V.V10_0_1_2) r.u16(); // extra flags
      const data = r.ref();
      r.u8(); // always update
      return { ...tc, data };
    }

    case "NiMorphData": {
      const numMorphs = r.u32();
      const numVertices = r.u32();
      r.u8(); // relative targets
      for (let i = 0; i < numMorphs; i++) {
        if (version >= V.V10_1_0_106) r.string(); // frame name, later addition
        const numKeys = r.u32();
        const interp = numKeys ? r.u32() : 0;
        for (let k = 0; k < numKeys; k++) readFloatKey(r, interp);
        r.skip(numVertices * 12);
      }
      return null;
    }

    case "NiSkinInstance": {
      const data = r.ref();
      const skeletonRoot = r.ref();
      const n = r.u32();
      const bones = [];
      for (let i = 0; i < n; i++) bones.push(r.ref());
      return { data, skeletonRoot, bones };
    }

    case "NiSkinData":
      return readSkinData(r, version);

    case "NiSkinPartition":
      return readSkinPartition(r, version);

    case "NiTextureEffect": {
      readAVObject(r, version);
      readDynamicEffect(r, version);
      r.mat33(); // model projection matrix
      r.vec3(); // model projection translation
      r.u32(); // texture filtering
      r.u32(); // texture clamping
      r.u32(); // texture type
      r.u32(); // coordinate generation
      const source = r.ref();
      r.u8(); // enable plane
      r.vec4(); // clipping plane
      if (version <= V.V10_1_0_106) {
        r.u16(); // ps2 L
        r.u16(); // ps2 K
      }
      if (version <= V.V4_1_0_12) r.u16();
      return { source };
    }

    case "NiAmbientLight":
    case "NiDirectionalLight":
    case "NiPointLight":
    case "NiSpotLight": {
      const av = readAVObject(r, version);
      readDynamicEffect(r, version);
      const dimmer = r.f32();
      const ambient = r.vec3();
      const diffuse = r.vec3();
      const specular = r.vec3();
      if (kind === "NiPointLight" || kind === "NiSpotLight") {
        r.f32();
        r.f32();
        r.f32();
      }
      if (kind === "NiSpotLight") {
        r.f32();
        r.f32();
      }
      return { ...av, light: kind, dimmer, ambient, diffuse, specular };
    }

    case "NiLightColorController":
    case "NiLightDimmerController":
    case "NiMaterialColorController": {
      const tc = readTimeController(r);
      if (version >= V.V10_1_0_0) r.u16(); // which colour the curve drives
      const data = r.ref();
      return { ...tc, data };
    }

    case "NiPosData":
      return { translations: readKeyGroup(r, readVecKey) };

    case "NiFloatData":
      return { values: readKeyGroup(r, readFloatKey) };

    case "NiColorData": {
      const count = r.u32();
      const interp = count ? r.u32() : 0;
      for (let i = 0; i < count; i++) {
        r.f32();
        r.vec4();
        if (interp === 2) {
          r.vec4();
          r.vec4();
        } else if (interp === 3) r.vec3();
      }
      return null;
    }

    case "NiVisController": {
      const tc = readTimeController(r);
      const data = r.ref();
      return { ...tc, data };
    }

    case "NiVisData": {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        r.f32();
        r.u8();
      }
      return null;
    }

    case "NiUVController": {
      const tc = readTimeController(r);
      r.u16();
      const data = r.ref();
      return { ...tc, data };
    }

    case "NiUVData": {
      for (let i = 0; i < 4; i++) readKeyGroup(r, readFloatKey);
      return null;
    }

    default:
      ctx.warnings.push(`type de bloc inconnu : ${kind}`);
      throw new Error(`type inconnu ${kind}`);
  }
}
