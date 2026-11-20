import type { IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import type { UserRateLimitConfig } from '../../common/guards/user-rate-limit.guard';

/**
 * Topes de cobrar con el saldo (prueba de carga del 19-11-2026). Todo el
 * personal de un local sale por el wifi: 30 cobros por minuto POR IP frenaban
 * al local entero. Ahora cuentan por persona (UserRateLimitGuard) y por saldo
 * (la ficha, el código o el pase del cuerpo); la IP solo tiene un tope alto.
 * Adivinar un PIN lo sigue cortando el bloqueo tras 5 fallos (wallet-pin.ts).
 */

/** Cobrar con la ficha (NFC) o con el PIN: el móvil del personal y la tablet del cliente (mismo contador por IP). */
export const WALLET_PAY_IP_LIMIT = {
  max: 600,
  windowSec: 60,
  scope: 'wallet-pin',
  perKey: { body: ['card', 'code', 'walletToken'], max: 10 },
} as const satisfies IpRateLimitConfig;

export const WALLET_PAY_USER_LIMIT = { max: 30, windowSec: 60, scope: 'wallet-pin' } as const satisfies UserRateLimitConfig;

/**
 * Consultar la ficha o el pase antes de cobrar. Su propio contador: buscar un
 * saldo por su código (wallet-lookup, 60 por IP) sigue igual de estricto.
 */
export const WALLET_PAY_LOOKUP_IP_LIMIT = {
  max: 600,
  windowSec: 60,
  scope: 'wallet-pay-lookup',
  perKey: { body: ['card', 'walletToken'], max: 20 },
} as const satisfies IpRateLimitConfig;

export const WALLET_PAY_LOOKUP_USER_LIMIT = { max: 60, windowSec: 60, scope: 'wallet-pay-lookup' } as const satisfies UserRateLimitConfig;
