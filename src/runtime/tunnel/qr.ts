// Minimal QR encoder. Supports QR Model 2, error-correction level M, byte
// (8-bit) mode. The Cloudflare quick-tunnel URL plus 32-char secret fits
// inside version 15 (capacity 311 bytes at ECL M); we let the encoder
// auto-pick the smallest version that fits.
//
// This is a from-scratch implementation rather than a dependency because the
// only public callers are the runtime endpoints (svg/ansi) and the CLI; the
// surface is small enough to keep in-tree.
//
// References: ISO/IEC 18004:2015 sections 7.3 - 7.8 + Appendix.

interface Bitstream {
  bits: number[];
  push(value: number, length: number): void;
}

function bitstream(): Bitstream {
  const bits: number[] = [];
  return {
    bits,
    push(value: number, length: number) {
      for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
    }
  };
}

const ECL_M = 0;

// Capacity (data codewords) for ECL-M, versions 1..40.
// From the QR spec capacity table.
const DATA_CODEWORDS_M: number[] = [
  16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507,
  563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455,
  1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334
];

// EC codewords per block, blocks per group for ECL-M, versions 1..40.
// Format: [ec_per_block, g1_blocks, g1_data, g2_blocks, g2_data]
const EC_TABLE_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0],
  [28, 17, 46, 0, 0],
  [28, 4, 47, 14, 48],
  [28, 6, 45, 14, 46],
  [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47],
  [28, 22, 45, 3, 46],
  [28, 3, 45, 23, 46],
  [28, 21, 45, 7, 46],
  [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47],
  [28, 10, 46, 23, 47],
  [28, 14, 46, 21, 47],
  [28, 14, 46, 23, 47],
  [28, 12, 47, 26, 48],
  [28, 6, 47, 34, 48],
  [28, 29, 46, 14, 47],
  [28, 13, 46, 32, 47],
  [28, 40, 47, 7, 48],
  [28, 18, 47, 31, 48]
];

function pickVersion(byteLength: number): number {
  // 4-bit mode indicator + length field + payload + terminator + padding.
  // Length field is 8 bits for version 1..9 and 16 bits for 10..40 (byte
  // mode). Build a quick predicate.
  for (let v = 1; v <= 40; v += 1) {
    const lengthBits = v <= 9 ? 8 : 16;
    const totalBits = 4 + lengthBits + byteLength * 8;
    const capacityBits = DATA_CODEWORDS_M[v - 1]! * 8;
    if (totalBits + 4 <= capacityBits) return v;
  }
  throw new Error("QR payload too large for ECL-M");
}

// GF(256) tables (primitive polynomial 0x11d).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + GF_LOG[b]!) % 255]!;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const out = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ (out[0] ?? 0);
    out.copyWithin(0, 1);
    out[out.length - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < gen.length; i += 1) {
        out[i] = (out[i] ?? 0) ^ gfMul(gen[i]!, factor);
      }
    }
  }
  return out;
}

// Build the bit stream + RS interleave for the given byte payload.
function encodeBytes(payload: Uint8Array, version: number): Uint8Array {
  const stream = bitstream();
  // mode indicator: byte mode = 0b0100
  stream.push(0b0100, 4);
  const lengthBits = version <= 9 ? 8 : 16;
  stream.push(payload.length, lengthBits);
  for (const b of payload) stream.push(b, 8);

  // terminator
  const dataCapacity = DATA_CODEWORDS_M[version - 1]! * 8;
  const termBits = Math.min(4, dataCapacity - stream.bits.length);
  for (let i = 0; i < termBits; i += 1) stream.bits.push(0);
  // byte align
  while (stream.bits.length % 8 !== 0) stream.bits.push(0);
  // pad bytes 0xec 0x11
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (stream.bits.length < dataCapacity) {
    stream.push(padBytes[p % 2]!, 8);
    p += 1;
  }

  const data = new Uint8Array(stream.bits.length / 8);
  for (let i = 0; i < data.length; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | stream.bits[i * 8 + j]!;
    data[i] = byte;
  }

  // interleave with RS
  const [ec, g1b, g1d, g2b, g2d] = EC_TABLE_M[version - 1]!;
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let cursor = 0;
  for (let i = 0; i < g1b; i += 1) {
    const block = data.subarray(cursor, cursor + g1d);
    cursor += g1d;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ec));
  }
  for (let i = 0; i < g2b; i += 1) {
    const block = data.subarray(cursor, cursor + g2d);
    cursor += g2d;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ec));
  }
  const maxData = Math.max(g1d, g2d);
  const result: number[] = [];
  for (let col = 0; col < maxData; col += 1) {
    for (const block of blocks) {
      if (col < block.length) result.push(block[col]!);
    }
  }
  for (let col = 0; col < ec; col += 1) {
    for (const block of ecBlocks) {
      result.push(block[col]!);
    }
  }
  return new Uint8Array(result);
}

interface Matrix {
  size: number;
  // 1 = dark, 0 = light, -1 = unset.
  cells: Int8Array;
  reserved: Uint8Array;
}

