import { rateLimitIpKey } from '../../common/http/client-ip';

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
 * La IP que cuenta para los bloqueos: la misma clave que los límites por IP
 * (en IPv6, su red /64: ver rateLimitIpKey en common/http/client-ip.ts).
 */
export function ipLockKey(ip: string | undefined): string | undefined {
  return ip ? rateLimitIpKey(ip) : undefined;
}
