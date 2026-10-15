import { isIPv4, isIPv6 } from 'node:net';

/** Máximo de un email (RFC 5321). Lo que mande un atacante se recorta a esto. */
export const MAX_EMAIL_LENGTH = 254;

/** Claves de bloqueo de un intento de login (ver LockoutService). */
export interface LoginLockKeys {
  /** email|IP: 5 fallos bloquean a ESA IP para esa cuenta. */
  readonly ip: string;
  /** Toda la cuenta, desde cualquier IP (ataque repartido). */
  readonly account: string;
  /** email|IP que ya entró bien antes: el bloqueo de cuenta no le aplica. */
  readonly trusted: string | null;
}

export function clampEmail(email: string): string {
  return email.slice(0, MAX_EMAIL_LENGTH);
}

export function normalizeLoginEmail(email: string): string {
  return clampEmail(email.trim().toLowerCase());
}

export function loginLockKeys(email: string, ip?: string): LoginLockKeys {
  const who = normalizeLoginEmail(email);
  const net = ipLockKey(ip);
  return {
    ip: `${who}|${net ?? '-'}`,
    account: `cuenta:${who}`,
    trusted: net ? `${who}|${net}` : null,
  };
}

/**
 * La IP que cuenta para los bloqueos. En IPv6 cualquier conexión tiene al
 * menos una red /64 entera (2^64 direcciones): si cada dirección contase
 * por separado, un solo atacante tendría intentos infinitos. Agrupamos por /64.
 */
export function ipLockKey(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) return ip.slice(7);
  const groups = ipv6Groups(ip.split('%')[0] ?? '');
  if (!groups) return ip;
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(':')}::/64`;
}

/** Los 8 grupos de una IPv6 ('::' expandido), o null si no es IPv6. */
function ipv6Groups(ip: string): string[] | null {
  if (!isIPv6(ip)) return null;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const left = splitGroups(head);
  if (tail === undefined) return left;
  const right = splitGroups(tail);
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => '0');
  return [...left, ...zeros, ...right];
}

/** Una IPv4 al final (p. ej. 64:ff9b::1.2.3.4) ocupa dos grupos. */
function splitGroups(part: string): string[] {
  if (!part) return [];
  return part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
}
