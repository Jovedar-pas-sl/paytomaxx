/**
 * WebP de mentira pero con la cabecera buena (RIFF + VP8L, VP8 o VP8X): vale
 * para probar la validación de bytes y medidas sin una librería de imágenes.
 */
export function webpFixture(
  opts: { width?: number; height?: number; kind?: 'VP8L' | 'VP8 ' | 'VP8X'; bytes?: number; animated?: boolean; fill?: number } = {},
): Buffer {
  const { width = 128, height = 128, kind = 'VP8L', bytes = 2048, animated = false, fill = 0x55 } = opts;
  const body = Buffer.alloc(Math.max(bytes, 40) - 12, fill);
  body.write(kind, 0, 'latin1');
  body.writeUInt32LE(body.length - 8, 4);
  if (kind === 'VP8L') {
    body[8] = 0x2f;
    body.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 9);
  } else if (kind === 'VP8 ') {
    body[8 + 3] = 0x9d;
    body[8 + 4] = 0x01;
    body[8 + 5] = 0x2a;
    body.writeUInt16LE(width, 8 + 6);
    body.writeUInt16LE(height, 8 + 8);
  } else {
    body[8] = animated ? 0x02 : 0x00;
    body.writeUIntLE(width - 1, 12, 3);
    body.writeUIntLE(height - 1, 15, 3);
  }
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
export const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>');
/** Un SVG que empieza como un WebP (RIFF…WEBP) para colarse. */
export const SVG_AS_WEBP = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8L', 'latin1'), SVG_BYTES]);

/** PNG con la cabecera buena (firma + IHDR) y relleno: vale para probar bytes y medidas. */
export function pngFixture(opts: { width?: number; height?: number; bytes?: number } = {}): Buffer {
  const { width = 128, height = 128, bytes = 2048 } = opts;
  const head = Buffer.alloc(8 + 4 + 4 + 13);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, Buffer.alloc(Math.max(bytes - head.length, 0), 0x33)]);
}
