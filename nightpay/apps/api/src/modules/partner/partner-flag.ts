import { NotFoundException, type CanActivate } from '@nestjs/common';
import type { PartnerKeyMode } from '@nightpay/contracts';
import { isPartyEdition } from '../../config/edition';

/**
 * El interruptor de la API de socios (PARTNER_API_ENABLED, apagado de serie):
 * apagada, ninguna ruta existe (404), nadie crea claves y no corre el repaso.
 * En OxioParty no existe. Se lee de process.env, como BTCPAY_ENABLED (env.ts
 * ya lo validó al arrancar, con PARTNER_API_MODE obligatoria).
 */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
type Env = Readonly<Record<string, string | undefined>>;

export function partnerApiEnabled(env: Env = process.env): boolean {
  return TRUE_VALUES.has((env.PARTNER_API_ENABLED ?? '').trim().toLowerCase());
}

/** El modo del despliegue: las claves del otro no valen (401 wrong_environment). */
export function partnerApiMode(env: Env = process.env): PartnerKeyMode | null {
  const mode = env.PARTNER_API_MODE?.trim();
  return mode === 'live' || mode === 'test' ? mode : null;
}

/** Encendida, con su modo y en OxioPay (club). */
export function partnerApiOn(env: Env = process.env): boolean {
  return partnerApiEnabled(env) && partnerApiMode(env) !== null && !isPartyEdition(env);
}

/** Las rutas del dueño: apagada o en OxioParty, no existen. */
export class PartnerApiEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!partnerApiOn()) throw new NotFoundException();
    return true;
  }
}
