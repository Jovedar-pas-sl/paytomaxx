import { describe, expect, it } from 'vitest';
import { cobradoNote, metricsCobradoParts, zCobradoParts } from './cobrado';
import { formatEur } from './money';

// «Hoy · cobrado» y el Z: lo cobrado incluye las recargas (con tarjeta, ya en
// grossCents, y en efectivo), que no son venta. El subtítulo dice exactamente
// de qué está hecho el total. La noche de la demo, a mano: 1109 € =
// 533 € de ventas con tarjeta + 26 € de propinas + 550 € de recargas
// (100 con tarjeta + 450 en efectivo). Antes decía «633 € + 26 € de propinas».

const DEMO_HOY = {
  count: 11,
  grossCents: 63_300,
  tipCents: 2_600,
  chargedCents: 110_900,
  refundedCents: 1_200,
  netCents: 107_700,
  walletCashTopUpCents: 45_000,
  walletCardTopUpCents: 10_000,
};

describe('lo cobrado, por partes', () => {
  it('las métricas de hoy: ventas + propinas + recargas = cobrado', () => {
    const p = metricsCobradoParts(DEMO_HOY);
    expect(p).toEqual({ salesCents: 53_300, tipCents: 2_600, topUpCents: 55_000 });
    expect(p!.salesCents + p!.tipCents + p!.topUpCents).toBe(DEMO_HOY.chargedCents);
    expect(cobradoNote(p, formatEur)).toBe(
      `${formatEur(53_300)} de ventas + ${formatEur(2_600)} de propinas + ${formatEur(55_000)} de recargas`,
    );
  });

  it('el Z de la noche, con los mismos nombres', () => {
    const p = zCobradoParts({ grossCents: 63_300, tipsCents: 2_600, walletCashTopUpsCents: 45_000, walletCardTopUpsCents: 10_000 });
    expect(p).toEqual({ salesCents: 53_300, tipCents: 2_600, topUpCents: 55_000 });
  });

  it('lo que es 0 no se nombra; sin nada, sin subtítulo', () => {
    expect(cobradoNote({ salesCents: 53_300, tipCents: 0, topUpCents: 0 }, formatEur)).toBe(`${formatEur(53_300)} de ventas`);
    expect(cobradoNote({ salesCents: 0, tipCents: 0, topUpCents: 45_000 }, formatEur)).toBe(`${formatEur(45_000)} de recargas`);
    expect(cobradoNote({ salesCents: 0, tipCents: 0, topUpCents: 0 }, formatEur)).toBeNull();
  });

  it('un API o un Z de antes, sin las recargas con tarjeta aparte: sin subtítulo (no uno que no cuadre)', () => {
    const { walletCardTopUpCents: _omit, ...old } = DEMO_HOY;
    expect(metricsCobradoParts(old)).toBeNull();
    expect(zCobradoParts({ grossCents: 63_300, tipsCents: 2_600, walletCashTopUpsCents: 45_000 })).toBeNull();
    expect(cobradoNote(null, formatEur)).toBeNull();
  });
});
