// Ajustes → «Otras plataformas» (API de socios): lo que el panel decide antes
// de llamar a /v1/admin/partner-connections, sin React. El API lo vuelve a
// comprobar todo (manda él); aquí se evita mandar lo que seguro que rechaza y
// se dice en llano, con sus mismos textos.
//
// La clave NUNCA pasa por aquí salvo en `issuedOutcome`, que solo la devuelve
// a la hoja que la enseña: nada de guardarla, ni en el navegador ni en la URL.

import {
  EXPIRY_REQUIRED_SCOPES,
  LOAD_CAPS,
  LOAD_PANEL_VOID_WINDOW_MS,
  parseEuroCents,
  stepUpActions,
  type CreatePartnerConnectionDto,
  type PartnerConnectionLimits,
  type PartnerConnectionView,
  type PartnerKeyDelivery,
  type PartnerKeyIssued,
  type PartnerKeyOverlap,
  type PartnerLoadAdminView,
  type PartnerOptionView,
  type PartnerOwnerStatement,
  type PartnerPauseReason,
  type PartnerScope,
  type RotatePartnerKeyDto,
} from '@nightpay/contracts';
import { centsToInput, formatEur } from './money';
import { addDays as addNightDays } from './reservations';

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): FormResult<T> => ({ ok: true, value });
const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });

/** Lo que puede hacer cada permiso, en llano (los dos primeros son los que hoy se dan). */
export const SCOPE_LABELS: Readonly<Record<PartnerScope, string>> = {
  'wallet:balance': 'Ver el saldo de un cliente',
  'wallet:load': 'Cargar saldo',
  'wallet:pay': 'Pagar con el saldo',
  'charges:write': 'Cobrar',
  'charges:read': 'Ver los cobros',
  'reports:read': 'Ver los informes',
};

export const PAUSED_BY_OXIOPAY_LABEL = 'En pausa por OxioPay';
export const CHANGE_KEY_LABEL = 'Cambiar clave';

// Textos del API (A7), los mismos aquí para no mandar lo que va a rechazar.
const TEXT_EXPIRY = 'La caducidad va de mañana a un año; para cargar saldo es obligatoria.';
const TEXT_SCOPE = 'Esa plataforma no tiene ese permiso.';
const TEXT_EMAIL_OFF = 'Este servidor no envía correos: elige «La copio yo».';
const TEXT_FOREIGN = 'Se rechazó una clave usada desde una IP ajena: si no es de la plataforma, cámbiala.';
const TEXT_EXPOSED = 'Una plataforma mandó su clave en una dirección web: cámbiala.';

/** Los tonos de Etiqueta que se usan aquí. */
export type ConnectionTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface ConnectionTag {
  tone: ConnectionTone;
  label: string;
}

/** La etiqueta de estado de una conexión (símbolo + palabra). */
export function connectionTag(c: PartnerConnectionView): ConnectionTag {
  if (c.state === 'revoked') return { tone: 'neutral', label: 'Anulada' };
  if (c.state === 'expired') return { tone: 'danger', label: 'Caducada' };
  if (c.pausedBy === 'oxiopay') return { tone: 'warning', label: PAUSED_BY_OXIOPAY_LABEL };
  if (c.pausedBy === 'foreign_ip') return { tone: 'danger', label: 'En pausa: usada desde otra IP' };
  if (c.state === 'dormant') return { tone: 'neutral', label: 'Dormida' };
  if (c.state === 'paused' || c.pausedBy) return { tone: 'warning', label: 'En pausa' };
  return { tone: 'success', label: 'Activa' };
}

export type ConnectionAction = 'movements' | 'limits' | 'rotate' | 'pause' | 'resume' | 'revoke';

export const ACTION_LABELS: Readonly<Record<ConnectionAction, string>> = {
  movements: 'Movimientos',
  limits: 'Topes',
  rotate: CHANGE_KEY_LABEL,
  pause: 'Pausar',
  resume: 'Reanudar',
  revoke: 'Anular',
};

