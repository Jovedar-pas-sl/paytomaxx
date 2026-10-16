import type { OperatorUser } from './api';

/**
 * Volver a entrar sin perder el cobro. La sesión caduca con un cobro en
 * pantalla: se pide entrar otra vez encima y todo sigue. Si entra otra
 * persona (u otro local), es una frontera de seguridad: la app empieza de
 * cero y no se ve nada del cobro de la anterior.
 */
export type SessionPerson = Pick<OperatorUser, 'id' | 'tenantId'>;

/** ¿Es la misma persona del mismo local? */
export function isSamePerson(before: SessionPerson | null | undefined, after: SessionPerson): boolean {
  return Boolean(before) && before!.id === after.id && before!.tenantId === after.tenantId;
}

/** Al volver a entrar: seguir donde estaba, o empezar de cero. */
export function afterRelogin(before: SessionPerson | null | undefined, after: SessionPerson): 'resume' | 'reset' {
  return isSamePerson(before, after) ? 'resume' : 'reset';
}

/**
 * Qué se ve:
 *   loading  → aún no se sabe si hay sesión;
 *   login    → la pantalla de entrar (sin sesión, o caducada sin cobro abierto);
 *   app      → la app;
 *   relogin  → la app sigue debajo (hay un cobro abierto) y encima, entrar otra vez.
 */
export type ShellView = 'loading' | 'login' | 'app' | 'relogin';

export function shellView(s: { user: OperatorUser | null | undefined; expired: boolean; chargeOpen: boolean }): ShellView {
  if (s.user === undefined) return 'loading';
  if (s.user === null) return 'login';
  if (!s.expired) return 'app';
  return s.chargeOpen ? 'relogin' : 'login';
}

/**
 * La hoja de entrar se recoge sola cuando el cobro deja de esperar (pagado,
 * rechazado, caducado): el resultado se tiene que ver entero.
 */
export function shouldCollapseSheet(wasPending: boolean, pending: boolean): boolean {
  return wasPending && !pending;
}
