// «Cobrado» (Hoy y el Z de Noches), por partes (lógica pura). Lo cobrado es
// el dinero que entró: ventas con tarjeta, propinas y recargas del saldo (con
// tarjeta y en efectivo). Las recargas no son venta (son saldo de los
// clientes), así que el subtítulo dice exactamente de qué está hecho el total.

export interface CobradoParts {
  /** Ventas con tarjeta, sin propinas ni recargas. */
  salesCents: number;
  tipCents: number;
  /** Recargas del saldo, con tarjeta y en efectivo. */
  topUpCents: number;
}

/**
 * Las métricas de hoy (grossCents ya lleva las recargas con tarjeta). Un API
 * de antes, sin las recargas con tarjeta aparte: null (mejor sin subtítulo
 * que uno que no cuadre).
 */
export function metricsCobradoParts(m: {
  grossCents: number;
  tipCents?: number;
  walletCashTopUpCents?: number;
  walletCardTopUpCents?: number;
}): CobradoParts | null {
  if (m.walletCardTopUpCents === undefined) return null;
  return {
    salesCents: m.grossCents - m.walletCardTopUpCents,
    tipCents: m.tipCents ?? 0,
    topUpCents: m.walletCardTopUpCents + (m.walletCashTopUpCents ?? 0),
  };
}

/** El Z de una noche (los congelados antes del 23-oct-2026 no traen las recargas con tarjeta: null). */
export function zCobradoParts(s: {
  grossCents: number;
  tipsCents: number;
  walletCashTopUpsCents?: number;
  walletCardTopUpsCents?: number;
}): CobradoParts | null {
  return metricsCobradoParts({
    grossCents: s.grossCents,
    tipCents: s.tipsCents,
    walletCashTopUpCents: s.walletCashTopUpsCents,
    walletCardTopUpCents: s.walletCardTopUpsCents,
  });
}

/** «533,00 € de ventas + 26,00 € de propinas + 550,00 € de recargas» (sin las partes a 0); null si no hay nada. */
export function cobradoNote(p: CobradoParts | null, eur: (cents: number) => string): string | null {
  if (!p) return null;
  const parts = [
    p.salesCents !== 0 ? `${eur(p.salesCents)} de ventas` : null,
    p.tipCents !== 0 ? `${eur(p.tipCents)} de propinas` : null,
    p.topUpCents !== 0 ? `${eur(p.topUpCents)} de recargas` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(' + ') : null;
}

/**
 * La línea del Z congelado (al cerrar la noche), como el resumen de las
 * 9:00: «Cobrado» con su desglose (ventas + propinas + recargas, también en
 * efectivo) y, aparte, «Con tarjeta» con su número e importe (lo que verá en
 * el banco). Antes: «N pagos con tarjeta · cobrado X», y X llevaba las
 * recargas en efectivo.
 */
export function zClosedLines(
  s: { count: number; chargedCents: number; grossCents: number; tipsCents: number; walletCashTopUpsCents?: number; walletCardTopUpsCents?: number },
  eur: (cents: number) => string,
): { cobrado: string; card: string } {
  const parts = cobradoNote(zCobradoParts(s), eur);
  return {
    cobrado: parts ? `Cobrado: ${eur(s.chargedCents)} (${parts})` : `Cobrado: ${eur(s.chargedCents)}`,
    card: `Con tarjeta: ${s.count} ${s.count === 1 ? 'pago' : 'pagos'} · ${eur(s.grossCents + s.tipsCents)}`,
  };
}
