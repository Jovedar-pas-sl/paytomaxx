// Reservados en el panel: lo que se calcula sin red (reservations.test.ts).

import {
  PROMOTER_MAX_BPS,
  RESERVATION_MAX_PRICE_CENTS,
  RESERVATION_MIN_PRICE_CENTS,
  formatMoney,
  type PackageItem,
  type ReservationKind,
  type ReservationPackageInput,
  type ReservationPackageView,
  type ReservationView,
} from '@nightpay/contracts';

/** «300», «300,50» o «300.50» → céntimos enteros (null si no es un importe). */
export function eurosToCents(text: string): number | null {
  const t = text.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function centsToEuros(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace('.', ',');
}

/** Lo que incluye un paquete, en una línea. */
export function packageSummary(p: Pick<ReservationPackageView, 'kind' | 'entries' | 'items' | 'creditCents'>): string {
  const people = `${p.entries} ${p.entries === 1 ? 'persona' : 'personas'}`;
  const what = p.kind === 'CREDIT' ? `${formatMoney(p.creditCents)} para consumir` : p.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
  return what ? `${people} · ${what}` : people;
}

/** El formulario de un paquete (texto tal como se escribe). */
export interface PackageForm {
  name: string;
  kind: ReservationKind;
  price: string;
  credit: string;
  entries: string;
  /** Una cosa por línea: «2 Botella premium». */
  items: string;
  description: string;
  maxPerNight: string;
}

export function emptyPackageForm(): PackageForm {
  return { name: '', kind: 'ITEMS', price: '', credit: '', entries: '6', items: '', description: '', maxPerNight: '' };
}

export function packageToForm(p: ReservationPackageView): PackageForm {
  return {
    name: p.name,
    kind: p.kind,
    price: centsToEuros(p.priceCents),
    credit: p.kind === 'CREDIT' ? centsToEuros(p.creditCents) : '',
    entries: String(p.entries),
    items: p.items.map((i) => `${i.qty} ${i.name}`).join('\n'),
    description: p.description ?? '',
    maxPerNight: p.maxPerNight ? String(p.maxPerNight) : '',
  };
}

/** «2 Botella premium» → { qty: 2, name: 'Botella premium' }; sin número, 1. */
export function parseItems(text: string): PackageItem[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items: PackageItem[] = [];
  for (const line of lines) {
    const m = /^(\d{1,2})\s*[x×]?\s+(.+)$/i.exec(line);
    const qty = m ? Number(m[1]) : 1;
    const name = (m ? m[2] : line)!.trim();
    if (qty < 1 || name.length === 0 || name.length > 40) return null;
    items.push({ name, qty });
  }
  return items;
}

/** El formulario → lo que se manda, o el primer error en palabras sencillas. */
export function packageFormToInput(f: PackageForm): { ok: true; input: ReservationPackageInput } | { ok: false; error: string } {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Pon un nombre al paquete' };
  const priceCents = eurosToCents(f.price);
  if (priceCents === null || priceCents < RESERVATION_MIN_PRICE_CENTS || priceCents > RESERVATION_MAX_PRICE_CENTS) {
    return { ok: false, error: 'El precio va de 10 € a 10.000 €' };
  }
  const entries = Number(f.entries);
  if (!Number.isInteger(entries) || entries < 1 || entries > 50) return { ok: false, error: 'Las personas van de 1 a 50' };
  const items = parseItems(f.items);
  if (items === null) return { ok: false, error: 'Revisa las cosas del paquete: una por línea, por ejemplo «2 Botella»' };
  let creditCents = 0;
  if (f.kind === 'CREDIT') {
    const c = eurosToCents(f.credit);
    if (c === null || c < 100 || c > priceCents) return { ok: false, error: 'El importe para consumir va de 1 € al precio del paquete' };
    creditCents = c;
  } else if (items.length === 0) {
    return { ok: false, error: 'Pon al menos una cosa del paquete' };
  }
  const max = f.maxPerNight.trim() ? Number(f.maxPerNight) : null;
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > 500)) return { ok: false, error: 'El máximo por noche va de 1 a 500' };
  return {
    ok: true,
    input: {
      name,
      kind: f.kind,
      priceCents,
      creditCents,
      entries,
      items: f.kind === 'CREDIT' ? [] : items,
      description: f.description.trim() || null,
      maxPerNight: max,
    },
  };
}

/** La noche de ahora en Madrid: antes de las 08:00 aún es la de ayer. */
export function currentNight(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() - 8 * 3600_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function nightLabel(day: string): string {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/** Qué se puede hacer con una reserva en el panel (los botones). */
export interface ReservationActions {
  table: boolean;
  changeDate: boolean;
  /** «Cancelar» (sin pagar) o «Devolver» (pagada: el saldo del grupo se devuelve en Saldos). */
  cancel: 'Cancelar' | 'Devolver' | null;
}

export function reservationActions(r: Pick<ReservationView, 'status' | 'paidCents'>): ReservationActions {
  const open = r.status === 'PENDING' || r.status === 'DEPOSIT_PAID' || r.status === 'PAID';
  return {
    table: open || r.status === 'ARRIVED',
    changeDate: open,
    cancel: open ? (r.paidCents > 0 ? 'Devolver' : 'Cancelar') : null,
  };
}

/** Color de la etiqueta del estado (tokens Grafito). */
export function statusTone(status: ReservationView['status']): 'ok' | 'warn' | 'mute' | 'bad' {
  if (status === 'PAID' || status === 'ARRIVED') return 'ok';
  if (status === 'DEPOSIT_PAID' || status === 'PENDING') return 'warn';
  if (status === 'NO_SHOW') return 'bad';
  return 'mute';
}

/** 1000 bps → «10»; 1250 → «12,5». */
export function bpsToPercent(bps: number): string {
  return String(bps / 100).replace('.', ',');
}

/** «10», «12,5» → bps (del 0 % al 50 %; null si no vale). */
export function percentToBps(text: string): number | null {
  const t = text.trim().replace('%', '').replace(',', '.').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= 0 && bps <= PROMOTER_MAX_BPS ? bps : null;
}
