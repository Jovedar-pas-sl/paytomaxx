// «Cobrado» (Hoy y el Z de Noches), por partes (lógica pura). Lo cobrado es
// el dinero que entró: ventas con tarjeta, propinas, recargas del saldo (con
// tarjeta y en efectivo) y, si el local la tiene, la «Comisión del servicio»
// (la paga el cliente encima y se debe a OxioPay). Las recargas no son venta
// (son saldo de los clientes), así que el subtítulo dice exactamente de qué
// está hecho el total.

export interface CobradoParts {
  /** Ventas con tarjeta, sin propinas ni recargas (ni las de bitcoin). */
  salesCents: number;
  tipCents: number;
  /** Ventas y propinas pagadas con bitcoin: aparte, no son «con tarjeta» (solo si las hubo). */
  bitcoinCents?: number;
  /** Recargas del saldo, con tarjeta y en efectivo. */
  topUpCents: number;
  /** «Comisión del servicio» (solo si la hubo). */
  serviceFeeCents?: number;
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
  serviceFeeCents?: number;
}): CobradoParts | null {
  if (m.walletCardTopUpCents === undefined) return null;
  return {
    salesCents: m.grossCents - m.walletCardTopUpCents,
    tipCents: m.tipCents ?? 0,
    topUpCents: m.walletCardTopUpCents + (m.walletCashTopUpCents ?? 0),
    ...(m.serviceFeeCents ? { serviceFeeCents: m.serviceFeeCents } : {}),
  };
}

/** Lo pagado con bitcoin que trae el Z (NightSummary.bitcoin). */
interface BitcoinPart {
  count: number;
  salesCents: number;
  tipsCents: number;
  topUpsCount: number;
  topUpsCents: number;
  totalCents: number;
}

/** El Z de una noche (los congelados antes del 23-oct-2026 no traen las recargas con tarjeta: null). */
export function zCobradoParts(s: {
  grossCents: number;
  tipsCents: number;
  walletCashTopUpsCents?: number;
  walletCardTopUpsCents?: number;
  serviceFeeCents?: number;
  bitcoin?: BitcoinPart;
}): CobradoParts | null {
  const parts = metricsCobradoParts({
    grossCents: s.grossCents,
    tipCents: s.tipsCents,
    walletCashTopUpCents: s.walletCashTopUpsCents,
    walletCardTopUpCents: s.walletCardTopUpsCents,
    serviceFeeCents: s.serviceFeeCents,
  });
  const btc = s.bitcoin;
  if (!parts || !btc) return parts;
  // Lo de bitcoin sale de «con tarjeta» y va aparte (está en la cartera del local).
  return {
    ...parts,
    salesCents: parts.salesCents - btc.salesCents,
    tipCents: parts.tipCents - btc.tipsCents,
    bitcoinCents: btc.salesCents + btc.tipsCents,
  };
}

/** Los pagos que pasan por el banco: todos menos los de bitcoin. */
export function cardPaymentsCount(s: { count: number; bitcoin?: Pick<BitcoinPart, 'count'> }): number {
  return s.count - (s.bitcoin?.count ?? 0);
}

/** «Bitcoin: 12,00 €, en la cartera del local» (sin bitcoin, null): ni banco ni caja. */
export function bitcoinWalletLine(cents: number | null | undefined, eur: (cents: number) => string): string | null {
  if (cents === null || cents === undefined) return null;
  return `Bitcoin: ${eur(cents)}, en la cartera del local`;
}

/**
 * «533,00 € de ventas con tarjeta + 26,00 € de propinas con tarjeta + 550,00 €
 * de recargas» (sin las partes a 0); null si no hay nada. «Con tarjeta»: lo
 * que entró (el saldo ya entró al recargarse); sin eso, las ventas y las
 * propinas del Mapa del dinero (que cuentan también las del saldo) parecían
 * no cuadrar (auditoría P-2).
 */
export function cobradoNote(p: CobradoParts | null, eur: (cents: number) => string): string | null {
  if (!p) return null;
  const parts = [
    p.salesCents !== 0 ? `${eur(p.salesCents)} de ventas con tarjeta` : null,
    p.tipCents !== 0 ? `${eur(p.tipCents)} de propinas con tarjeta` : null,
    p.bitcoinCents ? `${eur(p.bitcoinCents)} de ventas y propinas con bitcoin` : null,
    p.topUpCents !== 0 ? `${eur(p.topUpCents)} de recargas` : null,
    p.serviceFeeCents ? `${eur(p.serviceFeeCents)} de comisión del servicio` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(' + ') : null;
}

/** De qué está hecho «Cobrado» cuando no hay desglose (todo a 0, o un API de antes): sin cifras, no puede no cuadrar. */
export const COBRADO_PARTS_HINT = 'Suma ventas, propinas y recargas';

/** Lo que cuenta «Cobrado», entero (el `title` de la cifra en «Esta noche»). */
export const COBRADO_HELP =
  'Todo el dinero que entró esta noche: ventas, propinas y recargas del saldo (con tarjeta y en efectivo) y, si el local la cobra, la comisión del servicio.';

/**
 * La línea de debajo de «Cobrado» en «Esta noche»: el desglose con sus cifras
 * o, si no lo hay, de qué está hecho. Sin noche abierta (o cargando), nada.
 */
export function tonightCobradoNote(night: { chargedNote: string | null } | null | undefined): string | null {
  if (!night) return null;
  return night.chargedNote ?? COBRADO_PARTS_HINT;
}

/**
 * La línea del Z congelado (al cerrar la noche), como el resumen de las
 * 9:00: «Cobrado» con su desglose (ventas + propinas + recargas, también en
 * efectivo) y, aparte, «Con tarjeta» con su número e importe (lo que verá en
 * el banco). Antes: «N pagos con tarjeta · cobrado X», y X llevaba las
 * recargas en efectivo.
 */
export function zClosedLines(
  s: {
    count: number;
    chargedCents: number;
    grossCents: number;
    tipsCents: number;
    walletCashTopUpsCents?: number;
    walletCardTopUpsCents?: number;
    serviceFeeCents?: number;
    serviceFeeCashCents?: number;
    bitcoin?: BitcoinPart;
  },
  eur: (cents: number) => string,
): { cobrado: string; card: string; bitcoin: string | null } {
  const parts = cobradoNote(zCobradoParts(s), eur);
  // Con tarjeta va también la comisión del servicio de esos pagos (la de las recargas en efectivo está en la caja).
  const cardFee = (s.serviceFeeCents ?? 0) - (s.serviceFeeCashCents ?? 0);
  // Lo de bitcoin no pasa por el banco: fuera de «Con tarjeta», en su línea.
  const btc = s.bitcoin;
  const cardCount = cardPaymentsCount(s);
  return {
    cobrado: parts ? `Cobrado: ${eur(s.chargedCents)} (${parts})` : `Cobrado: ${eur(s.chargedCents)}`,
    card: `Con tarjeta: ${cardCount} ${cardCount === 1 ? 'pago' : 'pagos'} · ${eur(s.grossCents + s.tipsCents + cardFee - (btc?.totalCents ?? 0))}`,
    bitcoin: btc ? `${bitcoinWalletLine(btc.totalCents, eur)} (${btc.count} ${btc.count === 1 ? 'pago' : 'pagos'})` : null,
  };
}
