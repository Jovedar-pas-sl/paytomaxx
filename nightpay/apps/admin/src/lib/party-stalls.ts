// OxioParty · Casetas (lógica pura del formulario): nombre, responsable, la
// parte del organizador (un % o «barra propia»), el IBAN para pagarle y lo
// que ven los asistentes (zona, qué vende y «Abierta ahora»). Lo que se manda
// es lo que acepta /v1/admin/party/stalls (contracts/party.ts).

import {
  ORGANIZER_OWN_BAR_BPS,
  STALL_SELLS_MAX,
  STALL_ZONE_MAX,
  isValidIban,
  maskIban,
  normalizeIban,
  type CreateStallDto,
  type StallStaffPerson,
  type StallView,
  type UpdateStallDto,
} from '@nightpay/contracts';
import { bpsToPercentInput, formatBps, parsePercentToBps } from './commission';

export interface StallForm {
  name: string;
  managerName: string;
  managerContact: string;
  /** «10», «12,5»… (sin «barra propia»). */
  percent: string;
  ownBar: boolean;
  iban: string;
  active: boolean;
  /** Para los asistentes: dónde está y qué vende (vacío = sin decir). */
  zone: string;
  sells: string;
  openNow: boolean;
}

export const EMPTY_STALL_FORM: StallForm = {
  name: '',
  managerName: '',
  managerContact: '',
  percent: '',
  ownBar: false,
  iban: '',
  active: true,
  zone: '',
  sells: '',
  openNow: false,
};

export function stallFormFrom(s: StallView): StallForm {
  return {
    name: s.name,
    managerName: s.managerName,
    managerContact: s.managerContact ?? '',
    percent: s.ownBar ? '' : bpsToPercentInput(s.organizerBps),
    ownBar: s.ownBar,
    iban: s.iban ?? '',
    active: s.active,
    zone: s.zone ?? '',
    sells: s.sells ?? '',
    openNow: s.openNow,
  };
}

/** La parte del organizador que dice la caseta: «Barra propia» o «10 %». */
export function organizerText(bps: number): string {
  return bps === ORGANIZER_OWN_BAR_BPS ? 'Barra propia' : formatBps(bps);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

function parsedFields(form: StallForm): Parsed<{
  name: string;
  managerName: string;
  managerContact: string | null;
  organizerBps: number;
  iban: string | null;
  zone: string | null;
  sells: string | null;
}> {
  const name = form.name.trim();
  if (!name) return { ok: false, problem: 'Pon el nombre de la caseta.' };
  if (name.length > 80) return { ok: false, problem: 'El nombre de la caseta, como mucho 80 letras.' };
  const managerName = form.managerName.trim();
  if (!managerName) return { ok: false, problem: 'Pon el nombre del responsable.' };
  if (managerName.length > 120) return { ok: false, problem: 'El responsable, como mucho 120 letras.' };
  const contact = form.managerContact.trim();
  if (contact.length > 160) return { ok: false, problem: 'El contacto, como mucho 160 letras.' };
  const organizerBps = form.ownBar ? ORGANIZER_OWN_BAR_BPS : parsePercentToBps(form.percent);
  if (organizerBps === null) return { ok: false, problem: 'La parte del organizador: un porcentaje de 0 a 100 (por ejemplo 10 o 12,5).' };
  const ibanRaw = form.iban.trim();
  const iban = ibanRaw ? normalizeIban(ibanRaw) : null;
  if (iban && !isValidIban(iban)) return { ok: false, problem: 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra).' };
  const zone = form.zone.trim();
  if (zone.length > STALL_ZONE_MAX) return { ok: false, problem: `La zona, como mucho ${STALL_ZONE_MAX} letras.` };
  const sells = form.sells.trim();
  if (sells.length > STALL_SELLS_MAX) return { ok: false, problem: `Qué vende, como mucho ${STALL_SELLS_MAX} letras.` };
  return { ok: true, value: { name, managerName, managerContact: contact || null, organizerBps, iban, zone: zone || null, sells: sells || null } };
}

/** La caseta nueva o el motivo para no mandarla. */
export function createStallDto(form: StallForm): Parsed<CreateStallDto> {
  const parsed = parsedFields(form);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { ...parsed.value, active: form.active, openNow: form.openNow } };
}

/** Solo lo que cambia (vacío: nada que guardar) o el motivo para no mandarlo. */
export function updateStallDto(form: StallForm, current: StallView): Parsed<UpdateStallDto> {
  const parsed = parsedFields(form);
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const change: UpdateStallDto = {
    ...(v.name !== current.name ? { name: v.name } : {}),
    ...(v.managerName !== current.managerName ? { managerName: v.managerName } : {}),
    ...(v.managerContact !== current.managerContact ? { managerContact: v.managerContact } : {}),
    ...(v.organizerBps !== current.organizerBps ? { organizerBps: v.organizerBps } : {}),
    ...(v.iban !== current.iban ? { iban: v.iban } : {}),
    ...(form.active !== current.active ? { active: form.active } : {}),
    ...(v.zone !== current.zone ? { zone: v.zone } : {}),
    ...(v.sells !== current.sells ? { sells: v.sells } : {}),
    ...(form.openNow !== current.openNow ? { openNow: form.openNow } : {}),
  };
  return { ok: true, value: change };
}

/**
 * Con la fiesta terminada, el % de la organización de cada caseta queda fijo
 * (el API da 409 STALL_BPS_LOCKED): así el cierre no cambia. Lo demás, sí.
 */
export const STALL_BPS_LOCKED_NOTE =
  'La fiesta ha terminado: el % de la organización de cada caseta ya no se puede cambiar, así el cierre no cambia. El nombre, el responsable, el IBAN y lo demás, sí.';
export const STALL_BPS_LOCKED_HINT = 'La fiesta ha terminado: el % ya no se cambia.';

/** ¿Hay algo que guardar? (el 2FA no cuenta). */
export function hasStallChange(dto: UpdateStallDto): boolean {
  return Object.entries(dto).some(([k, v]) => k !== 'totpCode' && v !== undefined);
}

/** Para la tabla: el IBAN tapado, o «Falta IBAN» si se le tiene que pagar. */
export function stallIbanText(s: Pick<StallView, 'iban' | 'ownBar'>): { text: string; tone: 'success' | 'danger' | 'neutral' } {
  if (s.ownBar) return { text: 'No se paga', tone: 'neutral' };
  return s.iban ? { text: maskIban(s.iban) ?? 'IBAN listo', tone: 'success' } : { text: 'Falta IBAN', tone: 'danger' };
}

const ROLE_LABEL: Readonly<Record<StallStaffPerson['role'], string>> = {
  OWNER: 'Organizador',
  MANAGER: 'Encargado',
  WAITER: 'Camarero',
  OPERATOR: 'Personal',
};

export function staffRoleLabel(role: StallStaffPerson['role']): string {
  return ROLE_LABEL[role];
}

export function staffName(p: Pick<StallStaffPerson, 'displayName' | 'email'>): string {
  return p.displayName?.trim() || p.email;
}

/** Las casetas a las que se puede dar personal (activas), en su orden. */
export function assignableStalls(stalls: readonly StallView[]): StallView[] {
  return stalls.filter((s) => s.active);
}