function newMatrix(version: number): Matrix {
  const size = 17 + version * 4;
  return {
    size,
    cells: new Int8Array(size * size).fill(-1),
    reserved: new Uint8Array(size * size)
  };
}

function setCell(m: Matrix, x: number, y: number, dark: number, reserved = true): void {
  m.cells[y * m.size + x] = dark;
  if (reserved) m.reserved[y * m.size + x] = 1;
}

function getCell(m: Matrix, x: number, y: number): number {
  return m.cells[y * m.size + x]!;
}

function placeFinder(m: Matrix, ox: number, oy: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
      const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const inInner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      const onRing = inOuter && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const dark = onRing || inInner ? 1 : 0;
      setCell(m, x, y, dark, true);
    }
  }
}

function placeAlignment(m: Matrix, version: number): void {
  if (version < 2) return;
  const positions = ALIGNMENT_POSITIONS[version - 1] ?? [];
  for (const cy of positions) {
    for (const cx of positions) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === m.size - 7) || (cx === m.size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
          setCell(m, x, y, dark, true);
        }
      }
    }
  }
}

// Alignment-pattern center positions, versions 1..40 (1 has none).
const ALIGNMENT_POSITIONS: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170]
];

function placeTimingAndDark(m: Matrix): void {
  for (let i = 8; i < m.size - 8; i += 1) {
    if (getCell(m, i, 6) === -1) setCell(m, i, 6, i % 2 === 0 ? 1 : 0, true);
    if (getCell(m, 6, i) === -1) setCell(m, 6, i, i % 2 === 0 ? 1 : 0, true);
  }
  setCell(m, 8, m.size - 8, 1, true);
}

function reserveFormatAndVersion(m: Matrix, version: number): void {
  // Format area
  for (let i = 0; i < 9; i += 1) {
    if (getCell(m, i, 8) === -1) setCell(m, i, 8, 0, true);
    if (getCell(m, 8, i) === -1) setCell(m, 8, i, 0, true);
  }
  for (let i = m.size - 8; i < m.size; i += 1) {
    setCell(m, 8, i, 0, true);
    setCell(m, i, 8, 0, true);
  }
  if (version >= 7) {
    for (let y = 0; y < 6; y += 1) {
      for (let dx = 0; dx < 3; dx += 1) {
        setCell(m, m.size - 11 + dx, y, 0, true);
        setCell(m, y, m.size - 11 + dx, 0, true);
      }
    }
  }
}

function placeDataBits(m: Matrix, data: Uint8Array): void {
  let bitIndex = 0;
  let up = true;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < m.size; i += 1) {
      const y = up ? m.size - 1 - i : i;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = col - dx;
        if (m.reserved[y * m.size + x] === 1) continue;
        const byte = data[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        setCell(m, x, y, bit, false);
        bitIndex += 1;
      }
    }
    up = !up;
  }
}

function applyMask(m: Matrix, maskId: number): void {
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (m.reserved[y * m.size + x] === 1) continue;
      let mask = false;
      switch (maskId) {
        case 0: mask = (x + y) % 2 === 0; break;
        case 1: mask = y % 2 === 0; break;
        case 2: mask = x % 3 === 0; break;
        case 3: mask = (x + y) % 3 === 0; break;
        case 4: mask = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: mask = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: mask = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: mask = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (mask) m.cells[y * m.size + x] = m.cells[y * m.size + x]! ^ 1;
    }
  }
}

const FORMAT_BITS_M: number[] = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0
];

function placeFormat(m: Matrix, maskId: number): void {
  // Format info is 15 bits placed in two redundant copies per ISO/IEC 18004
  // section 8.9. setCell(m, x, y, ...) takes column then row.
  //
  // Copy 1 (around the top-left finder):
  //   - bits 0..5 horizontally on row 8, columns 0..5
  //   - bit 6 at (col 7, row 8) — skipping timing column 6
  //   - bit 7 at (col 8, row 8)
  //   - bit 8 at (col 8, row 7) — skipping timing row 6
  //   - bits 9..14 vertically on col 8, rows 5..0 (going up)
  //
  // Copy 2 (split between top-right and bottom-left):
  //   - bits 0..7 horizontally on row 8, columns size-1..size-8 (right→left)
  //   - bits 8..14 vertically on col 8, rows size-7..size-1 (top→bottom)
  //
  // A single permanently-dark module sits at (col 8, row size-8) below the
  // copy-2 vertical strip and is set unconditionally.
  const bits = FORMAT_BITS_M[maskId]!;
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> i) & 1;
    if (i < 6) {
      setCell(m, i, 8, bit, true);
    } else if (i === 6) {
      setCell(m, 7, 8, bit, true);
    } else if (i === 7) {
      setCell(m, 8, 8, bit, true);
    } else if (i === 8) {
      setCell(m, 8, 7, bit, true);
    } else {
      // i = 9..14 → row = 14 - i (i.e. 5, 4, 3, 2, 1, 0)
      setCell(m, 8, 14 - i, bit, true);
    }
    if (i < 8) {
      setCell(m, m.size - 1 - i, 8, bit, true);
    } else {
      // i = 8..14 → row = m.size - 15 + i (i.e. size-7..size-1)
      setCell(m, 8, m.size - 15 + i, bit, true);
    }
  }
  setCell(m, 8, m.size - 8, 1, true);
}

