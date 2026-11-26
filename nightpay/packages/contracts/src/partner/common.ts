// API de socios (v1): lo común. El contrato que manda es
// docs/partner-api/pilot/openapi-piloto.yaml; esto lo pone en código.
import { z } from 'zod';

/** Los permisos de una clave. La de los cajeros lleva solo los dos primeros. */
export const PARTNER_SCOPES = ['wallet:balance', 'wallet:load', 'wallet:pay', 'charges:write', 'charges:read', 'reports:read'] as const;
export type PartnerScope = (typeof PARTNER_SCOPES)[number];

/**
 * Los esquemas publicados en `components.schemas` (con su nombre del
 * contrato, `id`) y sus anotaciones. Registro propio: el generador
 * (openapi.ts) lo usa como `metadata` y no mezcla esquemas de otras partes.
 */
export interface PartnerSchemaMeta {
  id?: string;
  description?: string;
  examples?: readonly unknown[];
  'x-decided-in-contract'?: boolean;
  /** En puntos de código del texto limpio (Description, reason): Zod `.max()` contaría UTF-16. */
  minLength?: number;
  maxLength?: number;
}
export const partnerSchemas = z.registry<PartnerSchemaMeta>();

export const PartnerScopeSchema = z.enum(PARTNER_SCOPES).register(partnerSchemas, {
  id: 'Scope',
  description: 'The ATM key holds `wallet:balance` and `wallet:load` only. The other scopes belong to features outside this pilot.',
});

export const PartnerTimestampSchema = z.iso.datetime().register(partnerSchemas, {
  id: 'Timestamp',
  description: 'RFC 3339 in UTC (`Z`). Clients accept fractional seconds. Times sent in requests may use `Z` or an offset.',
  'x-decided-in-contract': true,
  examples: ['2026-12-05T22:41:07Z'],
});

export const PartnerCurrencySchema = z.literal('EUR').register(partnerSchemas, { id: 'Currency' });

export const PartnerLoadIdSchema = z
  .string()
  .regex(/^wl_[0-9a-f]{32}$/)
  .register(partnerSchemas, { id: 'LoadId', examples: ['wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b'] });

/** Los que el dueño puede dar hoy (crece con cada entrega). */
export const GRANTABLE_SCOPES = ['wallet:balance', 'wallet:load'] as const satisfies readonly PartnerScope[];
/** Los que mueven dinero: los congela OxioPay y los pausa el uso desde IP ajenas. */
export const MONEY_SCOPES = ['wallet:load', 'wallet:pay', 'charges:write'] as const satisfies readonly PartnerScope[];
/** Los que en real necesitan la lista de IP. */
export const IP_REQUIRED_SCOPES = ['wallet:load', 'wallet:pay'] as const satisfies readonly PartnerScope[];
/** Los que necesitan caducidad (un año como mucho). */
export const EXPIRY_REQUIRED_SCOPES = ['wallet:load', 'wallet:pay', 'reports:read'] as const satisfies readonly PartnerScope[];

export function isPartnerScope(value: unknown): value is PartnerScope {
  return typeof value === 'string' && (PARTNER_SCOPES as readonly string[]).includes(value);
}

/** Espacio Económico Europeo: la UE más Islandia, Liechtenstein y Noruega (la misma lista en la migración). */
export const EEA_COUNTRIES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO',
] as const;

/** Una clave de socio: prefijo del entorno y 48 hex (192 bits). */
export const PARTNER_KEY_RE = /^oxp_(live|test)_[0-9a-f]{48}$/;
/** Una clave dentro de cualquier texto (URL, cuerpo, log). */
export const PARTNER_KEY_IN_TEXT_RE = /oxp_(?:live|test)_[0-9a-f]{48}/;
export type PartnerKeyMode = 'live' | 'test';
export const PARTNER_KEY_MODES = ['live', 'test'] as const satisfies readonly PartnerKeyMode[];

/** Prefijos de los ids públicos: `pc_` conexión, `wl_` carga. */
export type PublicIdPrefix = 'pc' | 'wl';

