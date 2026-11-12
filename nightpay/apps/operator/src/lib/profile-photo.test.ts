import { describe, expect, it } from 'vitest';
import { encodeProfilePhoto, PHOTO_MAX_BYTES, PHOTO_OUT_SIDE, photoPlan, type PhotoEncoder } from '../../../../packages/ui/src/lib/profile-photo';

describe('photoPlan: recorte cuadrado al centro y reducción a 256', () => {
  it('una foto apaisada se recorta a lo alto, centrada, y se reduce a 256', () => {
    expect(photoPlan(4000, 3000)).toEqual({ sx: 500, sy: 0, side: 3000, out: PHOTO_OUT_SIDE });
  });
  it('una foto vertical se recorta a lo ancho, centrada', () => {
    expect(photoPlan(3000, 4000)).toEqual({ sx: 0, sy: 500, side: 3000, out: 256 });
  });
  it('una cuadrada no se recorta', () => {
    expect(photoPlan(1024, 1024)).toEqual({ sx: 0, sy: 0, side: 1024, out: 256 });
  });
  it('con medidas impares el recorte cae en enteros', () => {
    const p = photoPlan(1001, 600);
    expect(p).toEqual({ sx: 200, sy: 0, side: 600, out: 256 });
    expect(Number.isInteger(p?.sx)).toBe(true);
  });
  it('una foto pequeña no se agranda: sale a su lado', () => {
    expect(photoPlan(200, 120)).toMatchObject({ side: 120, out: 120 });
    expect(photoPlan(100, 100)).toMatchObject({ out: 100 });
    expect(photoPlan(64, 40)).toMatchObject({ out: 40 });
  });
  it('rechaza lo que no sirve: sin medidas o con un lado menor de 32 px', () => {
    expect(photoPlan(0, 100)).toBeNull();
    expect(photoPlan(500, 31)).toBeNull();
    expect(photoPlan(Number.NaN, 500)).toBeNull();
  });
});

const blob = (type: string, size: number) => ({ type, size }) as unknown as Blob;

describe('encodeProfilePhoto: WebP, y si no, JPEG; siempre por debajo de 150 KB', () => {
  it('coge el WebP a la mejor calidad si cabe', async () => {
    const calls: Array<[string, number]> = [];
    const encode: PhotoEncoder = async (type, q) => {
      calls.push([type, q]);
      return blob(type, 20_000);
    };
    const r = await encodeProfilePhoto(encode);
    expect(r?.type).toBe('image/webp');
    expect(calls).toEqual([['image/webp', 0.85]]);
  });

  it('baja la calidad hasta que cabe', async () => {
    const encode: PhotoEncoder = async (type, q) => blob(type, q > 0.7 ? PHOTO_MAX_BYTES + 1 : 90_000);
    const r = await encodeProfilePhoto(encode);
    expect(r).toMatchObject({ type: 'image/webp', quality: 0.65 });
  });

  it('un navegador que no codifica WebP (devuelve PNG) pasa a JPEG', async () => {
    const encode: PhotoEncoder = async (type) => blob(type === 'image/webp' ? 'image/png' : type, 40_000);
    const r = await encodeProfilePhoto(encode);
    expect(r?.type).toBe('image/jpeg');
  });

  it('si el codificador no devuelve nada o nada cabe, null', async () => {
    expect(await encodeProfilePhoto(async () => null)).toBeNull();
    expect(await encodeProfilePhoto(async (type) => blob(type, PHOTO_MAX_BYTES * 2))).toBeNull();
  });

  it('150 KB justos caben; un byte más no', async () => {
    expect((await encodeProfilePhoto(async (t) => blob(t, PHOTO_MAX_BYTES)))?.blob.size).toBe(PHOTO_MAX_BYTES);
    expect(await encodeProfilePhoto(async (t) => blob(t, PHOTO_MAX_BYTES + 1))).toBeNull();
  });
});
