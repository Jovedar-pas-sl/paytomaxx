// Consola → «Socios»: el formulario de una plataforma (lo tecleado → lo que se
// manda a /v1/superadmin/partners), la lista de cambios al editar, lo que le
// falta para recibir claves y la congelación. El API lo vuelve a comprobar.

import {
  EEA_COUNTRIES,
  PARTNER_STEP_UP_FIELDS,
  partnerTextProblem,
  partnerTransferProblem,
  type CreatePartnerDto,
  type PartnerFreeze,
  type PartnerScope,
  type PartnerView,
  type UpdatePartnerDto,
} from '@nightpay/contracts';
import type { FormResult } from './forms';

export type PartnerBody = Omit<CreatePartnerDto, 'totpCode'>;
export type PartnerChanges = Partial<PartnerBody>;
type DataRole = NonNullable<PartnerBody['dataRole']>;

export interface PartnerForm {
  name: string;
  legalName: string;
  taxId: string;
  contactEmail: string;
  allowedScopes: PartnerScope[];
  channel: 'in_venue' | 'online';
  /** Una IP o red por línea. */
  egressIps: string;
  egressRangeReason: string;
  /** «2026-11-20» o vacío. */
  kybCheckedAt: string;
  kybNotes: string;
  dataRole: DataRole | '';
  dpaSignedAt: string;
  dpaVersion: string;
  dataCountry: string;
  transferMechanism: string;
  notes: string;
}

export const EMPTY_PARTNER_FORM: PartnerForm = {
  name: '',
  legalName: '',
  taxId: '',
  contactEmail: '',
  allowedScopes: ['wallet:balance'],
  channel: 'in_venue',
  egressIps: '',
  egressRangeReason: '',
  kybCheckedAt: '',
  kybNotes: '',
  dataRole: '',
  dpaSignedAt: '',
  dpaVersion: '',
  dataCountry: '',
  transferMechanism: '',
  notes: '',
};

export const COLLECTION_TEXT = 'Quién cobra: el local';

export const DATA_ROLE_LABELS: Readonly<Record<DataRole, string>> = {
  PROCESSOR_OF_VENUE: 'Encargada del tratamiento (trata los datos por cuenta del local)',
  INDEPENDENT_CONTROLLER: 'Responsable independiente',
};

export const CHANNEL_LABELS: Readonly<Record<PartnerForm['channel'], string>> = {
  in_venue: 'En el local (un cajero, una máquina)',
  online: 'Por internet',
};

