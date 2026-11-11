import { describe, expect, it } from 'vitest';
import { blobToBase64, encodeUnderLimit, ImageReduceError, isAcceptedImage, squareCrop, WEBP_QUALITIES } from './carta-image-resize';

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
  it('un navegador que no codifica WebP (devuelve PNG) da un mensaje claro', async () => {
    await expect(encodeUnderLimit(async () => new Blob([new Uint8Array(10)], { type: 'image/png' }))).rejects.toThrow(/WebP/);
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
