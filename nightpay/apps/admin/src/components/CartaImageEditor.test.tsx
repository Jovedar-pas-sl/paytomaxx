import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CartaImageEditor, CartaThumb, cartaImageUrl } from './CartaImageEditor';
import type { ServiceItem } from '@/lib/api';

const base: ServiceItem = { id: 'i1', name: 'Gin tonic', durationMin: null, priceCents: 1200, category: 'VENUE_BAR', active: true, sortOrder: 0, icon: null, imageUrl: null };
const HASH = 'a'.repeat(64);
const withImage: ServiceItem = { ...base, imageUrl: `/v1/services/0b0e5d3e-6a56-4a3e-9d2f-0d6a8c0c9a11/image/${HASH}` };

describe('CartaThumb: la imagen o el icono del producto', () => {
  it('sin imagen, el icono (el de su sección si no eligió otro)', () => {
    const html = renderToStaticMarkup(<CartaThumb item={base} />);
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });
  it('con imagen, <img> con el nombre como alt y la dirección del API', () => {
    const html = renderToStaticMarkup(<CartaThumb item={withImage} />);
    expect(html).toContain('alt="Gin tonic"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`/image/${HASH}`);
  });
  it('cartaImageUrl: null sin imagen', () => {
    expect(cartaImageUrl(base)).toBeNull();
    expect(cartaImageUrl(withImage)).toMatch(/^https?:\/\/.+\/v1\/services\/.+\/image\//);
  });
});

describe('CartaImageEditor', () => {
  it('ofrece elegir icono y subir logo o foto; «Quitar imagen» solo si hay imagen', () => {
    const none = renderToStaticMarkup(<CartaImageEditor item={base} onChanged={vi.fn()} />);
    expect(none).toContain('Elegir icono');
    expect(none).toContain('Subir logo o foto');
    expect(none).not.toContain('Quitar imagen');
    const some = renderToStaticMarkup(<CartaImageEditor item={withImage} onChanged={vi.fn()} />);
    expect(some).toContain('Quitar imagen');
  });
  it('el selector de archivo solo acepta PNG, JPG y WebP (no SVG)', () => {
    const html = renderToStaticMarkup(<CartaImageEditor item={base} onChanged={vi.fn()} />);
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).not.toContain('svg+xml');
  });
});