/**
 * Los botones de una conexión: «Movimientos» para el dueño y el encargado,
 * también en una anulada (el recuento de la mañana); «Topes», solo el dueño
 * y no en una anulada. Además, el dueño cambia la clave, pausa, reanuda (no
 * la pausa de OxioPay) y anula (tampoco la pausa de OxioPay); el encargado
 * pausa y anula (no la pausa de OxioPay).
 */
export function connectionActions(c: PartnerConnectionView, role: string): ConnectionAction[] {
  if (c.state === 'revoked') return ['movements'];
  const isOwner = role === 'OWNER';
  const paused = c.state === 'paused' || c.pausedBy !== null;
  const stopped = paused || c.state === 'dormant' || c.state === 'expired';
  // La pausa de OxioPay no se reanuda ni se anula desde aquí (el API dice 409: habla con OxioPay).
  const byOxioPay = c.pausedBy === 'oxiopay';
  if (!isOwner) return byOxioPay ? ['movements'] : stopped ? ['movements', 'revoke'] : ['movements', 'pause', 'revoke'];
  const head: ConnectionAction[] = ['movements', 'limits'];
  if (byOxioPay) return [...head, 'rotate'];
  if (c.state === 'expired') return [...head, 'rotate', 'revoke'];
  if (paused || c.state === 'dormant') return [...head, 'resume', 'rotate', 'revoke'];
  return [...head, 'rotate', 'pause', 'revoke'];
}

export interface ConnectionNotice {
  tone: 'danger' | 'warning';
  title: string;
  text: string;
  /** El botón (solo el dueño cambia la clave); null: sin botón. */
  action: string | null;
}

/** Las pausas automáticas de las cargas (las quita el dueño con «Reanudar», con su 2FA). */
const LOAD_PAUSE_TEXT: Partial<Record<PartnerPauseReason, string>> = {
  load_refusals: 'En pausa: 3 cargas por encima del máximo por recarga en 10 minutos.',
  load_burst: 'En pausa: más de 30 cargas en un minuto.',
  load_voids: 'En pausa: 3 cargas anuladas por la plataforma esta noche.',
};

/**
 * Avisos que se quedan en la ficha: la clave usada desde otra IP o mandada en
 * una dirección web, y las cargas en pausa (por qué).
 */
export function connectionNotices(c: PartnerConnectionView, role: string): ConnectionNotice[] {
  if (c.state === 'revoked') return [];
  const action = role === 'OWNER' ? CHANGE_KEY_LABEL : null;
  const out: ConnectionNotice[] = [];
  const loadPause = c.pausedBy ? LOAD_PAUSE_TEXT[c.pausedBy] : undefined;
  if (loadPause) out.push({ tone: 'warning', title: 'Cargas en pausa', text: loadPause, action: null });
  if (c.keyExposedAt) out.push({ tone: 'danger', title: 'Clave en una dirección web', text: TEXT_EXPOSED, action });
  if (c.foreignIps.length > 0) {
    const ips = [...new Set(c.foreignIps.map((f) => f.ip))].join(', ');
    out.push({ tone: 'danger', title: 'Clave usada desde otra IP', text: `${TEXT_FOREIGN} IP: ${ips}.`, action });
  }
  return out;
}

export const OVERLAP_CHOICES: ReadonlyArray<{ value: PartnerKeyOverlap; label: string }> = [
  { value: 'none', label: 'Nada' },
  { value: '24h', label: '24 horas' },
  { value: '7d', label: '7 días' },
];

/** Con una IP ajena o la clave a la vista, la de ahora deja de valer al momento («Nada»). */
export function suggestedOverlap(c: PartnerConnectionView): PartnerKeyOverlap {
  return c.foreignIps.length > 0 || c.keyExposedAt ? 'none' : '24h';
}

