import { decompress } from "./lz4.js";

/**
 * PXR-USDC crate reader.
 *
 * This is the binary layer OpenUSD writes by default, and what sits inside
 * essentially every .usdz in circulation. three only reads the ASCII form, so
 * the container is decoded here: a table of contents points at six sections
 * holding the interned tokens, the field names and their value handles, the
 * path tree, and the specs that tie a path to a set of fields. Bulk arrays sit
 * earlier in the file and are addressed by offset.
 *
 * Written against the format's own structures rather than a reference port,
 * and checked against a model that also exists as glTF.
 */

const IDENT = "PXR-USDC";

/**
 * Value type codes.
 *
 * The numbering was read back from files rather than assumed: a Matrix4d lands
 * on 15, a Vec2f on 20 and a Vec3f on 24, which pins the whole sequence.
 */
export const TYPES = {
  Invalid: 0, Bool: 1, UChar: 2, Int: 3, UInt: 4, Int64: 5, UInt64: 6,
  Half: 7, Float: 8, Double: 9, String: 10, Token: 11, AssetPath: 12,
  Matrix2d: 13, Matrix3d: 14, Matrix4d: 15,
  Quatd: 16, Quatf: 17, Quath: 18,
  Vec2d: 19, Vec2f: 20, Vec2h: 21, Vec2i: 22,
  Vec3d: 23, Vec3f: 24, Vec3h: 25, Vec3i: 26,
  Vec4d: 27, Vec4f: 28, Vec4h: 29, Vec4i: 30,
  Dictionary: 31, TokenListOp: 32, StringListOp: 33, PathListOp: 34,
  ReferenceListOp: 35, IntListOp: 36, Int64ListOp: 37, UIntListOp: 38,
  UInt64ListOp: 39, PathVector: 40, TokenVector: 41,
  Specifier: 42, Permission: 43, Variability: 44,
};

/** A value handle: where the data is, what type it has, how it is stored. */
class ValueRep {
  constructor(bits) {
    this.bits = bits;
    this.payload = Number(bits & 0xffffffffffffn);
    this.type = Number((bits >> 48n) & 0xffn);
    this.isArray = (bits & (1n << 63n)) !== 0n;
    this.isInlined = (bits & (1n << 62n)) !== 0n;
    this.isCompressed = (bits & (1n << 61n)) !== 0n;
  }
}

