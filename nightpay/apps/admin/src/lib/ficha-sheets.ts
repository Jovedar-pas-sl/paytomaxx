// Las fichas del panel como en las maquetas 9.1 (el saldo) y 9.2 (la chica;
// también el camarero), lógica pura: cifras, chips, franja y línea del tiempo
// (hora, color de la sección, «C-4821 · 2 copas», «Copas · Carlos · NFC» y el
// importe con su parte en pequeño). Sin React: se prueba sola.

import type {
  ChargeMethod,
  CobroRow,
  StaffFicha,
  StaffFichaRow,
  StaffRate,
  VenueSection,
  WalletFicha,
  WalletFichaCard,
  WalletFichaTopUp,
} from '@nightpay/contracts';
import { dayInZone, formatDateTime } from './dates';
import { eurShort, sectionPaint, type Segment } from './money-map-view';

export interface Stat {
  key: string;
  label: string;
  cents: number;
}

export interface TimelineRow {
  key: string;
  at: string;
  time: string;
  /** Color de la sección; null = recarga o devolución (a trazos). */
  color: string | null;
  title: string;
  sub: string;
  amount: string;
  /** Su parte, en pequeño («+96»). */
  share: string | null;
  /** Devuelto o anulado del todo. */
  undone: boolean;
}

export interface RateChip {
  key: string;
  label: string;
  value: string;
  color: string;
}

const METHOD_WORD: Readonly<Record<ChargeMethod, string>> = {
  CARD: 'tarjeta',
  MOBILE_WALLET: 'Apple Pay / Google Pay',
  POS: 'datáfono',
  SALDO: 'saldo',
  CASH: 'efectivo',
};

/** «96», «9,50», sin el símbolo (la parte en pequeño de la maqueta). */
export function bareEur(cents: number): string {
  return eurShort(cents).replace(/\s*€$/u, '').trim();
}

/** «+96» o «−12» (la parte de la chica de un cobro). */
export function signed(cents: number): string {
  return `${cents < 0 ? '−' : '+'}${bareEur(Math.abs(cents))}`;
}

/** «hoy 23:40», «ayer 01:10» o «sáb 18, 23:40». */
export function sinceLabel(at: string, tz: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '—';
  const time = formatDateTime(date, tz, 'time');
  const day = dayInZone(date, tz);
  if (day === dayInZone(now, tz)) return `hoy ${time}`;
  if (day === dayInZone(new Date(now.getTime() - 86_400_000), tz)) return `ayer ${time}`;
  return `${dayShort(at, tz)}, ${time}`;
}

