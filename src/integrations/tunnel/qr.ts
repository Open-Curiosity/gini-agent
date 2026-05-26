// QR code generation for the tunnel landing URL.
//
// Backed by the `qrcode` npm library — battle-tested against every major
// scanner including iOS Camera, which is the strictest about quiet-zone
// width, format-info placement, and mask selection. Hand-rolled encoders
// frequently fail iOS Camera's format-info validation even when more
// lenient decoders accept them, so we depend on a library rather than
// reimplement the spec. The library returns a bit matrix; the SVG and
// ANSI renderers below paint it.
//
// Error correction level M is chosen over L because phone cameras need
// the extra redundancy when the scan happens through a screen at an
// angle. The default quiet-zone padding is 4 modules per ISO/IEC 18004
// §6.3.8 — iOS Camera silently refuses anything smaller.

import QRCode from "qrcode";

export type QrMatrix = readonly (readonly boolean[])[];

/**
 * Encode `payload` as a QR matrix at error correction level M. The
 * library picks the smallest fitting version automatically. Throws when
 * the payload is too large for any QR version (>2953 bytes at ECL=M).
 */
export function encodeQr(payload: string): QrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const matrix: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = new Array(size);
    for (let x = 0; x < size; x += 1) {
      row[x] = data[y * size + x] === 1;
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Render `matrix` as ANSI-art half-height block characters. Each terminal
 * row covers two QR rows so the aspect ratio reads as square. The default
 * padding of 2 is enough for terminal display — copy-paste readability
 * matters more than scan reliability in a terminal.
 */
export function renderQrAnsi(matrix: QrMatrix, options: { padding?: number } = {}): string {
  const padding = options.padding ?? 2;
  const size = matrix.length;
  const total = size + padding * 2;
  const isOn = (x: number, y: number): boolean => {
    if (x < padding || y < padding || x >= size + padding || y >= size + padding) return false;
    return Boolean(matrix[y - padding]![x - padding]);
  };
  const out: string[] = [];
  for (let row = 0; row < total; row += 2) {
    let line = "";
    for (let col = 0; col < total; col += 1) {
      const top = isOn(col, row);
      const bottom = row + 1 < total ? isOn(col, row + 1) : false;
      const ch = top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
      line += ch;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Render `matrix` as an SVG document. The default 4-module quiet zone
 * matches ISO/IEC 18004 §6.3.8 — anything smaller and iOS Camera
 * refuses to lock on. Painted as a single black path (one move per dark
 * module) so the SVG stays small even at high module counts.
 */
export function renderQrSvg(
  matrix: QrMatrix,
  options: { moduleSize?: number; padding?: number } = {}
): string {
  const moduleSize = options.moduleSize ?? 8;
  const padding = options.padding ?? 4;
  const size = matrix.length;
  const dim = (size + padding * 2) * moduleSize;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}">`);
  parts.push(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!matrix[y]![x]) continue;
      const px = (x + padding) * moduleSize;
      const py = (y + padding) * moduleSize;
      parts.push(`<rect x="${px}" y="${py}" width="${moduleSize}" height="${moduleSize}" fill="#000000"/>`);
    }
  }
  parts.push(`</svg>`);
  return parts.join("");
}
