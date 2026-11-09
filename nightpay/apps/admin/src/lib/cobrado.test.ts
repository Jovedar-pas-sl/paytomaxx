import { describe, expect, it } from 'vitest';
import { COBRADO_HELP, COBRADO_PARTS_HINT, cobradoNote, metricsCobradoParts, tonightCobradoNote, zClosedLines, zCobradoParts } from './cobrado';
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
      `${formatEur(53_300)} de ventas con tarjeta + ${formatEur(2_600)} de propinas con tarjeta + ${formatEur(55_000)} de recargas`,
    );
  });

  it('el Z de la noche, con los mismos nombres', () => {
    const p = zCobradoParts({ grossCents: 63_300, tipsCents: 2_600, walletCashTopUpsCents: 45_000, walletCardTopUpsCents: 10_000 });
    expect(p).toEqual({ salesCents: 53_300, tipCents: 2_600, topUpCents: 55_000 });
  });

  it('lo que es 0 no se nombra; sin nada, sin subtítulo', () => {
    expect(cobradoNote({ salesCents: 53_300, tipCents: 0, topUpCents: 0 }, formatEur)).toBe(`${formatEur(53_300)} de ventas con tarjeta`);
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

describe('la línea del Z congelado (prueba real: «17 pagos con tarjeta · cobrado 2.450 €» llevaba las recargas en efectivo)', () => {
  const z = {
    count: 17,
    chargedCents: 245_000,
    grossCents: 75_200,
    tipsCents: 2_800,
    walletCardTopUpsCents: 17_000,
    walletCashTopUpsCents: 167_000,
  };

  it('como el resumen de las 9:00: «Cobrado» con su desglose y, aparte, «Con tarjeta» con su importe', () => {
    expect(zClosedLines(z, formatEur)).toEqual({
      cobrado: `Cobrado: ${formatEur(245_000)} (${formatEur(58_200)} de ventas con tarjeta + ${formatEur(2_800)} de propinas con tarjeta + ${formatEur(184_000)} de recargas)`,
      card: `Con tarjeta: 17 pagos · ${formatEur(78_000)}`,
    });
  });

  it('un pago; y un Z de antes sin las recargas con tarjeta aparte: «Cobrado» sin desglose', () => {
    const old = { count: 1, chargedCents: 3_000, grossCents: 3_000, tipsCents: 0 };
    expect(zClosedLines(old, formatEur)).toEqual({ cobrado: `Cobrado: ${formatEur(3_000)}`, card: `Con tarjeta: 1 pago · ${formatEur(3_000)}` });
  });
});

describe('con la «Comisión del servicio» (la paga el cliente encima; se debe a OxioPay)', () => {
  // 33 € con tarjeta + 3,30 € de comisión + 2 € de propina; recarga con tarjeta
  // de 50 € + 6 €; recarga en efectivo de 50 € + 6 €.
  const hoy = { grossCents: 8_300, tipCents: 200, walletCardTopUpCents: 5_000, walletCashTopUpCents: 5_000, serviceFeeCents: 1_530 };

  it('«Hoy · cobrado»: ventas + propinas + recargas + comisión del servicio = cobrado', () => {
    const p = metricsCobradoParts(hoy);
    expect(p).toEqual({ salesCents: 3_300, tipCents: 200, topUpCents: 10_000, serviceFeeCents: 1_530 });
    expect(cobradoNote(p, formatEur)).toBe(
      `${formatEur(3_300)} de ventas con tarjeta + ${formatEur(200)} de propinas con tarjeta + ${formatEur(10_000)} de recargas + ${formatEur(1_530)} de comisión del servicio`,
    );
  });

  it('el Z: lo mismo; «Con tarjeta» lleva la comisión de lo cobrado con tarjeta (no la del efectivo)', () => {
    const z = {
      count: 2,
      grossCents: 8_300,
      tipsCents: 200,
      chargedCents: 8_300 + 200 + 5_000 + 1_530,
      walletCardTopUpsCents: 5_000,
      walletCashTopUpsCents: 5_000,
      serviceFeeCents: 1_530,
      serviceFeeCashCents: 600,
    };
    expect(zCobradoParts(z)).toEqual({ salesCents: 3_300, tipCents: 200, topUpCents: 10_000, serviceFeeCents: 1_530 });
    expect(zClosedLines(z, formatEur).card).toBe(`Con tarjeta: 2 pagos · ${formatEur(8_300 + 200 + 930)}`);
  });

  it('sin ella, como siempre (ni la parte ni el texto)', () => {
    expect(metricsCobradoParts({ ...hoy, serviceFeeCents: undefined })).toEqual({ salesCents: 3_300, tipCents: 200, topUpCents: 10_000 });
  });
});

describe('«Cobrado» en «Esta noche»: qué cuenta, sin otra línea de ayuda', () => {
  it('con desglose, el desglose con sus cifras (ya dice de qué está hecho)', () => {
    const note = cobradoNote(metricsCobradoParts(DEMO_HOY), formatEur);
    expect(tonightCobradoNote({ chargedNote: note })).toBe(note);
  });

  it('sin desglose (todo a 0 o un Z de antes): de qué está hecho, sin cifras que puedan no cuadrar', () => {
    expect(tonightCobradoNote({ chargedNote: null })).toBe(COBRADO_PARTS_HINT);
    expect(COBRADO_PARTS_HINT).toBe('Suma ventas, propinas y recargas');
    expect(COBRADO_PARTS_HINT).not.toMatch(/\d/);
  });

  it('sin noche abierta o cargando: nada debajo de «—»', () => {
    expect(tonightCobradoNote(null)).toBeNull();
    expect(tonightCobradoNote(undefined)).toBeNull();
  });

  it('la frase entera (al pasar el ratón) nombra todo lo que suma, también el efectivo y la comisión', () => {
    for (const part of ['ventas', 'propinas', 'recargas', 'efectivo', 'comisión del servicio']) expect(COBRADO_HELP).toContain(part);
    expect(COBRADO_HELP).not.toMatch(/[!¡]/);
  });
});
