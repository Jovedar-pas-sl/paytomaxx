import { NotFoundException, type CanActivate } from '@nestjs/common';

/**
 * El interruptor global de «Pagar con bitcoin» (BTCPAY_ENABLED, apagado por
 * defecto). Apagado: ninguna ruta nueva responde (404), no sale ningún botón y
 * no corre ninguna tarea. Cada local, además, lo activa en Ajustes.
 */
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

export function btcpayEnabled(env: Record<string, string | boolean | undefined> = process.env): boolean {
  const raw = env.BTCPAY_ENABLED;
  if (typeof raw === 'boolean') return raw;
  return typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase());
}

/** Guard de las rutas nuevas: con el interruptor apagado no existen. */
export class BtcpayEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!btcpayEnabled()) throw new NotFoundException();
    return true;
  }
}
