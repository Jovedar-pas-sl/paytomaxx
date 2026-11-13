import { isEventEnded, partySettingsProblem, type PartySettings, type UpdatePartySettingsDto } from '@nightpay/contracts';

/** Lo que se lee del local para los ajustes de la fiesta. */
export const PARTY_SETTINGS_SELECT = {
  eventStartsAt: true,
  eventEndsAt: true,
  refundDeadline: true,
  allowDonation: true,
  cashAlertCents: true,
} as const;

export interface PartySettingsRow {
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  /** DATE de Postgres: medianoche UTC de ese día. */
  refundDeadline: Date | null;
  allowDonation: boolean;
  cashAlertCents: number;
}

/** AAAA-MM-DD de un DATE (Prisma lo da a medianoche UTC). */
function dayOf(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function partySettingsView(row: PartySettingsRow, now: Date = new Date()): PartySettings {
  return {
    eventStartsAt: row.eventStartsAt?.toISOString() ?? null,
    eventEndsAt: row.eventEndsAt?.toISOString() ?? null,
    refundDeadline: dayOf(row.refundDeadline),
    allowDonation: row.allowDonation,
    cashAlertCents: row.cashAlertCents,
    eventEnded: isEventEnded(row.eventEndsAt, now),
  };
}

export type PartySettingsPlan = { ok: true; change: Partial<PartySettingsRow> } | { ok: false; problem: string };

/**
 * El cambio (solo lo que cambia de verdad) y si lo que queda vale: el fin de
 * la fiesta, después del inicio.
 */
export function planPartySettingsChange(current: PartySettingsRow, dto: UpdatePartySettingsDto): PartySettingsPlan {
  const next: Partial<PartySettingsRow> = {};
  if (dto.eventStartsAt !== undefined) next.eventStartsAt = dto.eventStartsAt === null ? null : new Date(dto.eventStartsAt);
  if (dto.eventEndsAt !== undefined) next.eventEndsAt = dto.eventEndsAt === null ? null : new Date(dto.eventEndsAt);
  if (dto.refundDeadline !== undefined) {
    next.refundDeadline = dto.refundDeadline === null ? null : new Date(`${dto.refundDeadline}T00:00:00Z`);
  }
  if (dto.allowDonation !== undefined) next.allowDonation = dto.allowDonation;
  if (dto.cashAlertCents !== undefined) next.cashAlertCents = dto.cashAlertCents;

  const change: Partial<PartySettingsRow> = {};
  for (const [key, value] of Object.entries(next) as Array<[keyof PartySettingsRow, PartySettingsRow[keyof PartySettingsRow]]>) {
    if (!sameValue(current[key], value)) (change as Record<string, unknown>)[key] = value;
  }
  const merged = { ...current, ...change };
  const problem = partySettingsProblem(merged);
  return problem ? { ok: false, problem } : { ok: true, change };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}
