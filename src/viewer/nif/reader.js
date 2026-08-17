import { t } from "../../i18n/index.js";

/**
 * Little-endian cursor over an ArrayBuffer.
 *
 * NIF has no per-block size table before version 20.2, so every field has to be
 * consumed exactly: one wrong byte and the rest of the file is noise. The
 * reader therefore throws on any read past the end rather than returning zeros.
 */
export class Reader {
  constructor(buffer) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.p = 0;
  }

  get length() {
    return this.bytes.byteLength;
  }

  need(n) {
    if (this.p + n > this.bytes.byteLength) {
      throw new Error(`lecture hors buffer (${this.p} + ${n} > ${this.bytes.byteLength})`);
    }
  }

  u8() {
    this.need(1);
    return this.bytes[this.p++];
  }

  u16() {
    this.need(2);
    const v = this.view.getUint16(this.p, true);
    this.p += 2;
    return v;
  }

  i16() {
    this.need(2);
    const v = this.view.getInt16(this.p, true);
    this.p += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.p, true);
    this.p += 4;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.view.getInt32(this.p, true);
    this.p += 4;
    return v;
  }

  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }

  /** A block reference: -1 means "none", which u32 would read as 4294967295. */
  ref() {
    return this.i32();
  }

  vec2() {
    return [this.f32(), this.f32()];
  }

  vec3() {
    return [this.f32(), this.f32(), this.f32()];
  }

  vec4() {
    return [this.f32(), this.f32(), this.f32(), this.f32()];
  }

  /**
   * 3x3 rotation, stored column by column. Returned in that same order, which
   * is exactly what THREE.Matrix4.elements wants for its rotation part.
   */
  mat33() {
    const m = new Array(9);
    for (let i = 0; i < 9; i++) m[i] = this.f32();
    return m;
  }

  /** NiString: uint32 length then raw bytes. */
  string(limit = 16384) {
    const n = this.u32();
    if (n > limit) throw new Error(t("err.nifBadString").replace("{n}", n));
    this.need(n);
    let s = "";
    for (let i = 0; i < n; i++) {
      const c = this.bytes[this.p + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    this.p += n;
    return s;
  }

  /** Header line, terminated by \n. */
  line(limit = 256) {
    let s = "";
    for (let i = 0; i < limit; i++) {
      const c = this.u8();
      if (c === 0x0a) return s;
      s += String.fromCharCode(c);
    }
    throw new Error(t("err.nifNoHeader"));
  }

  skip(n) {
    this.need(n);
    this.p += n;
  }
}

/** Pack a NIF version into the uint32 the files carry. */
export const ver = (a, b, c, d) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

export const VERSIONS = {
  V4_0_0_2: ver(4, 0, 0, 2),
  V4_1_0_1: ver(4, 1, 0, 1),
  V4_1_0_12: ver(4, 1, 0, 12),
  V4_2_1_0: ver(4, 2, 1, 0),
  V4_2_2_0: ver(4, 2, 2, 0),
  V5_0_0_1: ver(5, 0, 0, 1),
  V10_0_1_0: ver(10, 0, 1, 0),
  V10_0_1_2: ver(10, 0, 1, 2),
  V10_0_1_8: ver(10, 0, 1, 8),
  V10_1_0_0: ver(10, 1, 0, 0),
  V10_1_0_106: ver(10, 1, 0, 106),
  V20_1_0_3: ver(20, 1, 0, 3),
};

/** Human form, "10.1.0.0". */
export const versionName = (v) =>
  [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