export const FREEZE_CHOICES: ReadonlyArray<{ value: PartnerFreeze; label: string; hint: string }> = [
  { value: 'none', label: 'Funciona', hint: 'Las claves funcionan con sus permisos.' },
  { value: 'money', label: 'Congelado lo que mueve dinero', hint: 'Ninguna clave carga, paga ni cobra; ver el saldo sigue.' },
  { value: 'all', label: 'Todo congelado', hint: 'Ninguna clave entra: la API contesta como si no existiera.' },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAX_ID = /^[A-Z0-9]{5,20}$/;
const RANGE_NEEDS_REASON = 'Un rango de más de una dirección necesita el motivo.';
const MAX_EGRESS_IPS = 20;

const ok = <T>(value: T): FormResult<T> => ({ ok: true, value });
const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });
const textOrNull = (s: string): string | null => (s.trim() ? s.trim() : null);
/** Un día del formulario → mediodía UTC de ese día (no cambia de día en ninguna zona de Europa). */
const dayToIso = (day: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00.000Z` : null);
const isoToDay = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

/** Más de una dirección: IPv4 con prefijo de menos de /32, IPv6 de menos de /128. */
function widerThanAddress(entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash < 0) return false;
  const prefix = Number(entry.slice(slash + 1));
  return prefix < (entry.includes(':') ? 128 : 32);
}

export function parseIpLines(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean))];
}

export function partnerFormOf(p: PartnerView, patch: Partial<PartnerForm> = {}): PartnerForm {
  return {
    name: p.name,
    legalName: p.legalName,
    taxId: p.taxId,
    contactEmail: p.contactEmail,
    allowedScopes: [...p.allowedScopes],
    channel: p.channel,
    egressIps: p.egressIps.join('\n'),
    egressRangeReason: p.egressRangeReason ?? '',
    kybCheckedAt: isoToDay(p.kybCheckedAt),
    kybNotes: p.kybNotes ?? '',
    dataRole: p.dataRole ?? '',
    dpaSignedAt: isoToDay(p.dpaSignedAt),
    dpaVersion: p.dpaVersion ?? '',
    dataCountry: p.dataCountry ?? '',
    transferMechanism: p.transferMechanism ?? '',
    notes: p.notes ?? '',
    ...patch,
  };
}

export function partnerPayload(form: PartnerForm): FormResult<PartnerBody> {
  const name = form.name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (partnerTextProblem(form.name)) return fail('El nombre, sin enlaces, dominios, < ni >.');
  if (name.length < 2 || name.length > 30) return fail('El nombre, de 2 a 30 caracteres.');
  const legalName = form.legalName.trim();
  if (legalName.length < 2) return fail('Pon la razón social.');
  const taxId = form.taxId.replace(/[\s.-]+/g, '').toUpperCase();
  if (!TAX_ID.test(taxId)) return fail('NIF/CIF: de 5 a 20 letras o cifras.');
  const contactEmail = form.contactEmail.trim();
  if (!EMAIL.test(contactEmail)) return fail('El correo de contacto no es válido.');
  if (form.allowedScopes.length === 0) return fail('Marca al menos un permiso.');
  const egressIps = parseIpLines(form.egressIps);
  if (egressIps.length > MAX_EGRESS_IPS) return fail(`Como mucho ${MAX_EGRESS_IPS} IP.`);
  const egressRangeReason = textOrNull(form.egressRangeReason);
  if (egressIps.some(widerThanAddress) && !egressRangeReason) return fail(RANGE_NEEDS_REASON);
  const dataCountry = form.dataCountry.trim().toUpperCase() || null;
  if (dataCountry && !/^[A-Z]{2}$/.test(dataCountry)) return fail('País: el código de dos letras (ES, PT…).');
  const transferMechanism = textOrNull(form.transferMechanism);
  const transfer = partnerTransferProblem(dataCountry, transferMechanism);
  if (transfer) return fail(transfer);
  return ok({
    name,
    legalName,
    taxId,
    contactEmail,
    allowedScopes: [...form.allowedScopes],
    channel: form.channel,
    egressIps,
    egressRangeReason,
    kybCheckedAt: dayToIso(form.kybCheckedAt),
    kybNotes: textOrNull(form.kybNotes),
    dataRole: form.dataRole || null,
    dpaSignedAt: dayToIso(form.dpaSignedAt),
    dpaVersion: textOrNull(form.dpaVersion),
    dataCountry,
    transferMechanism,
    notes: textOrNull(form.notes),
  });
}

const DATE_FIELDS = new Set<keyof PartnerBody>(['kybCheckedAt', 'dpaSignedAt']);

function same(key: keyof PartnerBody, a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (DATE_FIELDS.has(key)) return isoToDay((a as string | null) ?? null) === isoToDay((b as string | null) ?? null);
  return (a ?? null) === (b ?? null);
}

/** Solo lo que cambia respecto a la ficha (lo que se manda al editar). */
export function partnerChanges(before: PartnerView, after: PartnerBody): PartnerChanges {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as Array<keyof PartnerBody>) {
    if (!same(key, before[key as keyof PartnerView], after[key])) out[key] = after[key];
  }
  return out as PartnerChanges;
}

/** Editar pide 2FA si cambian permisos, IP, KYB o el contrato de datos. */
export function updateNeedsTotp(changes: Partial<UpdatePartnerDto>): boolean {
  return PARTNER_STEP_UP_FIELDS.some((f) => changes[f] !== undefined);
}

/** Lo que le falta para que el dueño pueda conectarla (vacío: lista). */
export function partnerMissing(p: PartnerView): string[] {
  if (p.status !== 'ACTIVE') return ['quitarle la suspensión'];
  const out: string[] = [];
  if (!p.kybCheckedAt) out.push('el KYB');
  if (!p.dataRole) out.push('su papel con los datos');
  if (!p.dpaSignedAt) out.push('la firma del contrato de datos');
  if (!p.dpaVersion) out.push('la versión del contrato de datos');
  if (!p.dataCountry) out.push('el país donde guarda los datos');
  else if (!(EEA_COUNTRIES as readonly string[]).includes(p.dataCountry) && !p.transferMechanism?.trim()) {
    out.push('el mecanismo de transferencia');
  }
  return out;
}
