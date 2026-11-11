import { describe, expect, it } from 'vitest';
import { blobToBase64, encodeCartaImage, encodeUnderLimit, ImageReduceError, isAcceptedImage, squareCrop, WEBP_QUALITIES } from './carta-image-resize';

const webp = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/webp' });

describe('squareCrop: el cuadrado central', () => {
  it('una foto apaisada se recorta por los lados', () => {
    expect(squareCrop(400, 200)).toEqual({ sx: 100, sy: 0, side: 200 });
  });
  it('una vertical, por arriba y abajo', () => {
    expect(squareCrop(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
  });
  it('una cuadrada se queda igual', () => {
    expect(squareCrop(128, 128)).toEqual({ sx: 0, sy: 0, side: 128 });
  });
  it('con medidas impares, enteras', () => {
    const c = squareCrop(101, 50);
    expect(Number.isInteger(c.sx)).toBe(true);
    expect(c.side).toBe(50);
  });
});

describe('isAcceptedImage: nunca SVG', () => {
  it('PNG, JPEG y WebP sí; SVG, GIF y lo demás no', () => {
    expect(['image/png', 'image/jpeg', 'image/webp'].every((type) => isAcceptedImage({ type }))).toBe(true);
    expect(['image/svg+xml', 'image/gif', 'text/html', ''].some((type) => isAcceptedImage({ type }))).toBe(false);
  });
});

describe('encodeUnderLimit: baja la calidad hasta que cabe', () => {
  it('con la primera calidad que cabe, esa', async () => {
    const tried: number[] = [];
    const blob = await encodeUnderLimit(async (q) => (tried.push(q), webp(q > 0.8 ? 30_000 : 15_000)), 20 * 1024);
    expect(blob.size).toBe(15_000);
    expect(tried).toEqual([0.92, 0.85, 0.75]);
  });
  it('si ni con la más baja cabe, error claro', async () => {
    await expect(encodeUnderLimit(async () => webp(40_000), 20 * 1024)).rejects.toThrow(/sigue pesando demasiado/);
  });
  it('si no se pudo codificar, error', async () => {
    await expect(encodeUnderLimit(async () => null)).rejects.toBeInstanceOf(ImageReduceError);
  });
  it('prueba de más a menos calidad', () => {
    expect([...WEBP_QUALITIES]).toEqual([...WEBP_QUALITIES].sort((a, b) => b - a));
  });
});

describe('blobToBase64', () => {
  it('da el base64 de los bytes, también de un archivo grande (por trozos)', async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(await blobToBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });
});

const png = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });

describe('encodeCartaImage: WebP, o PNG en Safari', () => {
  it('con WebP, baja la calidad como siempre y no toca el PNG', async () => {
    const sides: number[] = [];
    const blob = await encodeCartaImage(async (q) => webp(q > 0.8 ? 30_000 : 15_000), async (s) => (sides.push(s), png(1)));
    expect(blob.type).toBe('image/webp');
    expect(sides).toEqual([]);
  });
  it('un navegador que devuelve PNG (Safari) manda PNG, bajando el lado hasta que cabe en ≈ 20 KB', async () => {
    const sides: number[] = [];
    const blob = await encodeCartaImage(
      async () => png(50_000),
      async (side) => (sides.push(side), png(side * 200)), // 128 → 25,6 KB; 112 → 22,4 KB; 96 → 19,2 KB
    );
    expect(blob.type).toBe('image/png');
    expect(sides).toEqual([128, 112, 96]);
    expect(blob.size).toBe(96 * 200);
  });
  it('si ni a 48 px cabe en 20 KB pero sí en 64 KB, manda el más pequeño; si ni eso, error', async () => {
    const ok = await encodeCartaImage(async () => png(1), async (side) => png(30_000 + side));
    expect(ok.size).toBe(30_048);
    await expect(encodeCartaImage(async () => png(1), async () => png(70_000))).rejects.toThrow(/demasiado/);
  });
  it('un tipo que no es WebP ni PNG (JPEG) o sin resultado, error; ya no pide otro navegador', async () => {
    await expect(encodeCartaImage(async () => new Blob([new Uint8Array(5)], { type: 'image/jpeg' }), async () => null)).rejects.toBeInstanceOf(ImageReduceError);
    await expect(encodeCartaImage(async () => null, async () => null)).rejects.toBeInstanceOf(ImageReduceError);
    await expect(encodeCartaImage(async () => new Blob([], { type: 'image/jpeg' }), async () => null)).rejects.not.toThrow(/Chrome/);
  });
});
