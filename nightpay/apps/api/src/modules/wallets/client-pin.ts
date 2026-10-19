import { BadRequestException } from '@nestjs/common';

/**
 * El PIN que elige el cliente en su móvil (página del saldo y «Pagado» de la
 * recarga): 4 cifras, dos veces iguales. 400 con `code` (la página lo
 * traduce); lo demás (PIN demasiado fácil, ya tiene PIN) lo mira storeFirstPin.
 */
export function checkedPin(body: { pin?: unknown; pin2?: unknown } | undefined): string {
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  if (!/^[0-9]{4}$/.test(pin)) throw new BadRequestException({ message: 'El PIN son 4 cifras', code: 'PIN_FORMAT' });
  if (body?.pin2 !== pin) throw new BadRequestException({ message: 'Los dos PIN no son iguales', code: 'PIN_MISMATCH' });
  return pin;
}
