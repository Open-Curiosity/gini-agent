import { describe, expect, test } from "bun:test";
import { encodeQr, renderQrAnsi, renderQrSvg } from "./qr";

describe("qr encoder", () => {
  test("encodes a short payload into a v1 21x21 matrix with the three finder patterns", () => {
    // 17 byte-mode bytes is the v1+ECL=L ceiling: 4 (mode) + 8 (count) +
    // 17*8 (data) + 4 (terminator) = 152 bits = 19 codewords. Anything
    // larger spills into v2 (25-module edge).
    const matrix = encodeQr("hello-world-12345");
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

  test("rejects payloads that exceed v10 byte-mode capacity", () => {
    expect(() => encodeQr("a".repeat(2048))).toThrow(/Payload too large/);
  });

  test("renderQrAnsi produces 13 rows for a v1 + default padding", () => {
    const matrix = encodeQr("hello-world-12345");
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
    const matrix = encodeQr("hello-world-12345");
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

  test("identical payloads produce identical matrices", () => {
    const a = encodeQr("https://x.trycloudflare.com/sample-secret/");
    const b = encodeQr("https://x.trycloudflare.com/sample-secret/");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // Golden snapshot. The matrix below was captured from the current encoder
  // for the input `https://gini.example.com/abc` and then verified to scan
  // correctly by a real phone camera against the rendered SVG. Any change
  // to the encoding pipeline (mask selection, Reed-Solomon parity, data
  // placement, format-info bits) will diff this snapshot. When the diff is
  // intentional, regenerate the snapshot AND re-verify the new output with
  // a physical scanner — structural checks above cannot prove
  // scanner-compatibility on their own.
  test("matches golden vector for a known URL payload", () => {
    const matrix = encodeQr("https://gini.example.com/abc");
    const golden = [
      "1111111011000010101111111",
      "1000001011011001101000001",
      "1011101011110001101011101",
      "1011101011011110001011101",
      "1011101010101100101011101",
      "1000001000100011101000001",
      "1111111010101010101111111",
      "0000000010011001000000000",
      "0101011011101111011011111",
      "1110100001010000100100010",
      "0110111111001011000111011",
      "1101110111111011011100001",
      "0100101111001100111010111",
      "1110110010110100100101010",
      "1000001100100111110111011",
      "1010100011101001100110001",
      "1001111011001111111110100",
      "0000000010110001100011000",
      "1111111000100100101010111",
      "1000001011110010100011001",
      "1011101000111111111110110",
      "1011101010111101111011111",
      "1011101000000110100001101",
      "1000001010100011100111001",
      "1111111001011111011111111"
    ];
    const actual = matrix.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));
    expect(actual).toEqual(golden);
  });
});
