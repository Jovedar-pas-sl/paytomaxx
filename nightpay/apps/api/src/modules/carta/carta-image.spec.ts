import { describe, expect, it } from 'vitest';
import { checkCartaImage, sniffImage, webpSize } from './carta-image';
import { CHROME_WEBP_BASE64 } from '../../../test/support/chrome-webp';
import { JPEG_BYTES, PNG_BYTES, pngFixture, SVG_AS_WEBP, SVG_BYTES, webpFixture } from '../../../test/support/webp-fixture';

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

  it('un PNG válido (firma + IHDR cuadrado) se acepta tal cual, con su tipo', () => {
    const data = pngFixture();
    const res = checkCartaImage(data);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.image).toMatchObject({ contentType: 'image/png', width: 128, height: 128 });
      expect(res.image.data).toBe(data);
    }
    const webp = checkCartaImage(webpFixture());
    expect(webp.ok && webp.image.contentType).toBe('image/webp');
  });

  it('un PNG mayor de 128 px, no cuadrado, menor de 16 o de más de 64 KB se rechaza', () => {
    expect(checkCartaImage(pngFixture({ width: 256, height: 256 })).ok).toBe(false);
    expect(checkCartaImage(pngFixture({ width: 129, height: 129 })).ok).toBe(false);
    expect(checkCartaImage(pngFixture({ width: 8, height: 8 })).ok).toBe(false);
    const wide = checkCartaImage(pngFixture({ width: 128, height: 64 }));
    expect(!wide.ok && wide.message).toMatch(/cuadrada/);
    expect(checkCartaImage(pngFixture({ bytes: 64 * 1024 + 1 })).ok).toBe(false);
    expect(checkCartaImage(pngFixture({ bytes: 64 * 1024 })).ok).toBe(true);
  });

  it('una firma PNG sin chunk IHDR no vale, y un JPEG tampoco (mensaje claro)', () => {
    expect(checkCartaImage(PNG_BYTES).ok).toBe(false);
    const jpeg = checkCartaImage(JPEG_BYTES);
    expect(!jpeg.ok && jpeg.message).toMatch(/WebP o PNG/);
  });

  it('un SVG, aunque se llame .png, no pasa (no empieza como PNG)', () => {
    expect(checkCartaImage(SVG_BYTES).ok).toBe(false);
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
