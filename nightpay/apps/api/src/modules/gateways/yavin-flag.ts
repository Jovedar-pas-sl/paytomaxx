import { NotFoundException, type CanActivate } from '@nestjs/common';

/**
 * El interruptor global de Yavin (YAVIN_ENABLED, apagado por defecto), como
 * BTCPAY_ENABLED. Apagado: ningún cobro NUEVO va a Yavin (no se abren enlaces,
 * aunque el local tenga credencial) y la pantalla de super-admin no existe
 * (404). Lo ya abierto con Yavin sigue funcionando (los enlaces se pueden pagar
 * 72 h): el aviso, la comprobación, el repaso de atascados, anular y devolver.
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