export class CrateFile {
  constructor(buffer) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);

    const ident = String.fromCharCode(...this.bytes.subarray(0, 8));
    if (ident !== IDENT) throw new Error("ce fichier n'est pas un crate USD");
    this.version = [this.bytes[8], this.bytes[9], this.bytes[10]];

    const tocOffset = Number(this.view.getBigInt64(16, true));
    this.sections = this.readToc(tocOffset);

    this.tokens = this.readTokens();
    this.strings = this.readStrings();
    this.fields = this.readFields();
    this.fieldSets = this.readFieldSets();
    this.paths = this.readPaths();
    this.specs = this.readSpecs();
  }

  /** Version comparison, so the conditional layouts stay readable. */
  atLeast(major, minor, patch = 0) {
    const [a, b, c] = this.version;
    return a > major || (a === major && (b > minor || (b === minor && c >= patch)));
  }

  readToc(offset) {
    const count = Number(this.view.getBigUint64(offset, true));
    const sections = {};
    let p = offset + 8;
    for (let i = 0; i < count; i++) {
      let name = "";
      for (let k = 0; k < 16 && this.bytes[p + k]; k++) name += String.fromCharCode(this.bytes[p + k]);
      sections[name] = {
        start: Number(this.view.getBigInt64(p + 16, true)),
        size: Number(this.view.getBigInt64(p + 24, true)),
      };
      p += 32;
    }
    return sections;
  }

  section(name) {
    const s = this.sections[name];
    if (!s) throw new Error(`section ${name} absente du crate`);
    return s;
  }

  readTokens() {
    const { start } = this.section("TOKENS");
    let p = start;
    const count = Number(this.view.getBigUint64(p, true));
    p += 8;
    let data;
    if (this.atLeast(0, 4)) {
      const uncompressed = Number(this.view.getBigUint64(p, true));
      p += 8;
      const compressed = Number(this.view.getBigUint64(p, true));
      p += 8;
      data = decompress(this.bytes, p, compressed, uncompressed);
    } else {
      const size = Number(this.view.getBigUint64(p, true));
      p += 8;
      data = this.bytes.subarray(p, p + size);
    }
    // Null separated, in order.
    const tokens = new Array(count);
    let index = 0;
    let from = 0;
    for (let i = 0; i < data.length && index < count; i++) {
      if (data[i] !== 0) continue;
      tokens[index++] = utf8(data.subarray(from, i));
      from = i + 1;
    }
    return tokens;
  }

  readStrings() {
    const { start } = this.section("STRINGS");
    const count = Number(this.view.getBigUint64(start, true));
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getUint32(start + 8 + i * 4, true);
    return out;
  }

  /**
   * Integer arrays are stored as deltas: a two bit code per value picks either
   * the most common delta or an explicit 8, 16 or 32 bit one.
   */
  readCompressedInts(cursor, count, wide = false) {
    const compressedSize = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    const buffer = decompress(
      this.bytes,
      cursor.p,
      compressedSize,
      encodedSize(count, wide)
    );
    cursor.p += compressedSize;
    return decodeInts(buffer, count, wide);
  }

  readFields() {
    const { start } = this.section("FIELDS");
    const cursor = { p: start };
    const count = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    const tokenIndexes = this.readCompressedInts(cursor, count);

    const repsSize = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    const raw = decompress(this.bytes, cursor.p, repsSize, count * 8);
    const reps = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    const fields = new Array(count);
    for (let i = 0; i < count; i++) {
      fields[i] = {
        name: this.tokens[tokenIndexes[i]],
        rep: new ValueRep(reps.getBigUint64(i * 8, true)),
      };
    }
    return fields;
  }

  readFieldSets() {
    const { start } = this.section("FIELDSETS");
    const cursor = { p: start };
    const count = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    return this.readCompressedInts(cursor, count);
  }

  /**
   * Paths are stored as a tree walk: each entry names one element and says
   * whether a child follows and where the next sibling is.
   */
  readPaths() {
    const { start } = this.section("PATHS");
    const cursor = { p: start };
    const total = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    const encoded = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;

    const pathIndexes = this.readCompressedInts(cursor, encoded);
    const elementTokenIndexes = this.readCompressedInts(cursor, encoded);
    const jumps = this.readCompressedInts(cursor, encoded);

    const paths = new Array(total).fill("");
    // The walk always steps forward one entry; a jump only says where a
    // sibling subtree starts when the current entry also has a child. Treating
    // the jump as the sibling cursor stalls on a jump of zero.
    const pending = [[0, null]];
    while (pending.length) {
      let [cursor, parentPath] = pending.pop();
      for (;;) {
        const at = cursor++;
        const tokenIndex = elementTokenIndexes[at] | 0;
        let path;
        if (parentPath === null) {
          path = "/";
        } else {
          const token = this.tokens[Math.abs(tokenIndex)];
          const base = parentPath === "/" ? "" : parentPath;
          // A negative token index marks a property rather than a child prim
          path = tokenIndex < 0 ? `${base}.${token}` : `${base}/${token}`;
        }
        paths[pathIndexes[at]] = path;

        const jump = jumps[at] | 0;
        const hasChild = jump > 0 || jump === -1;
        const hasSibling = jump >= 0;
        if (hasChild) {
          if (hasSibling) pending.push([at + jump, parentPath]);
          parentPath = path;
        }
        if (!hasChild && !hasSibling) break;
        if (cursor >= encoded) break;
      }
    }
    if (!encoded) return paths;
    return paths;
  }

  readSpecs() {
    const { start } = this.section("SPECS");
    const cursor = { p: start };
    const count = Number(this.view.getBigUint64(cursor.p, true));
    cursor.p += 8;
    const pathIndexes = this.readCompressedInts(cursor, count);
    const fieldSetIndexes = this.readCompressedInts(cursor, count);
    const specTypes = this.readCompressedInts(cursor, count);

    const specs = new Array(count);
    for (let i = 0; i < count; i++) {
      specs[i] = {
        path: this.paths[pathIndexes[i]],
        fieldSet: fieldSetIndexes[i],
        type: specTypes[i],
      };
    }
    return specs;
  }

  /**
   * Read the value a handle points at.
   *
   * Small values live in the handle itself; everything else is at an offset,
   * where an array starts with its element count. Integer arrays add their
   * compressed size and go through the same delta coding as the sections.
   */
  value(rep) {
    if (!rep) return null;
    const T = TYPES;

    if (rep.isInlined) {
      switch (rep.type) {
        case T.Bool:
          return rep.payload !== 0;
        case T.UChar:
        case T.Int:
        case T.UInt:
        case T.Int64:
        case T.UInt64:
          return rep.payload;
        case T.Float:
          return new Float32Array(new Int32Array([rep.payload]).buffer)[0];
        case T.Token:
        case T.AssetPath:
          return this.tokens[rep.payload] ?? "";
        case T.String:
          return this.tokens[this.strings[rep.payload]] ?? "";
        case T.Matrix4d: {
          // Diagonal matrices are inlined as one byte per diagonal entry
          const d = [rep.payload & 0xff, (rep.payload >> 8) & 0xff, (rep.payload >> 16) & 0xff, (rep.payload >> 24) & 0xff];
          const m = new Float64Array(16);
          for (let i = 0; i < 4; i++) m[i * 5] = d[i];
          return m;
        }
        default:
          return rep.payload;
      }
    }

    const at = rep.payload;
    if (rep.isArray) return this.readArray(rep, at);

    switch (rep.type) {
      case T.Matrix4d: {
        const m = new Float64Array(16);
        for (let i = 0; i < 16; i++) m[i] = this.view.getFloat64(at + i * 8, true);
        return m;
      }
      case T.Double:
        return this.view.getFloat64(at, true);
      case T.Float:
        return this.view.getFloat32(at, true);
      case T.PathListOp: {
        // one flag byte, then the explicit path list
        const count = Number(this.view.getBigUint64(at + 1, true));
        const out = [];
        for (let i = 0; i < count; i++) out.push(this.paths[this.view.getUint32(at + 9 + i * 4, true)]);
        return out;
      }
      case T.PathVector: {
        const count = Number(this.view.getBigUint64(at, true));
        const out = [];
        for (let i = 0; i < count; i++) out.push(this.paths[this.view.getUint32(at + 8 + i * 4, true)]);
        return out;
      }
      case T.TokenVector: {
        const count = Number(this.view.getBigUint64(at, true));
        const out = [];
        for (let i = 0; i < count; i++) out.push(this.tokens[this.view.getUint32(at + 8 + i * 4, true)]);
        return out;
      }
      default:
        return null;
    }
  }

  readArray(rep, at) {
    const T = TYPES;
    const count = Number(this.view.getBigUint64(at, true));
    let p = at + 8;

    if (rep.isCompressed) {
      const wide = rep.type === T.Int64 || rep.type === T.UInt64;
      const compressedSize = Number(this.view.getBigUint64(p, true));
      p += 8;
      const buffer = decompress(this.bytes, p, compressedSize, encodedSize(count, wide));
      return decodeInts(buffer, count, wide);
    }

    const floats = (components) => {
      const out = new Float32Array(count * components);
      for (let i = 0; i < out.length; i++) out[i] = this.view.getFloat32(p + i * 4, true);
      return out;
    };
    const doubles = (components) => {
      const out = new Float64Array(count * components);
      for (let i = 0; i < out.length; i++) out[i] = this.view.getFloat64(p + i * 8, true);
      return out;
    };

    switch (rep.type) {
      case T.Vec3f:
        return floats(3);
      case T.Vec2f:
        return floats(2);
      case T.Vec4f:
        return floats(4);
      case T.Float:
        return floats(1);
      case T.Vec3d:
        return doubles(3);
      case T.Vec2d:
        return doubles(2);
      case T.Double:
        return doubles(1);
      case T.Int:
      case T.UInt: {
        const out = new Int32Array(count);
        for (let i = 0; i < count; i++) out[i] = this.view.getInt32(p + i * 4, true);
        return out;
      }
      case T.Token: {
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = this.tokens[this.view.getUint32(p + i * 4, true)];
        return out;
      }
      default:
        return null;
    }
  }

  /** The fields attached to a spec, as a plain object. */
  fieldsOf(spec) {
    const out = {};
    for (let i = spec.fieldSet; i < this.fieldSets.length; i++) {
      const index = this.fieldSets[i];
      if (index === -1 || index === 0xffffffff) break;
      const field = this.fields[index];
      if (field) out[field.name] = field.rep;
    }
    return out;
  }
}