/** «sáb 18». */
export function dayShort(at: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone: tz }).formatToParts(new Date(at));
  const weekday = parts.find((p) => p.type === 'weekday')?.value.replace('.', '') ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${weekday} ${day}`.trim();
}

const joinParts = (parts: ReadonlyArray<string | null | undefined | false>): string => parts.filter(Boolean).join(' · ');

// ─── 9.1 · Ficha del saldo ───────────────────────────────────────────

export interface WalletSheet {
  title: string;
  subtitle: string;
  stats: { left: number; topped: number; spent: number; refunded: number };
  stripe: Segment[];
  card: { id: string; label: string; status: string; active: boolean; detail: string } | null;
  /** Sin ficha NFC: cómo paga («PIN puesto · Face ID»). */
  noCardDetail: string;
  rows: TimelineRow[];
}

function topUpWord(t: WalletFichaTopUp): string {
  return t.kind === 'CASH' ? 'efectivo' : METHOD_WORD[t.method] ?? 'tarjeta';
}

function topUpRow(t: WalletFichaTopUp, first: boolean, tz: string): TimelineRow {
  const voided = t.amountCents < 0;
  return {
    key: `topup-${t.kind}-${t.id}`,
    at: t.at,
    time: formatDateTime(t.at, tz, 'time'),
    color: null,
    title: voided ? `Recarga anulada · ${topUpWord(t)}` : `${first ? 'Alta' : 'Recarga'} · ${topUpWord(t)}`,
    sub: joinParts([t.terminalLabel, t.by?.name ?? (t.terminalLabel || voided ? null : 'sin personal'), t.note ? `«${t.note}»` : null]),
    amount: `${voided ? '−' : '+'}${eurShort(Math.abs(t.amountCents))}`,
    share: null,
    undone: false,
  };
}

function consumptionRow(c: CobroRow, sections: readonly VenueSection[], tz: string): TimelineRow {
  const main = c.sections[0]?.category ?? null;
  const paint = main ? sectionPaint(sections, main) : null;
  const label = c.sections.length > 1 ? c.sections.map((s) => sectionPaint(sections, s.category).label).join(' + ') : paint?.label;
  return {
    key: `saldo-${c.id}`,
    at: c.createdAt,
    time: formatDateTime(c.createdAt, tz, 'time'),
    color: paint?.color ?? 'var(--np-sec-otros)',
    title: joinParts([c.ref, c.service ?? label ?? 'Cobro']),
    sub: joinParts([label, c.person?.name, c.via]),
    amount: `−${eurShort(c.amountCents + c.tipCents)}`,
    share: null,
    undone: c.status === 'REVERSED',
  };
}

export function walletSheet(f: WalletFicha, sections: readonly VenueSection[], tz: string, now: Date = new Date()): WalletSheet {
  const spentRows = f.consumptions.filter((c) => c.status !== 'REVERSED');
  const spent = spentRows.reduce((a, c) => a + c.amountCents + c.tipCents, 0);
  const topped = f.topUps.reduce((a, t) => a + t.amountCents, 0);
  const refunded = f.refunds.filter((r) => r.status === 'DONE').reduce((a, r) => a + r.amountCents, 0);
  const bySection = new Map<string, number>();
  for (const c of spentRows) for (const s of c.sections) bySection.set(s.category, (bySection.get(s.category) ?? 0) + s.amountCents);
  const firstTopUp = [...f.topUps].filter((t) => t.amountCents > 0).sort((a, b) => a.at.localeCompare(b.at))[0];
  const rows: TimelineRow[] = [
    ...f.consumptions.map((c) => consumptionRow(c, sections, tz)),
    ...f.topUps.map((t) => topUpRow(t, t === firstTopUp, tz)),
    ...f.refunds.map(
      (r): TimelineRow => ({
        key: `refund-${r.id}`,
        at: r.at,
        time: formatDateTime(r.at, tz, 'time'),
        color: null,
        title: `Devolución · ${r.method === 'CASH' ? 'efectivo' : 'tarjeta'}`,
        sub: joinParts([r.by?.name, r.bankReference ? `ref. ${r.bankReference}` : null, r.status === 'PENDING' ? 'apuntándose en el banco' : null]),
        amount: `−${eurShort(r.amountCents)}`,
        share: null,
        undone: false,
      }),
    ),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const card = activeCard(f.cards ?? []);
  const w = f.wallet;
  return {
    title: `Saldo ${w.code ?? ''}`.trim(),
    subtitle: `Desde ${sinceLabel(w.createdAt, tz, now)}`,
    stats: { left: w.balanceCents, topped, spent, refunded },
    stripe: [...bySection].map(([code, cents]) => ({ key: code, ...sectionPaint(sections, code), cents })),
    card: card
      ? {
          id: card.id,
          label: card.label,
          status: card.status,
          active: card.status !== 'BLOCKED',
          detail: joinParts([card.status === 'BLOCKED' ? 'Bloqueada' : 'Activa', w.hasPin ? 'PIN puesto' : 'sin PIN']),
        }
      : null,
    noCardDetail: joinParts([w.hasPin ? 'PIN puesto' : 'sin PIN', w.hasFaceId ? 'Face ID' : null]),
    rows,
  };
}

/** La que paga (la última dada) o, si no hay, la bloqueada. */
function activeCard(cards: readonly WalletFichaCard[]): WalletFichaCard | null {
  return cards.find((c) => c.status !== 'BLOCKED') ?? cards[0] ?? null;
}

// ─── 9.2 · Ficha de la chica (y del camarero) ────────────────────────

export interface StaffSheet {
  title: string;
  subtitle: string;
  chip: { label: string; color: string };
  stats: Stat[];
  rates: RateChip[];
  rows: TimelineRow[];
  /** «Pagos · sáb 18: 410 € · vie 17: 355 €» y la vía del último. */
  payline: { text: string; rail: string | null } | null;
}

function shareValue(share: Extract<StaffRate, { kind: 'invitation' }>['share']): string {
  return share.kind === 'PERCENT' ? `${(share.bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %` : eurShort(share.cents);
}

export function rateChips(rates: readonly StaffRate[], sections: readonly VenueSection[]): RateChip[] {
  return rates.map((r): RateChip => {
    if (r.kind === 'section') {
      const p = sectionPaint(sections, r.code);
      return { key: `s-${r.code}`, label: p.label, value: `${(r.bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`, color: p.color };
    }
    if (r.kind === 'invitation') return { key: 'invitation', label: 'Invitación', value: shareValue(r.share), color: sectionPaint(sections, 'VENUE_BAR').color };
    return { key: 'tips', label: 'Propinas', value: `${(r.bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 0 })} %`, color: sectionPaint(sections, 'TIPS').color };
  });
}

function staffRow(r: StaffFichaRow, sections: readonly VenueSection[], tz: string): TimelineRow {
  const paint = sectionPaint(sections, r.section);
  const via = r.method === 'POS' ? null : r.via;
  const sub =
    r.kind === 'SALDO' && !r.invitation
      ? joinParts([r.walletCode ? `Saldo ${r.walletCode}` : 'Saldo', via])
      : joinParts([paint.label, r.chargedBy ? `cobró ${r.chargedBy.name}` : r.method ? METHOD_WORD[r.method] : null, via]);
  return {
    key: r.id,
    at: r.at,
    time: formatDateTime(r.at, tz, 'time'),
    color: paint.color,
    title: joinParts([r.ref, r.title]),
    sub,
    amount: eurShort(r.amountCents),
    share: signed(r.shareCents),
    undone: r.undone,
  };
}

export function staffSheet(
  f: StaffFicha,
  sections: readonly VenueSection[],
  tz: string,
): StaffSheet {
  const camarero = f.person.role === 'WAITER';
  const chipSection = camarero ? 'VENUE_BAR' : 'CHICA_SERVICE';
  const chip = sectionPaint(sections, chipSection);
  const payouts = f.payouts.map((p) => `${dayShort(p.at, tz)}: ${eurShort(p.cents)}`);
  return {
    title: f.person.name,
    subtitle: `${camarero ? 'Camarero' : 'Chica'} · ${f.window.open || f.window.nightId ? 'esta noche' : 'desde el último cierre'}`,
    chip,
    stats: [
      { key: 'sold', label: 'Vendido', cents: f.stats.soldCents },
      { key: 'share', label: camarero ? 'Lo suyo' : 'Su parte', cents: f.stats.shareCents },
      { key: 'paid', label: 'Pagado', cents: f.stats.paidCents },
    ],
    rates: rateChips(f.rates, sections),
    rows: f.rows.map((r) => staffRow(r, sections, tz)),
    payline: payouts.length > 0 ? { text: payouts.join(' · '), rail: f.payouts[0]?.rail ?? null } : null,
  };
}

/** «Pagar 271 € a Lola» (o «Pedir pago de …» si lo aprueba el dueño). */
export function payButtonLabel(mode: 'pay' | 'pay_2fa' | 'request', cents: number, name: string): string {
  return mode === 'request' ? `Pedir pago de ${eurShort(cents)} para ${name}` : `Pagar ${eurShort(cents)} a ${name}`;
}
