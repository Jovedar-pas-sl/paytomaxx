// Ajustes → «Otras plataformas» (API de socios): lo que el panel decide antes
// de llamar a /v1/admin/partner-connections, sin React. El API lo vuelve a
// comprobar todo (manda él); aquí se evita mandar lo que seguro que rechaza y
// se dice en llano, con sus mismos textos.
//
// La clave NUNCA pasa por aquí salvo en `issuedOutcome`, que solo la devuelve
// a la hoja que la enseña: nada de guardarla, ni en el navegador ni en la URL.

import {
  EXPIRY_REQUIRED_SCOPES,
  type CreatePartnerConnectionDto,
  type PartnerConnectionView,
  type PartnerKeyDelivery,
  type PartnerKeyIssued,
  type PartnerKeyOverlap,
  type PartnerOptionView,
  type PartnerScope,
  type RotatePartnerKeyDto,
} from '@nightpay/contracts';

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

export type ConnectionAction = 'rotate' | 'pause' | 'resume' | 'revoke';

export const ACTION_LABELS: Readonly<Record<ConnectionAction, string>> = {
  rotate: CHANGE_KEY_LABEL,
  pause: 'Pausar',
  resume: 'Reanudar',
  revoke: 'Anular',
};

/**
 * Los botones de una conexión: el dueño conecta, cambia la clave, pausa,
 * reanuda (no la pausa de OxioPay) y anula; el encargado pausa y anula.
 */
export function connectionActions(c: PartnerConnectionView, role: string): ConnectionAction[] {
  if (c.state === 'revoked') return [];
  const isOwner = role === 'OWNER';
  const paused = c.state === 'paused' || c.pausedBy !== null;
  const stopped = paused || c.state === 'dormant' || c.state === 'expired';
  if (!isOwner) return stopped ? ['revoke'] : ['pause', 'revoke'];
  if (c.state === 'expired' || c.pausedBy === 'oxiopay') return ['rotate', 'revoke'];
  if (paused || c.state === 'dormant') return ['resume', 'rotate', 'revoke'];
  return ['rotate', 'pause', 'revoke'];
}

export interface ConnectionNotice {
  tone: 'danger' | 'warning';
  title: string;
  text: string;
  /** El botón (solo el dueño cambia la clave); null: sin botón. */
  action: string | null;
}

/** Avisos que se quedan en la ficha: la clave usada desde otra IP o mandada en una dirección web. */
export function connectionNotices(c: PartnerConnectionView, role: string): ConnectionNotice[] {
  if (c.state === 'revoked') return [];
  const action = role === 'OWNER' ? CHANGE_KEY_LABEL : null;
  const out: ConnectionNotice[] = [];
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
