/**
 * LZ4 block decompression, plus the framing OpenUSD wraps around it.
 *
 * Crate sections are stored as LZ4 blocks behind a one byte chunk count: zero
 * means a single block, anything else means that many chunks, each preceded by
 * its compressed size. No third-party decoder is pulled in for this, the block
 * format is a hundred lines.
 */

/** Decompress one raw LZ4 block whose output size is known. */
export function lz4Block(src, srcStart, srcEnd, dstSize) {
  const dst = new Uint8Array(dstSize);
  let ip = srcStart;
  let op = 0;

  while (ip < srcEnd) {
    const token = src[ip++];

    let length = token >> 4;
    if (length === 15) {
      let b;
      do {
        b = src[ip++];
        length += b;
      } while (b === 255);
    }
    for (let i = 0; i < length; i++) dst[op++] = src[ip++];
    if (ip >= srcEnd) break;

    const offset = src[ip++] | (src[ip++] << 8);
    if (offset === 0) throw new Error("bloc LZ4 corrompu (décalage nul)");

    let matchLength = token & 15;
    if (matchLength === 15) {
      let b;
      do {
        b = src[ip++];
        matchLength += b;
      } while (b === 255);
    }
    matchLength += 4;

    // Matches can overlap the write cursor, so this copies byte by byte.
    let match = op - offset;
    for (let i = 0; i < matchLength; i++) dst[op++] = dst[match++];
  }
  return dst;
}

/** The chunk count OpenUSD puts in front of its LZ4 payloads. */
export function decompress(bytes, offset, compressedSize, uncompressedSize) {
  const chunks = bytes[offset];
  if (chunks === 0) {
    return lz4Block(bytes, offset + 1, offset + compressedSize, uncompressedSize);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(uncompressedSize);
  let p = offset + 1;
  let written = 0;
  for (let i = 0; i < chunks; i++) {
    const size = Number(view.getBigUint64(p, true));
    p += 8;
    const room = uncompressedSize - written;
    const part = lz4Block(bytes, p, p + size, Math.min(0x7e000000, room));
    out.set(part.subarray(0, Math.min(part.length, room)), written);
    written += part.length;
    p += size;
  }
  return out;
}
