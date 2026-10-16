import { createPrivateKey, type KeyObject } from 'node:crypto';

/**
 * Google Wallet (pase del saldo en el móvil Android). Opcional: sin estas
 * variables el botón no sale y no corre nada.
 *
 *  - GOOGLE_WALLET_ISSUER_ID: el número de emisor (Google Pay & Wallet Console).
 *  - GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: el JSON de la clave de la cuenta de
 *    servicio, tal cual; o GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64 (el mismo
 *    JSON en base64, más fácil de pegar sin romper los saltos de línea).
 *  - GOOGLE_WALLET_CLASS_SUFFIX: nombre de la "clase" del pase (por defecto
 *    oxiopay_saldo).
 *
 * Si algo está mal escrito, el API arranca igual (tumbar los cobros por un
 * extra sería peor): Google Wallet queda apagado y se avisa al arrancar
 * (env-warnings.ts). Los avisos dicen QUÉ falla, nunca el valor: la clave
 * privada no sale nunca en el log.
 */

export const DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX = 'oxiopay_saldo';

/** Lo que se lee del entorno (ya validado por zod en env.ts: textos opcionales). */
export interface GoogleWalletEnv {
  GOOGLE_WALLET_ISSUER_ID?: string;
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64?: string;
  GOOGLE_WALLET_CLASS_SUFFIX?: string;
}

export interface GoogleWalletSettings {
  issuerId: string;
  classSuffix: string;
  /** `<issuerId>.<classSuffix>`: la clase de todos los pases del saldo. */
  classId: string;
  /** Email de la cuenta de servicio: firma los JWT ("iss"). */
  serviceAccountEmail: string;
  /** La clave privada ya cargada (un KeyObject no imprime la clave). */
  privateKey: KeyObject;
  /** Id de la clave (cabecera "kid" del JWT), si viene en el JSON. */
  privateKeyId: string | null;
}

export type GoogleWalletConfig =
  | { status: 'off' }
  | { status: 'invalid'; problems: string[] }
  | { status: 'on'; settings: GoogleWalletSettings };

const ISSUER_ID = /^\d{5,30}$/;
const ID_PART = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ServiceAccount {
  serviceAccountEmail: string;
  privateKey: KeyObject;
  privateKeyId: string | null;
}

/** Lee y valida la configuración de Google Wallet. Nunca lanza. */
export function readGoogleWalletConfig(env: GoogleWalletEnv): GoogleWalletConfig {
  const issuerId = clean(env.GOOGLE_WALLET_ISSUER_ID);
  const json = clean(env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON);
  const b64 = clean(env.GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64);
  if (!issuerId && !json && !b64) return { status: 'off' };

  const problems: string[] = [];
  if (!issuerId) problems.push('falta GOOGLE_WALLET_ISSUER_ID');
  else if (!ISSUER_ID.test(issuerId)) problems.push('GOOGLE_WALLET_ISSUER_ID son solo cifras (el "Issuer ID" de la consola)');

  const classSuffix = clean(env.GOOGLE_WALLET_CLASS_SUFFIX) ?? DEFAULT_GOOGLE_WALLET_CLASS_SUFFIX;
  if (!ID_PART.test(classSuffix)) {
    problems.push('GOOGLE_WALLET_CLASS_SUFFIX solo admite letras, números, punto, guion y guion bajo (máx. 64)');
  }

  let account: ServiceAccount | null = null;
  if (json && b64) {
    problems.push('pon solo una: GOOGLE_WALLET_SERVICE_ACCOUNT_JSON o GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64');
  } else if (!json && !b64) {
    problems.push('falta GOOGLE_WALLET_SERVICE_ACCOUNT_JSON (o GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64)');
  } else {
    const parsed = json
      ? parseServiceAccount(json, 'GOOGLE_WALLET_SERVICE_ACCOUNT_JSON')
      : parseServiceAccount(decodeBase64(b64 ?? ''), 'GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64');
    if ('problem' in parsed) problems.push(parsed.problem);
    else account = parsed;
  }

  if (problems.length > 0 || !issuerId || !account) return { status: 'invalid', problems };
  return {
    status: 'on',
    settings: { issuerId, classSuffix, classId: `${issuerId}.${classSuffix}`, ...account },
  };
}

/** Avisos de arranque (vacío si está bien o apagado). */
export function googleWalletWarning(env: GoogleWalletEnv): string | null {
  const config = readGoogleWalletConfig(env);
  return config.status === 'invalid'
    ? `Google Wallet queda apagado (el botón no sale): ${config.problems.join('; ')}. Ver docs/GOOGLE-WALLET.md.`
    : null;
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function parseServiceAccount(raw: string, name: string): ServiceAccount | { problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { problem: `${name} no es un JSON válido (pega el fichero entero o usa la versión _B64)` };
  }
  if (typeof data !== 'object' || data === null) return { problem: `${name} no es el JSON de una cuenta de servicio` };
  const sa = data as Record<string, unknown>;
  if (sa.type !== 'service_account') return { problem: `${name} no es el JSON de una cuenta de servicio ("type" no es "service_account")` };
  const email = typeof sa.client_email === 'string' ? sa.client_email.trim() : '';
  if (!EMAIL.test(email)) return { problem: `${name} no trae "client_email"` };
  const key = typeof sa.private_key === 'string' ? sa.private_key : '';
  const privateKey = loadRsaKey(key);
  if (!privateKey) return { problem: `${name}: "private_key" no es una clave RSA válida` };
  const keyId = typeof sa.private_key_id === 'string' && ID_PART.test(sa.private_key_id) ? sa.private_key_id : null;
  return { serviceAccountEmail: email, privateKey, privateKeyId: keyId };
}

/** La clave PEM; si al pegarla los saltos quedaron como "\n" literales, se arreglan. */
function loadRsaKey(pem: string): KeyObject | null {
  if (!pem.includes('PRIVATE KEY')) return null;
  const fixed = pem.includes('\n') ? pem : pem.split('\\n').join('\n');
  try {
    const key = createPrivateKey(fixed);
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch {
    return null;
  }
}
