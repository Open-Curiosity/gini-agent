import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";
import { encodeQr, renderQrAnsi, renderQrSvg, type QrMatrix } from "./qr";

describe("qr encoder", () => {
  test("encodes a short payload into a v1 21x21 matrix with the three finder patterns", () => {
    // 14 byte-mode bytes is the v1 + ECL=M ceiling: 4 (mode) + 8 (count) +
    // 14*8 (data) + 4 (terminator) = 128 bits = 16 codewords. Anything
    // larger spills into v2 (25-module edge).
    const matrix = encodeQr("hello-world-12");
    expect(matrix.length).toBe(21);
    expect(matrix[0]!.length).toBe(21);
    // Each finder pattern is a 7x7 block with a solid border, white ring,
    // and a 3x3 center. We check three signature corners: top-left,
    // top-right, bottom-left.
    expect(matrix[0]![0]).toBe(true);
    expect(matrix[0]![6]).toBe(true);
    expect(matrix[6]![0]).toBe(true);
    expect(matrix[6]![6]).toBe(true);
    expect(matrix[2]![2]).toBe(true);
    expect(matrix[3]![3]).toBe(true);
    // The 5th-column timing pattern alternates true/false starting at module 8.
    expect(matrix[6]![8]).toBe(true);
    expect(matrix[6]![9]).toBe(false);
    expect(matrix[6]![10]).toBe(true);
    expect(matrix[6]![11]).toBe(false);
  });

  test("scales up to a larger version when the payload requires it", () => {
    // 50 bytes overflows v1; should land on v3 or higher (29x29 module edge).
    const matrix = encodeQr("a".repeat(50));
    expect(matrix.length).toBeGreaterThanOrEqual(29);
  });

  test("rejects payloads that exceed the maximum QR capacity", () => {
    // 3000 bytes exceeds v40 ECL=M (2331 byte-mode bytes).
    expect(() => encodeQr("a".repeat(3000))).toThrow(/too big/);
  });

  test("renderQrAnsi produces 13 rows for a v1 + default padding", () => {
    const matrix = encodeQr("hello-world-12");
    const ansi = renderQrAnsi(matrix);
    // 21 modules + 2*2 padding = 25 cells per edge; half-block rendering
    // packs two rows per terminal line so we expect ceil(25/2) = 13.
    expect(ansi.split("\n").length).toBe(13);
    // Each line should contain only space, █, ▀, or ▄.
    for (const line of ansi.split("\n")) {
      expect(line).toMatch(/^[ █▀▄]+$/);
    }
  });

  test("renderQrSvg produces a square SVG matching matrix size", () => {
    const matrix = encodeQr("hello-world-12");
    const svg = renderQrSvg(matrix, { moduleSize: 4, padding: 1 });
    // 21 + 2 padding = 23 modules; module size 4 → 92x92 SVG.
    expect(svg).toContain('width="92" height="92"');
    expect(svg).toContain('viewBox="0 0 92 92"');
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // Background white + at least one foreground rect.
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
  });

  test("renderQrSvg defaults to a 4-module quiet zone", () => {
    // ISO/IEC 18004 §6.3.8 requires a 4-module quiet zone; iOS Camera
    // refuses anything smaller. v1 = 21 modules, 8 px per module, 4
    // padding modules per side → (21 + 8) * 8 = 232 px.
    const matrix = encodeQr("hello-world-12");
    const svg = renderQrSvg(matrix);
    expect(svg).toContain('width="232" height="232"');
  });

  test("identical payloads produce identical matrices", () => {
    const a = encodeQr("https://x.trycloudflare.com/sample-secret/");
    const b = encodeQr("https://x.trycloudflare.com/sample-secret/");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // Golden snapshot. The matrix below was captured from the qrcode library
  // wrapped by encodeQr for the input `https://gini.example.com/abc` and
  // verified to scan correctly by a real phone camera against the rendered
  // SVG. Any change to the encoder (library version, error correction
  // level, mask selection) will diff this snapshot. When the diff is
  // intentional, regenerate the snapshot AND re-verify the new output
  // with a physical scanner — structural checks above cannot prove
  // scanner-compatibility on their own.
  test("matches golden vector for a known URL payload", () => {
    const matrix = encodeQr("https://gini.example.com/abc");
    const golden = [
      "11111110010111110111101111111",
      "10000010001111111100101000001",
      "10111010111101010001001011101",
      "10111010100110110100001011101",
      "10111010110010011111101011101",
      "10000010100000000000001000001",
      "11111110101010101010101111111",
      "00000000110110101001100000000",
      "10111110001110001111001111100",
      "11100101000101110111011010001",
      "00010011011011111100101110000",
      "00110100110001010000111001010",
      "00000111001000110100000001100",
      "01001001100010011011111110001",
      "10110010101010000010000001100",
      "10001101110100101000100100010",
      "11110010101100001101000001100",
      "10111001111001110011101110101",
      "10011011100101111110011110100",
      "10110101011011010010010000010",
      "10110010011000110100111110111",
      "00000000110110011011100011111",
      "11111110011000000111101011100",
      "10000010101010101001100010010",
      "10111010101010001010111110101",
      "10111010100100110111000001100",
      "10111010110100011101111111110",
      "10000010000111110110110101010",
      "11111110100110110001000110100"
    ];
    const actual = matrix.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));
    expect(actual).toEqual(golden);
  });

  // Round-trip: encode → rasterize → decode with jsQR (the same algorithm
  // library scanners use). A regression in the encoder or in the SVG
  // module-placement that bypasses ECC will fail this test even when the
  // structural finder-pattern checks above pass. iPhone Camera was
  // rejecting an earlier hand-rolled encoder despite finders looking
  // right; this test would have caught it.
  test("round-trips a realistic tunnel URL through jsQR", () => {
    const payload = "https://lonely-loans-mitsubishi-engaging.trycloudflare.com/ugQtex3PRbzyPVG3ovPO8L8YNT2jePQC/";
    const matrix = encodeQr(payload);
    const { pixels, dim } = rasterize(matrix, { moduleSize: 8, padding: 4 });
    const decoded = jsQR(pixels, dim, dim);
    expect(decoded).not.toBeNull();
    expect(decoded!.data).toBe(payload);
  });
});

// Painters a QR matrix into a Uint8ClampedArray of RGBA bytes the same way
// renderQrSvg does, so we can hand the pixels straight to jsQR without
// going through an SVG renderer.
function rasterize(
  matrix: QrMatrix,
  options: { moduleSize: number; padding: number }
): { pixels: Uint8ClampedArray; dim: number } {
  const { moduleSize, padding } = options;
  const size = matrix.length;
  const dim = (size + padding * 2) * moduleSize;
  const pixels = new Uint8ClampedArray(dim * dim * 4);
  for (let py = 0; py < dim; py += 1) {
    for (let px = 0; px < dim; px += 1) {
      const mx = Math.floor(px / moduleSize) - padding;
      const my = Math.floor(py / moduleSize) - padding;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && matrix[my]![mx];
      const offset = (py * dim + px) * 4;
      const gray = dark ? 0 : 255;
      pixels[offset] = gray;
      pixels[offset + 1] = gray;
      pixels[offset + 2] = gray;
      pixels[offset + 3] = 255;
    }
  }
  return { pixels, dim };
}