export function deliveryChoices(
  emailEnabled: boolean,
  maskedEmail: string | null,
): Array<{ value: PartnerKeyDelivery; label: string; hint: string }> {
  const copy = { value: 'copy' as const, label: 'La copio yo', hint: 'La ves aquí una sola vez y se la pasas tú a la plataforma.' };
  if (!emailEnabled) return [copy];
  return [
    copy,
    {
      value: 'email',
      label: maskedEmail ? `Enviarle un enlace a ${maskedEmail}` : 'Enviarle un enlace por correo',
      hint: 'Le llega un enlace que se abre una sola vez y caduca en 24 horas. Tú no ves la clave.',
    },
  ];
}

// ─── Las IP ─────────────────────────────────────────────────────────────

/** Una entrada de una sola dirección (o IPv6 de /64 a /128): la que lleva una clave. */
function isSingle(entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash < 0) return true;
  const prefix = Number(entry.slice(slash + 1));
  return entry.includes(':') ? prefix >= 64 && prefix <= 128 : prefix === 32;
}

/**
 * Las IP que declaró la plataforma: las sueltas se pueden marcar; los rangos
 * no (una clave lleva direcciones sueltas y aquí no se escribe ninguna).
 */
export function splitPartnerIps(egressIps: readonly string[]): { pickable: string[]; ranges: string[] } {
  return { pickable: egressIps.filter(isSingle), ranges: egressIps.filter((e) => !isSingle(e)) };
}

export const MAX_CONNECTION_IPS = 10;

// ─── La caducidad ───────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Del calendario: de mañana a un año (364 días: a las 23:59 cabe en los 365 del API); se propone el año. */
export function expiryBounds(now: Date): { min: string; max: string; suggested: string } {
  const max = dayOf(addDays(now, 364));
  return { min: dayOf(addDays(now, 1)), max, suggested: max };
}

/** «2027-06-30» → ese día a las 23:59, hora de este navegador; null si no es una fecha. */
export function expiryToIso(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 23, 59);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

export function expiryRequired(scopes: readonly PartnerScope[]): boolean {
  return scopes.some((s) => (EXPIRY_REQUIRED_SCOPES as readonly string[]).includes(s));
}

function expiryValue(noExpiry: boolean, day: string, scopes: readonly PartnerScope[], now: Date): FormResult<string | null> {
  if (noExpiry) return expiryRequired(scopes) ? fail(TEXT_EXPIRY) : ok(null);
  const iso = expiryToIso(day);
  const { min, max } = expiryBounds(now);
  if (!iso || day < min || day > max) return fail(TEXT_EXPIRY);
  return ok(iso);
}

// ─── Lo que se manda ────────────────────────────────────────────────────

export interface ConnectForm {
  partnerId: string;
  scopes: PartnerScope[];
  ips: string[];
  noExpiry: boolean;
  expiryDay: string;
  delivery: PartnerKeyDelivery;
}

export type CreateBody = Omit<CreatePartnerConnectionDto, 'totpCode'>;
export type RotateBody = Omit<RotatePartnerKeyDto, 'totpCode'>;

export function createPayload(form: ConnectForm, partner: PartnerOptionView | null, emailEnabled: boolean, now: Date): FormResult<CreateBody> {
  if (!form.partnerId || !partner || partner.id !== form.partnerId) return fail('Elige la plataforma.');
  if (form.scopes.length === 0) return fail('Marca al menos un permiso.');
  if (form.scopes.some((s) => !partner.allowedScopes.includes(s))) return fail(TEXT_SCOPE);
  const { pickable } = splitPartnerIps(partner.egressIps);
  const outside = form.ips.find((ip) => !pickable.includes(ip));
  if (outside) return fail(`${outside} no está entre las que declaró a OxioPay.`);
  if (form.ips.length > MAX_CONNECTION_IPS) return fail(`Como mucho ${MAX_CONNECTION_IPS} IP por conexión.`);
  const expiresAt = expiryValue(form.noExpiry, form.expiryDay, form.scopes, now);
  if (!expiresAt.ok) return expiresAt;
  if (form.delivery === 'email' && !emailEnabled) return fail(TEXT_EMAIL_OFF);
  return ok({
    partnerId: partner.id,
    scopes: partner.allowedScopes.filter((s) => form.scopes.includes(s)),
    ipAllowlist: pickable.filter((ip) => form.ips.includes(ip)),
    expiresAt: expiresAt.value,
    delivery: form.delivery,
  });
}

