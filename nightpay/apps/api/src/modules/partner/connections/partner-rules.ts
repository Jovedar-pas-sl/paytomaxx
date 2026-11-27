import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import {
  EEA_COUNTRIES,
  EXPIRY_REQUIRED_SCOPES,
  IP_REQUIRED_SCOPES,
  PARTNER_SCOPES,
  maskEmail,
  publicId,
  type PartnerConnectionState,
  type PartnerConnectionView,
  type PartnerKeyMode,
  type PartnerOptionView,
  type PartnerPauseReason,
  type PartnerScope,
} from '@nightpay/contracts';
import { ipEntryInside, ipEntryProblem, normalizeIpEntry } from '../auth/partner-ip';
import { DORMANT_AFTER_MS } from '../auth/partner-key.guard';

/** Reglas puras de dar y quitar claves (el dueño y la consola): sin base ni Nest. */

const DAY_MS = 86_400_000;
/** La caducidad, de mañana a un año (365 × 24 h, como el CHECK de la base). */
export const KEY_EXPIRY_MIN_MS = DAY_MS - 60_000;
export const KEY_EXPIRY_MAX_MS = 365 * DAY_MS;

/** Errores de la gestión (texto para el dueño y `code` estable para el panel). */
export const PARTNER_ADMIN_ERRORS = {
  PARTNER_CONNECTION_NOT_FOUND: { status: HttpStatus.NOT_FOUND, message: 'Esa conexión no existe.' },
  PARTNER_NOT_READY: {
    status: HttpStatus.CONFLICT,
    message: 'Esa plataforma aún no está lista: falta el KYB o el contrato de datos.',
  },
  PARTNER_ALREADY_CONNECTED: { status: HttpStatus.CONFLICT, message: 'Ya está conectada: cambia su clave o anúlala antes.' },
  PARTNER_VENUE_NO_BUSINESS: { status: HttpStatus.CONFLICT, message: 'Este local no tiene sociedad con CIF en OxioPay.' },
  PARTNER_EMAIL_OFF: { status: HttpStatus.CONFLICT, message: 'Este servidor no envía correos: elige «La copio yo».' },
  PARTNER_CONNECTION_REVOKED: { status: HttpStatus.CONFLICT, message: 'Está anulada: conéctala otra vez.' },
  PARTNER_PAUSED_BY_OXIOPAY: { status: HttpStatus.CONFLICT, message: 'La pausó OxioPay: habla con OxioPay.' },
  PARTNER_SCOPE_NOT_ALLOWED: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Esa plataforma no tiene ese permiso.' },
  PARTNER_IP_REQUIRED: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Para cargar saldo hacen falta las IP de sus servidores.' },
  PARTNER_IP_INVALID: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Esa IP no vale.' },
  PARTNER_IP_OUTSIDE: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: 'Esa IP no está entre las que declaró a OxioPay.' },
  PARTNER_EXPIRY_INVALID: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'La caducidad va de mañana a un año; para cargar saldo es obligatoria.',
  },
} as const;
export type PartnerAdminErrorCode = keyof typeof PARTNER_ADMIN_ERRORS;

export function adminError(code: PartnerAdminErrorCode, message?: string): HttpException {
  const def = PARTNER_ADMIN_ERRORS[code];
  const body = { code, message: message ?? def.message };
  if (def.status === HttpStatus.NOT_FOUND) return new NotFoundException(body);
  if (def.status === HttpStatus.CONFLICT) return new ConflictException(body);
  return new HttpException(body, def.status);
}

export interface ReadinessFields {
  status: string;
  kybCheckedAt: Date | null;
  dataRole: string | null;
  dpaSignedAt: Date | null;
  dpaVersion: string | null;
  dataCountry: string | null;
  transferMechanism: string | null;
}

/** Lista para dar claves: activa, con KYB y contrato de datos (y, fuera del EEE, el mecanismo de transferencia). */
export function partnerReady(p: ReadinessFields): boolean {
  if (p.status !== 'ACTIVE' || !p.kybCheckedAt || !p.dataRole || !p.dpaSignedAt || !p.dpaVersion || !p.dataCountry) return false;
  return (EEA_COUNTRIES as readonly string[]).includes(p.dataCountry) || Boolean(p.transferMechanism?.trim());
}

/** En el orden de PARTNER_SCOPES (como los guarda la base y los enseña GET /me). */
export function sortScopes(scopes: readonly string[]): PartnerScope[] {
  return PARTNER_SCOPES.filter((s) => scopes.includes(s));
}