/** `pc_` + el UUID sin guiones, en minúsculas. */
export function publicId(prefix: PublicIdPrefix, uuid: string): string {
  return `${prefix}_${uuid.replace(/-/g, '').toLowerCase()}`;
}

/** El UUID de un id público de ese prefijo, o null si no lo es. */
export function parsePublicId(prefix: PublicIdPrefix, value: string): string | null {
  const m = new RegExp(`^${prefix}_([0-9a-f]{32})$`).exec(value);
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Por qué está en pausa una conexión: `owner`, `manager` y `oxiopay` pausan
 * la conexión entera (403 connection_paused); `foreign_ip` es la pausa
 * automática de sus permisos de dinero (pausedScopes), como `load_refusals`,
 * `load_burst` y `load_voids`, las pausas automáticas de las cargas (PR 3:
 * solo `wallet:load`). La misma lista en el CHECK
 * `partner_connections_paused_reason` de la migración (20261126200000 lo reemplaza).
 */
export const PARTNER_PAUSE_REASONS = ['owner', 'manager', 'foreign_ip', 'oxiopay', 'load_refusals', 'load_burst', 'load_voids'] as const;
export type PartnerPauseReason = (typeof PARTNER_PAUSE_REASONS)[number];

// shortcut: provisionales hasta que el dueño elija (pregunta 1 de preguntas.md); los cambia un commit de configuración.
export const PARTNER_API_HOST = 'api.oxiopay.example';
export const PARTNER_DEMO_API_HOST = 'demo-api.oxiopay.example';
export const PARTNER_DOCS_HOST = 'docs.oxiopay.example';

/** Topes de carga que no cambia nadie (céntimos), los de `GET /me` → `limits.loads`. */
export const LOAD_LIMITS_FIXED = {
  wallet_24h_all_partners: 99999,
  unnamed_wallet_30d: 150000,
  cash_wallet_24h: 99999,
} as const;

/** Los topes de carga de cada conexión: valor de serie y máximo. */
export const LOAD_CAPS = {
  perOperation: { default: 30000, max: 99999 },
  walletDay: { default: 60000, max: 99999 },
  night: { default: 500000, max: 5000000 },
} as const;

/** Las condiciones del saldo que el cajero enseña y el tique imprime (las del ejemplo ConnectionAtm). */
export const PARTNER_TERMS = {
  summary_es:
    'El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.',
  summary_en:
    'The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card.',
} as const;

/** Lo que nunca va en un texto de un socio (§4.4): control y formato, separadores de línea, < y >, enlaces o dominios. */
const PARTNER_TEXT_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]|:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b/iu;

/** null si el texto vale; si no, por qué (antes de limpiarlo: la limpieza quitaría los saltos). */
export function partnerTextProblem(raw: string): string | null {
  return PARTNER_TEXT_FORBIDDEN.test(raw) ? 'Sin caracteres de control, < ni >, ni enlaces o dominios.' : null;
}

/** El texto como se guarda: NFC, sin espacios alrededor y con los de dentro juntados. */
export function cleanPartnerText(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** La longitud de un texto en puntos de código (un emoji cuenta uno, no dos como en UTF-16). */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * ¿Hay en el texto 13 a 19 cifras seguidas (una tira entera de cifras) que
 * pasan la prueba de Luhn? Un número de tarjeta en `reference` o en un texto.
 */
export function luhnRun(text: string): boolean {
  for (const run of text.match(/\d+/g) ?? []) {
    if (run.length >= 13 && run.length <= 19 && luhnOk(run)) return true;
  }
  return false;
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * ¿El texto (ya limpio) parece un dato personal? (§9.1 del diseño, `Description`
 * del contrato): un correo; 9 cifras o más seguidas sin contar espacios, `.`,
 * `-`, `·` ni `/` (teléfonos, tarjetas, números de serie largos); o una tira de
 * 13 a 19 cifras que pasa Luhn.
 */
export function partnerTextPersonalData(text: string): boolean {
  if (/[^\s@]+@[^\s@]+/.test(text)) return true;
  if (/\d{9,}/.test(text.replace(/[\s.\-·/]+/g, ''))) return true;
  return luhnRun(text);
}
