import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARTA_ICON_CODES, CartaIconSchema, cartaIconOf, defaultCartaIcon, UploadServiceImageSchema } from '@nightpay/contracts';

describe('colección de iconos de la carta', () => {
  it('cada sección tiene su icono por defecto', () => {
    expect(defaultCartaIcon('VENUE_BAR')).toBe('copa');
    expect(defaultCartaIcon('VENUE_FOOD')).toBe('plato');
    expect(defaultCartaIcon('VENUE_ENTRY')).toBe('entrada');
    expect(defaultCartaIcon('VENUE_ROOM')).toBe('habitacion');
    expect(defaultCartaIcon('CHICA_SERVICE')).toBe('estrella');
    expect(defaultCartaIcon('EXTRA')).toBe('estrella');
  });

  it('el del producto manda; uno desconocido o null cae al de su sección', () => {
    expect(cartaIconOf({ icon: 'cerveza', category: 'VENUE_FOOD' })).toBe('cerveza');
    expect(cartaIconOf({ icon: null, category: 'VENUE_FOOD' })).toBe('plato');
    expect(cartaIconOf({ icon: 'logo_de_marca', category: 'VENUE_ROOM' })).toBe('habitacion');
    expect(cartaIconOf({ category: 'VENUE_BAR' })).toBe('copa');
  });

  it('el esquema solo deja los códigos de la colección', () => {
    expect(CartaIconSchema.safeParse('gin_tonic').success).toBe(true);
    expect(CartaIconSchema.safeParse('<svg/>').success).toBe(false);
    expect(CartaIconSchema.safeParse('').success).toBe(false);
  });

  it('la lista de la migración es la misma que la del contrato', () => {
    const sql = readFileSync(join(__dirname, '../../../../../packages/db/prisma/migrations/20261111100000_carta_imagenes/migration.sql'), 'utf8');
    const listed = [...(sql.match(/"icon" IN \(([\s\S]*?)\)\)/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...CARTA_ICON_CODES].sort());
  });

  it('la subida pide base64 y no más de 64 KB', () => {
    expect(UploadServiceImageSchema.safeParse({ data: Buffer.alloc(100, 1).toString('base64') }).success).toBe(true);
    expect(UploadServiceImageSchema.safeParse({ data: 'data:image/webp;base64,AAAA' }).success).toBe(false);
    expect(UploadServiceImageSchema.safeParse({ data: Buffer.alloc(70_000, 1).toString('base64') }).success).toBe(false);
  });
});