export interface RotateForm {
  overlap: PartnerKeyOverlap;
  noExpiry: boolean;
  expiryDay: string;
  delivery: PartnerKeyDelivery;
}

export function rotatePayload(form: RotateForm, c: PartnerConnectionView, emailEnabled: boolean, now: Date): FormResult<RotateBody> {
  const expiresAt = expiryValue(form.noExpiry, form.expiryDay, c.scopes, now);
  if (!expiresAt.ok) return expiresAt;
  if (form.delivery === 'email' && !emailEnabled) return fail(TEXT_EMAIL_OFF);
  return ok({ overlap: form.overlap, expiresAt: expiresAt.value, delivery: form.delivery });
}

// ─── Lo que sale ────────────────────────────────────────────────────────

export type IssuedOutcome =
  | { kind: 'key'; key: string }
  | { kind: 'sent'; sentTo: string | null; expiresAt: string | null }
  /** El correo no salió: el API borró la clave sellada y nadie la tiene. */
  | { kind: 'failed' };

export function issuedOutcome(issued: PartnerKeyIssued): IssuedOutcome {
  if (issued.key) return { kind: 'key', key: issued.key };
  if (issued.claim.delivered) return { kind: 'sent', sentTo: issued.claim.sentTo, expiresAt: issued.claim.expiresAt };
  return { kind: 'failed' };
}

// ─── «Movimientos»: las cargas de una noche (PR 3 B) ─────────────────────

export const NIGHT_WINDOW_TEXT = 'La noche va de 08:00 a 08:00.';
export const COUNT_CASH_TEXT = 'Cuenta este efectivo en sus cajeros: tiene que dar el neto.';
export const NO_LOADS_TEXT = 'Esta noche no hay cargas.';
export const NO_DEVICE_LABEL = 'Sin cajero';
export const LOAD_VOIDED_NOTICE = 'Carga anulada.';

/** La noche anterior y la siguiente; null: la siguiente sería después de hoy. */
export function nightNav(day: string, today: string): { previous: string; next: string | null } {
  const next = addNightDays(day, 1);
  return { previous: addNightDays(day, -1), next: next <= today ? next : null };
}

export interface StatementTotal {
  key: 'loads' | 'voids' | 'net';
  label: string;
  /** null: el neto no lleva número de cargas. */
  count: number | null;
  cents: number;
}

/** «Cargas», «Anuladas» y «Neto» de la noche (el `/statement` del socio). */
export function statementTotals(st: PartnerOwnerStatement): StatementTotal[] {
  return [
    { key: 'loads', label: 'Cargas', count: st.loads.count, cents: st.loads.amount },
    { key: 'voids', label: 'Anuladas', count: st.load_voids.count, cents: st.load_voids.amount },
    { key: 'net', label: 'Neto', count: null, cents: st.net_loads },
  ];
}

/** El cajero de una carga (el `device` que manda la plataforma); sin él, «Sin cajero». */
export function deviceLabel(device: string | null): string {
  return device && device.trim() ? device : NO_DEVICE_LABEL;
}

/** Una carga anulada: quién la anuló y por qué. null: no está anulada. */
export function loadState(load: PartnerLoadAdminView): { label: string; reason: string | null } | null {
  if (load.status !== 'voided') return null;
  return { label: load.voidedBy === 'venue' ? 'Anulada en el panel' : 'Anulada por la plataforma', reason: load.reason };
}

