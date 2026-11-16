/**
 * «Aviso en cada cobro» (Web Push): las claves VAPID con las que el servidor
 * firma los avisos que manda al móvil del cliente. Opcional: sin las dos
 * claves y el contacto, la función está apagada (la página del saldo no
 * ofrece el aviso y no se manda nada). Lo mal escrito no impide arrancar: se
 * apaga y se avisa al arrancar (env-warnings.ts). Los avisos dicen QUÉ falla,
 * nunca el valor.
 *
 * Se generan una vez con `npx web-push generate-vapid-keys` (la pública va a
 * los navegadores; la privada, solo en el servidor). Cambiarlas deja sin
 * aviso a todos los móviles apuntados: tendrían que volver a activarlo.
 */

export interface WebPushEnv {
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  WEB_PUSH_SUBJECT?: string;
}

export interface WebPushSettings {
  /** Clave pública (base64url, 65 bytes): la página la pasa al navegador al apuntarse. */
  publicKey: string;
  privateKey: string;
  /** Contacto para los servicios de avisos (mailto: o https://). */
  subject: string;
}

export type WebPushConfig =
  | { status: 'off' }
  | { status: 'invalid'; problems: string[] }
  | { status: 'on'; settings: WebPushSettings };

const PUBLIC_KEY_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function base64urlBytes(value: string): number | null {
  if (!BASE64URL.test(value)) return null;
  return Buffer.from(value, 'base64url').length;
}

function subjectProblem(subject: string): string | null {
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(subject)) return null;
  try {
    return new URL(subject).protocol === 'https:' ? null : 'WEB_PUSH_SUBJECT tiene que ser mailto:correo o una dirección https://';
  } catch {
    return 'WEB_PUSH_SUBJECT tiene que ser mailto:correo o una dirección https://';
  }
}

export function readWebPushConfig(env: WebPushEnv): WebPushConfig {
  const publicKey = clean(env.WEB_PUSH_VAPID_PUBLIC_KEY);
  const privateKey = clean(env.WEB_PUSH_VAPID_PRIVATE_KEY);
  const subject = clean(env.WEB_PUSH_SUBJECT);
  if (!publicKey && !privateKey && !subject) return { status: 'off' };
  const problems: string[] = [];
  if (!publicKey) problems.push('falta WEB_PUSH_VAPID_PUBLIC_KEY');
  else if (base64urlBytes(publicKey) !== PUBLIC_KEY_BYTES || Buffer.from(publicKey, 'base64url')[0] !== 4) {
    problems.push('WEB_PUSH_VAPID_PUBLIC_KEY no es una clave pública VAPID (base64url de 65 bytes)');
  }
  if (!privateKey) problems.push('falta WEB_PUSH_VAPID_PRIVATE_KEY');
  else if (base64urlBytes(privateKey) !== PRIVATE_KEY_BYTES) {
    problems.push('WEB_PUSH_VAPID_PRIVATE_KEY no es una clave privada VAPID (base64url de 32 bytes)');
  }
  if (!subject) problems.push('falta WEB_PUSH_SUBJECT (mailto:correo o https://)');
  else {
    const problem = subjectProblem(subject);
    if (problem) problems.push(problem);
  }
  if (problems.length > 0 || !publicKey || !privateKey || !subject) return { status: 'invalid', problems };
  return { status: 'on', settings: { publicKey, privateKey, subject } };
}

/** El aviso del arranque si están a medias o mal escritas (null si están bien o no están). */
export function webPushWarning(env: WebPushEnv): string | null {
  const config = readWebPushConfig(env);
  return config.status === 'invalid'
    ? `«Aviso en cada cobro» apagado: ${config.problems.join('; ')}.`
    : null;
}
