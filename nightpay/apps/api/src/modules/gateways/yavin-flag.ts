import { NotFoundException, type CanActivate } from '@nestjs/common';

/**
 * El interruptor global de Yavin (YAVIN_ENABLED, apagado por defecto), como
 * BTCPAY_ENABLED. Apagado: la ruta del aviso y la pantalla de super-admin no
 * existen (404) y ningún cobro va a Yavin, aunque el local tenga credencial.
 */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

export function yavinEnabled(env: Record<string, string | boolean | undefined> = process.env): boolean {
  const raw = env.YAVIN_ENABLED;
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase());
}

/** Guard de las rutas de Yavin: con el interruptor apagado no existen. */
export class YavinEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!yavinEnabled()) throw new NotFoundException();
    return true;
  }
}
