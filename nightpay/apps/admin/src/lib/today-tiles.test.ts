import { describe, expect, it } from 'vitest';
import { todayTiles } from './today-tiles';

// «Hoy · pagos con tarjeta» y «Hoy · cobrado» (Cobros): «Esta noche» cuenta
// desde que se abrió la noche, no el día natural. Se esconden solo cuando
// dicen exactamente lo mismo que la noche, y no se pintan hasta saberlo.

const today = { count: 14, grossCents: 66_400, chargedCents: 141_400 };
const night = { count: 14, chargedCents: 141_400 };

describe('las losetas «Hoy» repetidas con la noche abierta', () => {
  it('se esconden si dicen lo mismo que «Esta noche» (importe y número)', () => {
    expect(todayTiles(night, today)).toBe('hide');
  });

  it('se ven si no coinciden (pasada la medianoche, o la noche abrió después)', () => {
    expect(todayTiles({ ...night, chargedCents: 98_000 }, today)).toBe('show');
    expect(todayTiles({ ...night, count: 9 }, today)).toBe('show');
  });

  it('sin noche abierta, se ven siempre (aunque las cifras aún no hayan llegado)', () => {
    expect(todayTiles(null, today)).toBe('show');
    expect(todayTiles(null, undefined)).toBe('show');
  });

  it('mientras no se sabe la noche (o las de hoy con la noche abierta), no se pintan: nada aparece y luego desaparece', () => {
    expect(todayTiles(undefined, today)).toBe('wait');
    expect(todayTiles(night, undefined)).toBe('wait');
  });

  it('un API viejo sin «cobrado» compara con lo bruto', () => {
    expect(todayTiles({ count: 14, chargedCents: 66_400 }, { count: 14, grossCents: 66_400 })).toBe('hide');
  });
});