/** La caducidad que pide el dueño: null solo sin permisos que la exigen. */
export function expiryProblem(expiresAt: Date | null, scopes: readonly string[], now: Date): boolean {
  if (expiresAt === null) return scopes.some((s) => (EXPIRY_REQUIRED_SCOPES as readonly string[]).includes(s));
  const ahead = expiresAt.getTime() - now.getTime();
  return ahead < KEY_EXPIRY_MIN_MS || ahead > KEY_EXPIRY_MAX_MS;
}

/** Las IP de una clave: sueltas y públicas, dentro de las del socio; en live, obligatorias para cargar. */
export function connectionIps(raw: readonly string[], partnerEgress: readonly string[], scopes: readonly string[], mode: PartnerKeyMode): string[] {
  for (const entry of raw) {
    const problem = ipEntryProblem(entry, 'connection');
    if (problem) throw adminError('PARTNER_IP_INVALID', problem);
  }
  const ips = [...new Set(raw.map(normalizeIpEntry))];
  const outside = ips.find((ip) => !ipEntryInside(ip, partnerEgress));
  if (outside) throw adminError('PARTNER_IP_OUTSIDE', `${outside} no está entre las que declaró a OxioPay.`);
  const needsIps = scopes.some((s) => (IP_REQUIRED_SCOPES as readonly string[]).includes(s));
  if (mode === 'live' && needsIps && ips.length === 0) throw adminError('PARTNER_IP_REQUIRED');
  return ips;
}

export interface ViewRow {
  id: string;
  partnerId: string;
  status: string;
  pausedReason: string | null;
  scopes: string[];
  pausedScopes: string[];
  keyMode: string;
  keyHint: string;
  keyCreatedAt: Date;
  keyExpiresAt: Date | null;
  prevKeyExpiresAt: Date | null;
  keyExposedAt: Date | null;
  keySuspendedAt: Date | null;
  keyResumedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  ipAllowlist: string[];
  createdAt: Date;
  partner: { name: string };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const latest = (...dates: Array<Date | null>) => Math.max(...dates.map((d) => d?.getTime() ?? 0));

export function connectionState(c: ViewRow, now: Date): PartnerConnectionState {
  if (c.status === 'REVOKED') return 'revoked';
  if (c.keyExpiresAt && c.keyExpiresAt.getTime() <= now.getTime()) return 'expired';
  if (c.keySuspendedAt || now.getTime() - latest(c.keyCreatedAt, c.lastUsedAt, c.keyResumedAt) > DORMANT_AFTER_MS) return 'dormant';
  return c.status === 'PAUSED' ? 'paused' : 'active';
}

/** La vista del dueño: sin hashes ni nada del enlace de un uso. */
export function toConnectionAdminView(c: ViewRow, foreignIps: Array<{ ip: string; at: string }>, now: Date): PartnerConnectionView {
  const paused = c.status === 'PAUSED' || c.pausedScopes.length > 0;
  return {
    id: c.id,
    publicId: publicId('pc', c.id),
    partnerId: c.partnerId,
    partnerName: c.partner.name,
    state: connectionState(c, now),
    pausedBy: paused ? ((c.pausedReason as PartnerPauseReason | null) ?? null) : null,
    scopes: sortScopes(c.scopes),
    pausedScopes: sortScopes(c.pausedScopes),
    mode: c.keyMode === 'live' ? 'live' : 'test',
    keyHint: c.keyHint,
    keyCreatedAt: c.keyCreatedAt.toISOString(),
    keyExpiresAt: iso(c.keyExpiresAt),
    previousKeyUntil: c.prevKeyExpiresAt && c.prevKeyExpiresAt.getTime() > now.getTime() ? c.prevKeyExpiresAt.toISOString() : null,
    keyExposedAt: iso(c.keyExposedAt),
    keySuspendedAt: iso(c.keySuspendedAt),
    lastUsedAt: iso(c.lastUsedAt),
    lastUsedIp: c.lastUsedIp,
    ipAllowlist: [...c.ipAllowlist],
    foreignIps,
    createdAt: c.createdAt.toISOString(),
  };
}

export interface OptionRow extends ReadinessFields {
  id: string;
  name: string;
  allowedScopes: string[];
  egressIps: string[];
  contactEmail: string;
  channel: string;
}

/** Lo que el dueño ve de una plataforma que puede conectar (nada más de su empresa). */
export function toPartnerOption(p: OptionRow, grantable: readonly string[]): PartnerOptionView {
  return {
    id: p.id,
    name: p.name,
    allowedScopes: sortScopes(p.allowedScopes.filter((s) => grantable.includes(s))),
    egressIps: [...p.egressIps],
    contactEmail: maskEmail(p.contactEmail),
    channel: p.channel === 'ONLINE' ? 'online' : 'in_venue',
  };
}
