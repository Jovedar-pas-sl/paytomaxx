import { describe, expect, it } from 'vitest';
import { checkCartaImage, sniffImage, webpSize } from './carta-image';
import { CHROME_WEBP_BASE64 } from '../../../test/support/chrome-webp';
import { JPEG_BYTES, PNG_BYTES, SVG_AS_WEBP, SVG_BYTES, webpFixture } from '../../../test/support/webp-fixture';

describe('carta-image: los bytes mandan, no el nombre', () => {
  it('reconoce WebP, PNG y JPEG por sus primeros bytes', () => {
    expect(sniffImage(webpFixture())).toBe('webp');
    expect(sniffImage(PNG_BYTES)).toBe('png');
    expect(sniffImage(JPEG_BYTES)).toBe('jpeg');
    expect(sniffImage(SVG_BYTES)).toBe('other');
    expect(sniffImage(Buffer.alloc(0))).toBe('other');
  });

  it.each(['VP8L', 'VP8 ', 'VP8X'] as const)('guarda un WebP %s cuadrado de 128 px y le saca la huella', (kind) => {
    const res = checkCartaImage(webpFixture({ kind }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.image).toMatchObject({ width: 128, height: 128 });
      expect(res.image.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('un WebP de verdad (el de canvas.toBlob de Chromium, 128×128) se acepta', () => {
    const res = checkCartaImage(Buffer.from(CHROME_WEBP_BASE64, 'base64'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.image).toMatchObject({ width: 128, height: 128 });
  });

  it('la misma imagen da la misma huella y otra distinta, otra', () => {
    const a = checkCartaImage(webpFixture());
    const b = checkCartaImage(webpFixture());
    const c = checkCartaImage(webpFixture({ bytes: 4096 }));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.image.contentHash).toBe(b.image.contentHash);
      expect(a.image.contentHash).not.toBe(c.image.contentHash);
    }
  });

  it('rechaza un SVG, también uno que se disfraza de WebP', () => {
    expect(checkCartaImage(SVG_BYTES).ok).toBe(false);
    expect(checkCartaImage(SVG_AS_WEBP).ok).toBe(false);
    const plain = checkCartaImage(SVG_BYTES);
    expect(!plain.ok && plain.message).toMatch(/WebP.*no SVG/);
  });

  it('un WebP con algo pegado detrás (el tamaño del RIFF no cuadra) no vale', () => {
    expect(checkCartaImage(Buffer.concat([webpFixture(), Buffer.from('<svg/>')])).ok).toBe(false);
  });

  it('PNG y JPEG se rechazan con un mensaje claro (no hay librería para convertirlos)', () => {
    for (const bytes of [PNG_BYTES, JPEG_BYTES]) {
      const res = checkCartaImage(bytes);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toMatch(/solo guarda WebP/);
    }
  });

  it('el tamaño: 64 KB sí, 64 KB + 1 no, vacío no', () => {
    expect(checkCartaImage(webpFixture({ bytes: 64 * 1024 })).ok).toBe(true);
    const big = checkCartaImage(webpFixture({ bytes: 64 * 1024 + 1 }));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.message).toMatch(/máximo es 64 KB/);
    expect(checkCartaImage(Buffer.alloc(0)).ok).toBe(false);
  });

  it('las medidas: cuadrada y de 16 a 128 px', () => {
    expect(checkCartaImage(webpFixture({ width: 16, height: 16 })).ok).toBe(true);
    expect(checkCartaImage(webpFixture({ width: 129, height: 129 })).ok).toBe(false);
    expect(checkCartaImage(webpFixture({ width: 15, height: 15 })).ok).toBe(false);
    const wide = checkCartaImage(webpFixture({ width: 128, height: 64 }));
    expect(!wide.ok && wide.message).toMatch(/cuadrada/);
    expect(checkCartaImage(webpFixture({ kind: 'VP8X', width: 4000, height: 4000 })).ok).toBe(false);
  });

  it('un WebP animado no se guarda', () => {
    expect(webpSize(webpFixture({ kind: 'VP8X', animated: true }))).toBeNull();
    expect(checkCartaImage(webpFixture({ kind: 'VP8X', animated: true })).ok).toBe(false);
  });
});