/**
 * «Anular carga»: sin anular y con menos de 36 h desde la carga (el panel). No
 * `voidUntil`, que son los 10 minutos del socio por la API. Lo decide el
 * servidor: aquí solo se esconde el botón.
 */
export function canVoidLoad(load: PartnerLoadAdminView, nowMs: number): boolean {
  return load.status === 'succeeded' && !load.voidedAt && Date.parse(load.createdAt) + LOAD_PANEL_VOID_WINDOW_MS > nowMs;
}

export const VOID_REASON_MAX = 140;
const VOID_REASON_TEXT = 'Explica por qué se anula';

/** El motivo de la anulación: de 3 a 140 letras (como PartnerLoadVoidSchema). */
export function voidReasonProblem(reason: string): string | null {
  const t = reason.trim();
  return t.length >= 3 && t.length <= VOID_REASON_MAX ? null : VOID_REASON_TEXT;
}

/** Lo que pasa al anular una carga. */
export function voidLoadWarning(amountCents: number): string {
  return `El saldo del cliente baja ${formatEur(amountCents)} y le llega el aviso «Carga anulada». Hazlo solo si el dinero no se quedó en el local.`;
}

// ─── «Topes» (solo el dueño) ──────────────────────────────────────────

export const LIMITS_START_TEXT = 'Si los cajeros se vacían menos de una vez al día, empieza con 2.000 € por noche.';

export interface LimitsForm {
  perOperation: string;
  walletDay: string;
  night: string;
}

export const LIMIT_FIELDS: ReadonlyArray<{ key: keyof LimitsForm; cents: keyof PartnerConnectionLimits; label: string; max: number }> = [
  { key: 'perOperation', cents: 'perOperationCents', label: 'Máximo por recarga', max: LOAD_CAPS.perOperation.max },
  { key: 'walletDay', cents: 'walletDayCents', label: 'Máximo por cliente al día', max: LOAD_CAPS.walletDay.max },
  { key: 'night', cents: 'nightCents', label: 'Máximo por noche', max: LOAD_CAPS.night.max },
];

/** Los topes de ahora, en euros como se escriben («300», «10,50»). */
export function limitsFormOf(l: PartnerConnectionLimits): LimitsForm {
  const euros = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : centsToInput(cents));
  return { perOperation: euros(l.perOperationCents), walletDay: euros(l.walletDayCents), night: euros(l.nightCents) };
}

/**
 * Lo que se manda al cambiar los topes y si sube alguno (entonces, la 2FA).
 * El API lo vuelve a mirar con los topes de ese momento (PARTNER_LIMITS_CHANGED).
 */
export function limitsPayload(
  form: LimitsForm,
  current: PartnerConnectionLimits,
): FormResult<{ body: PartnerConnectionLimits; raises: boolean }> {
  const body: PartnerConnectionLimits = { perOperationCents: 0, walletDayCents: 0, nightCents: 0 };
  for (const f of LIMIT_FIELDS) {
    const cents = parseEuroCents(form[f.key], f.max);
    if (cents === null) {
      return fail(`El ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)} va de ${formatEur(1)} a ${formatEur(f.max)}.`);
    }
    body[f.cents] = cents;
  }
  const same = LIMIT_FIELDS.every((f) => body[f.cents] === current[f.cents]);
  if (same) return fail('No has cambiado ningún tope.');
  const raises = LIMIT_FIELDS.some((f) => body[f.cents] > current[f.cents]);
  return ok({ body, raises });
}

/** La acción de la llave para subir los topes: partner:limits:<conexión>:<op>-<día>-<noche> (céntimos). */
export function limitsStepUpAction(id: string, body: PartnerConnectionLimits): string {
  return stepUpActions.partner('limits', id, `${body.perOperationCents}-${body.walletDayCents}-${body.nightCents}`);
}
