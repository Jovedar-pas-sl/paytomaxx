import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CARTA_ICON_CODES, cartaIconOf, CARTA_ICONS } from '@nightpay/contracts';
import { CARTA_ICON_PATHS, CartaItemIcon } from '@nightpay/ui';
import { ItemThumbView } from '../components/cobrar/ItemThumbView';
import { cartaImageSrc, thumbKind, THUMB_SIZE } from './carta-thumb';

const ID = '0b0e5d3e-6a56-4a3e-9d2f-0d6a8c0c9a11';
const HASH = 'a'.repeat(64);
const PATH = `/v1/services/${ID}/image/${HASH}`;

describe('cartaImageSrc: de dónde se pide la imagen', () => {
  it('antepone el API a la ruta versionada', () => {
    expect(cartaImageSrc('https://api.local.test', PATH)).toBe(`https://api.local.test${PATH}`);
    expect(cartaImageSrc('https://api.local.test/', PATH)).toBe(`https://api.local.test${PATH}`);
  });
  it('sin imagen, o con una ruta que no es de una imagen de la carta, null (nada raro llega al <img>)', () => {
    for (const bad of [null, undefined, '', 'https://otro.example/x.webp', 'javascript:alert(1)', '/v1/services/x/image/y', `${PATH}?x=1`, `/v1/payments/${ID}/image/${HASH}`]) {
      expect(cartaImageSrc('https://api.local.test', bad)).toBeNull();
    }
  });
});

describe('thumbKind: imagen o icono', () => {
  it('con imagen que carga, la imagen; sin imagen, o si esa dirección falló, el icono', () => {
    expect(thumbKind('https://a/x', null)).toBe('image');
    expect(thumbKind(null, null)).toBe('icon');
    expect(thumbKind('https://a/x', 'https://a/x')).toBe('icon');
  });
  it('si la imagen cambia (otra dirección), se vuelve a intentar', () => {
    expect(thumbKind('https://a/nueva', 'https://a/vieja')).toBe('image');
  });
});

describe('la loseta: ItemThumbView', () => {
  const item = { name: 'Gin tonic', category: 'VENUE_BAR', icon: null as string | null };

  it('con imagen: <img> con alt del producto, lazy, width y height', () => {
    const html = renderToStaticMarkup(createElement(ItemThumbView, { item, src: `https://api.local.test${PATH}` }));
    expect(html).toContain('data-thumb="image"');
    expect(html).toContain('alt="Gin tonic"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`width="${THUMB_SIZE}"`);
    expect(html).toContain(`height="${THUMB_SIZE}"`);
    expect(html).toContain(`src="https://api.local.test${PATH}"`);
    expect(html).not.toContain('<svg');
  });

  it('sin imagen: el icono del producto, y si no tiene, el de su sección', () => {
    const own = renderToStaticMarkup(createElement(ItemThumbView, { item: { ...item, icon: 'cerveza' }, src: null }));
    expect(own).toContain('data-thumb="icon"');
    expect(own).not.toContain('<img');
    expect(own).toContain(CARTA_ICON_PATHS.cerveza[0]);
    const byDefault = renderToStaticMarkup(createElement(ItemThumbView, { item, src: null }));
    expect(byDefault).toContain(CARTA_ICON_PATHS.copa[0]);
    const room = renderToStaticMarkup(createElement(ItemThumbView, { item: { name: 'Habitación', category: 'VENUE_ROOM', icon: null }, src: null }));
    expect(room).toContain(CARTA_ICON_PATHS.habitacion[0]);
  });

  it('con error de imagen: sale el icono (y no queda <img> rota)', () => {
    const src = `https://api.local.test${PATH}`;
    const html = renderToStaticMarkup(createElement(ItemThumbView, { item: { ...item, icon: 'gin_tonic' }, src, failedSrc: src }));
    expect(html).toContain('data-thumb="icon"');
    expect(html).not.toContain('<img');
    expect(html).toContain(CARTA_ICON_PATHS.gin_tonic[0]);
  });

  it('el icono es decorativo (aria-hidden): el nombre ya está al lado', () => {
    expect(renderToStaticMarkup(createElement(CartaItemIcon, { item }))).toContain('aria-hidden="true"');
  });
});

describe('colección de iconos', () => {
  it('cada código del contrato tiene su dibujo, y solo esos', () => {
    expect(Object.keys(CARTA_ICON_PATHS).sort()).toEqual([...CARTA_ICON_CODES].sort());
    for (const code of CARTA_ICON_CODES) expect(CARTA_ICON_PATHS[code].length).toBeGreaterThan(0);
    expect(CARTA_ICONS.every((i) => i.label.length > 0)).toBe(true);
  });
  it('el icono por defecto de cada sección es de la colección', () => {
    for (const category of ['VENUE_BAR', 'VENUE_FOOD', 'VENUE_ENTRY', 'VENUE_ROOM', 'CHICA_SERVICE', 'EXTRA']) {
      expect(CARTA_ICON_CODES).toContain(cartaIconOf({ category }));
    }
  });
});
