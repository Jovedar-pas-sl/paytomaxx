// OxioParty · La fiesta (lógica pura del formulario): las fechas en la hora
// del local (no en la del navegador), el último día para pedir la devolución,
// si se puede donar lo que sobra y el umbral del aviso de efectivo.

import {
  EVENT_LOCKED_MESSAGE,
  MAX_CASH_ALERT_CENTS,
  parseEuroCents,
  partySettingsProblem,
  type PartySettings,
  type UpdatePartySettingsDto,
} from '@nightpay/contracts';
import { centsToInput } from './money';

export interface PartySettingsForm {
  /** «2027-06-23T20:00» en la hora del local (datetime-local). */
  startsAt: string;
  endsAt: string;
  /** «2027-07-15» (date). */
  refundDeadline: string;
  allowDonation: boolean;
  /** «2.000» / «2000,00»; «0» = sin aviso. */
  cashAlertEur: string;
}

const PARTS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = PARTS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS.set(timeZone, fmt);
  }
  return fmt;
}

function wallParts(at: Date, timeZone: string): Record<string, number> {
  return Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
}

/** Minutos que la zona va por delante de UTC en ese instante. */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = wallParts(at, timeZone);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Un instante → «AAAA-MM-DDTHH:MM» en la hora del local (para datetime-local). */
export function isoToZonedInput(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const p = wallParts(at, timeZone);
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}`;
}

/** «AAAA-MM-DDTHH:MM» en la hora del local → ISO (UTC). Mal escrito → null. */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  // Primera aproximación y corrección con el desfase de ese instante (cambio de hora).
  const guess = new Date(wall - offsetMinutes(new Date(wall), timeZone) * 60_000);
  return new Date(wall - offsetMinutes(guess, timeZone) * 60_000).toISOString();
}

export function partySettingsFormFrom(s: PartySettings, timeZone: string): PartySettingsForm {
  return {
    startsAt: isoToZonedInput(s.eventStartsAt, timeZone),
    endsAt: isoToZonedInput(s.eventEndsAt, timeZone),
    refundDeadline: s.refundDeadline ?? '',
    allowDonation: s.allowDonation,
    cashAlertEur: centsToInput(s.cashAlertCents),
  };
}

/** Euros que pueden ser 0 («0», «0,00»). */
function parseEurosAllowZero(input: string): number | null {
  if (/^\s*0+(?:[.,]0{1,2})?\s*€?\s*$/.test(input)) return 0;
  return parseEuroCents(input, MAX_CASH_ALERT_CENTS);
}

type Plan = { ok: true; change: UpdatePartySettingsDto } | { ok: false; problem: string };

/** Solo lo que cambia (vacío: nada) o el motivo para no mandarlo. */
export function partySettingsChange(form: PartySettingsForm, current: PartySettings, timeZone: string): Plan {
  const startsAt = form.startsAt.trim() ? zonedInputToIso(form.startsAt, timeZone) : null;
  if (form.startsAt.trim() && !startsAt) return { ok: false, problem: 'El inicio de la fiesta: una fecha y una hora.' };
  const endsAt = form.endsAt.trim() ? zonedInputToIso(form.endsAt, timeZone) : null;
  if (form.endsAt.trim() && !endsAt) return { ok: false, problem: 'El fin de la fiesta: una fecha y una hora.' };
  const deadline = form.refundDeadline.trim() || null;
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { ok: false, problem: 'El último día para pedir la devolución: una fecha.' };
  const cash = parseEurosAllowZero(form.cashAlertEur);
  if (cash === null) return { ok: false, problem: 'El aviso de efectivo: un importe de 0 a 100.000 € (0 = sin aviso).' };
  if (reopens(current, endsAt)) return { ok: false, problem: EVENT_LOCKED_MESSAGE };
  const problem = partySettingsProblem({ eventStartsAt: startsAt, eventEndsAt: endsAt });
  if (problem) return { ok: false, problem: `${problem}.` };
  // El día del fin en la hora del local (el del formulario), no el de UTC.
  if (deadline && endsAt && deadline < form.endsAt.trim().slice(0, 10)) {
    return { ok: false, problem: 'El último día para pedir la devolución tiene que ser después del fin de la fiesta.' };
  }
  const same = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
  const change: UpdatePartySettingsDto = {
    ...(!same(startsAt, current.eventStartsAt) ? { eventStartsAt: startsAt } : {}),
    ...(!same(endsAt, current.eventEndsAt) ? { eventEndsAt: endsAt } : {}),
    ...(deadline !== current.refundDeadline ? { refundDeadline: deadline } : {}),
    ...(form.allowDonation !== current.allowDonation ? { allowDonation: form.allowDonation } : {}),
    ...(cash !== current.cashAlertCents ? { cashAlertCents: cash } : {}),
  };
  return { ok: true, change };
}

/**
 * Terminada la fiesta (lo dice el API: `eventEnded`), el fin no se quita ni
 * se retrasa: el API daría 409 EVENT_LOCKED. Adelantarlo, sí.
 */
export function reopens(current: Pick<PartySettings, 'eventEnded' | 'eventEndsAt'>, endsAt: string | null): boolean {
  if (!current.eventEnded || !current.eventEndsAt) return false;
  return endsAt === null || Date.parse(endsAt) > Date.parse(current.eventEndsAt);
}

export function hasPartySettingsChange(dto: UpdatePartySettingsDto): boolean {
  return Object.entries(dto).some(([k, v]) => k !== 'totpCode' && v !== undefined);
}