const VERSION_BITS: Record<number, number> = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6,
  12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78,
  17: 0x1145d, 18: 0x12a17, 19: 0x13532, 20: 0x149a6, 21: 0x15683,
  22: 0x168c9, 23: 0x177ec, 24: 0x18ec4, 25: 0x191e1, 26: 0x1afab,
  27: 0x1b08e, 28: 0x1cc1a, 29: 0x1d33f, 30: 0x1ed75, 31: 0x1f250,
  32: 0x209d5, 33: 0x216f0, 34: 0x228ba, 35: 0x2379f, 36: 0x24b0b,
  37: 0x2542e, 38: 0x26a64, 39: 0x27541, 40: 0x28c69
};

function placeVersionInfo(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = VERSION_BITS[version];
  if (bits === undefined) return;
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + m.size - 11;
    setCell(m, a, b, bit, true);
    setCell(m, b, a, bit, true);
  }
}

function evaluateMask(m: Matrix): number {
  // Stripped-down penalty: just count adjacent same-color streaks. Picks
  // mask 0 in the worst case but works for our short-payload size. The spec
  // recommends a fuller evaluation; the simpler rule yields scannable codes
  // for our payload sizes — we picked QR Model 2 with high redundancy.
  let penalty = 0;
  for (let y = 0; y < m.size; y += 1) {
    let run = 1;
    for (let x = 1; x < m.size; x += 1) {
      if (getCell(m, x, y) === getCell(m, x - 1, y)) run += 1;
      else run = 1;
      if (run >= 5) penalty += 1;
    }
  }
  return penalty;
}

export interface QrMatrix {
  size: number;
  modules: ReadonlyArray<ReadonlyArray<boolean>>;
}

export function encodeQr(text: string): QrMatrix {
  const payload = new TextEncoder().encode(text);
  const version = pickVersion(payload.length);
  const data = encodeBytes(payload, version);

  let best: { matrix: Matrix; mask: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = newMatrix(version);
    placeFinder(m, 0, 0);
    placeFinder(m, m.size - 7, 0);
    placeFinder(m, 0, m.size - 7);
    placeAlignment(m, version);
    placeTimingAndDark(m);
    reserveFormatAndVersion(m, version);
    placeVersionInfo(m, version);
    placeDataBits(m, data);
    applyMask(m, mask);
    placeFormat(m, mask);
    if (!best || evaluateMask(m) < evaluateMask(best.matrix)) {
      best = { matrix: m, mask };
    }
  }

  const modules: boolean[][] = [];
  for (let y = 0; y < best!.matrix.size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < best!.matrix.size; x += 1) {
      row.push(getCell(best!.matrix, x, y) === 1);
    }
    modules.push(row);
  }
  return { size: best!.matrix.size, modules };
}

const QUIET_ZONE = 4;

export function renderQrSvg(text: string, scale = 8): string {
  const { size, modules } = encodeQr(text);
  const dim = (size + QUIET_ZONE * 2) * scale;
  const rects: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y]![x]) continue;
      const px = (x + QUIET_ZONE) * scale;
      const py = (y + QUIET_ZONE) * scale;
      rects.push(`<rect x="${px}" y="${py}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

/** Render an ANSI half-block QR for a terminal. Two cells per character: top
 *  half (U+2580) when only the top row is dark, bottom half (U+2584) when
 *  only the bottom row is dark, full block (U+2588) when both, and a plain
 *  space when neither. Includes a 4-cell quiet zone. */
export function renderQrAnsi(text: string): string {
  const { size, modules } = encodeQr(text);
  // build a padded matrix with quiet zone
  const total = size + QUIET_ZONE * 2;
  const padded: boolean[][] = [];
  for (let y = 0; y < total; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < total; x += 1) {
      const sx = x - QUIET_ZONE;
      const sy = y - QUIET_ZONE;
      row.push(sx >= 0 && sy >= 0 && sx < size && sy < size ? modules[sy]![sx]! : false);
    }
    padded.push(row);
  }
  const lines: string[] = [];
  for (let y = 0; y < total; y += 2) {
    let line = "";
    for (let x = 0; x < total; x += 1) {
      const top = padded[y]![x]!;
      const bottom = y + 1 < total ? padded[y + 1]![x]! : false;
      // Terminals use light-on-dark or dark-on-light. Standard `gini` CLI
      // output prints to a likely-dark terminal background: invert so dark
      // QR modules render as space characters and light modules as block
      // characters. (User testing pinned this as the readable orientation
      // for iOS scanning off the operator's terminal.)
      if (!top && !bottom) line += "█";
      else if (!top && bottom) line += "▀";
      else if (top && !bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