const utf8 = (bytes) => new TextDecoder().decode(bytes);

const encodedSize = (count, wide) =>
  (wide ? 8 : 4) + Math.ceil((count * 2) / 8) + count * (wide ? 8 : 4);

/** Decode the delta stream produced by OpenUSD's integer coding. */
function decodeInts(buffer, count, wide) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let p = 0;
  const common = wide ? view.getBigInt64(0, true) : view.getInt32(0, true);
  p += wide ? 8 : 4;

  const codesAt = p;
  p += Math.ceil((count * 2) / 8);

  const out = wide ? new Array(count) : new Int32Array(count);
  let previous = wide ? 0n : 0;
  for (let i = 0; i < count; i++) {
    const code = (buffer[codesAt + (i >> 2)] >> ((i & 3) * 2)) & 3;
    if (wide) {
      let delta;
      if (code === 0) delta = common;
      else if (code === 1) {
        delta = BigInt(view.getInt8(p));
        p += 1;
      } else if (code === 2) {
        delta = BigInt(view.getInt16(p, true));
        p += 2;
      } else {
        delta = BigInt(view.getInt32(p, true));
        p += 4;
      }
      previous += delta;
      out[i] = previous;
    } else {
      let delta;
      if (code === 0) delta = common;
      else if (code === 1) {
        delta = view.getInt8(p);
        p += 1;
      } else if (code === 2) {
        delta = view.getInt16(p, true);
        p += 2;
      } else {
        delta = view.getInt32(p, true);
        p += 4;
      }
      previous = (previous + delta) | 0;
      out[i] = previous;
    }
  }
  return out;
}

export { ValueRep };
