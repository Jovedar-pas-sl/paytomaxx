import { describe, expect, it } from 'vitest';
import { PROFILE_PHOTO_MAX_BYTES } from '@nightpay/contracts';
import { checkProfilePhoto, jpegSize } from './profile-image';
import { JPEG_BYTES, jpegFixture, pngFixture, SVG_AS_WEBP, SVG_BYTES, webpFixture } from '../../../test/support/webp-fixture';

describe('checkProfilePhoto', () => {
  it('admite un WebP cuadrado de 256 y lo deja tal cual, con su huella', () => {
    const bytes = webpFixture({ width: 256, height: 256, bytes: 8000 });
    const r = checkProfilePhoto(bytes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.contentType).toBe('image/webp');
      expect(r.image.width).toBe(256);
      expect(r.image.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.image.data.equals(bytes)).toBe(true);
    }
  });

  it('admite un JPEG cuadrado de 256', () => {
    const r = checkProfilePhoto(jpegFixture({ width: 256, height: 256 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.contentType).toBe('image/jpeg');
  });

  it('lee las medidas del JPEG (base y progresivo) y devuelve null si la cabecera no cuadra', () => {
    expect(jpegSize(jpegFixture({ width: 200, height: 100 }))).toEqual({ width: 200, height: 100 });
    expect(jpegSize(jpegFixture({ width: 64, height: 64, progressive: true }))).toEqual({ width: 64, height: 64 });
    expect(jpegSize(JPEG_BYTES)).toBeNull();
  });

  it('rechaza vacío, enorme, PNG, SVG, SVG disfrazado de WebP y JPEG sin medidas', () => {
    expect(checkProfilePhoto(Buffer.alloc(0)).ok).toBe(false);
    const huge = checkProfilePhoto(webpFixture({ width: 256, height: 256, bytes: PROFILE_PHOTO_MAX_BYTES + 1 }));
    expect(huge.ok).toBe(false);
    expect(checkProfilePhoto(pngFixture({ width: 256, height: 256 })).ok).toBe(false);
    expect(checkProfilePhoto(SVG_BYTES).ok).toBe(false);
    expect(checkProfilePhoto(SVG_AS_WEBP).ok).toBe(false);
    expect(checkProfilePhoto(JPEG_BYTES).ok).toBe(false);
  });

  it('rechaza una foto que no es cuadrada, muy pequeña o mayor de 256', () => {
    expect(checkProfilePhoto(webpFixture({ width: 256, height: 128 })).ok).toBe(false);
    expect(checkProfilePhoto(jpegFixture({ width: 16, height: 16 })).ok).toBe(false);
    expect(checkProfilePhoto(webpFixture({ width: 512, height: 512 })).ok).toBe(false);
    expect(checkProfilePhoto(jpegFixture({ width: 300, height: 300 })).ok).toBe(false);
  });

  it('rechaza un WebP animado', () => {
    expect(checkProfilePhoto(webpFixture({ kind: 'VP8X', width: 256, height: 256, animated: true })).ok).toBe(false);
  });
});
