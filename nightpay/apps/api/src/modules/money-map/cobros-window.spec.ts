import { describe, expect, it } from 'vitest';
import { CobrosQuerySchema } from '@nightpay/contracts';
import { cobrosWindow } from './cobros.service';

const at = (iso: string) => new Date(iso);

describe('las fechas de la lista de cobros (desde una cifra del mapa del dinero)', () => {
  it('admite desde/hasta como instantes ISO y rechaza lo que no lo es', () => {
    expect(CobrosQuerySchema.parse({ from: '2026-10-21T19:00:00.000Z', to: '2026-10-22T04:00:00+02:00' })).toMatchObject({
      from: '2026-10-21T19:00:00.000Z', to: '2026-10-22T04:00:00+02:00',
    });
    expect(CobrosQuerySchema.safeParse({ from: '2026-10-21' }).success).toBe(false);
    expect(CobrosQuerySchema.safeParse({ to: 'ayer' }).success).toBe(false);
  });

  it('sin noche: la ventana pedida; abierta por arriba si no hay hasta', () => {
    expect(cobrosWindow(null, {})).toEqual({ from: null, to: null });
    expect(cobrosWindow(null, { from: '2026-10-21T19:00:00.000Z' })).toEqual({ from: at('2026-10-21T19:00:00.000Z'), to: null });
  });

  it('con noche y fechas: la parte común; si no se solapan, nada', () => {
    const night = { openedAt: at('2026-10-21T20:00:00.000Z'), closedAt: at('2026-10-22T05:00:00.000Z') };
    expect(cobrosWindow(night, { from: '2026-10-21T19:00:00.000Z', to: '2026-10-22T03:00:00.000Z' })).toEqual({
      from: night.openedAt, to: at('2026-10-22T03:00:00.000Z'),
    });
    expect(cobrosWindow(night, {})).toEqual({ from: night.openedAt, to: night.closedAt });
    expect(cobrosWindow(night, { from: '2026-10-23T00:00:00.000Z' })).toBeNull();
  });
});
