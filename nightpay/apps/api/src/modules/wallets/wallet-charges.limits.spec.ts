import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IP_RATE_LIMIT_META, type IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';
import { UserRateLimitGuard } from '../../common/guards/user-rate-limit.guard';
import { WalletChargesController } from './wallet-charges.controller';

/**
 * Prueba de carga del 19-11-2026: todo el personal de un local sale por el
 * wifi y cobrar con la ficha o el PIN (30 por minuto POR IP) o consultar la
 * ficha o el pase (60) frenaba al local entero con 429. Ahora cuentan por
 * persona y por saldo (ficha, código o pase); la IP solo tiene un tope alto.
 */
describe('topes de cobrar con el saldo desde el móvil del personal', () => {
  const reflector = new Reflector();
  const proto = WalletChargesController.prototype;
  const ipLimit = (name: keyof WalletChargesController) => reflector.get<IpRateLimitConfig>(IP_RATE_LIMIT_META, proto[name]);

  it.each([
    ['payWithPin', 'wallet-pin', 30, ['card', 'code', 'walletToken']],
    ['payWithCard', 'wallet-pin', 30, ['card', 'code', 'walletToken']],
    ['checkPass', 'wallet-pay-lookup', 60, ['card', 'walletToken']],
    ['lookupCard', 'wallet-pay-lookup', 60, ['card', 'walletToken']],
  ] as const)('%s: por persona (%s, %i por minuto), por saldo y la IP solo con un tope alto', (name, scope, perUser, body) => {
    const ip = ipLimit(name);
    expect(ip).toMatchObject({ windowSec: 60, scope, perKey: { body } });
    expect(ip.max).toBeGreaterThanOrEqual(600);
    expect(ip.perKey!.max).toBeLessThan(perUser);
    expect(reflector.get(GUARDS_METADATA, proto[name])).toContain(UserRateLimitGuard);
    expect(reflector.get('np:user-rate-limit', proto[name])).toEqual({ max: perUser, windowSec: 60, scope });
  });

  it('buscar un saldo por su código sigue con su tope por IP (contra probar códigos), con su propio contador', () => {
    for (const name of ['lookup', 'lookupById'] as const) {
      expect(ipLimit(name)).toEqual({ max: 60, windowSec: 60, scope: 'wallet-lookup' });
    }
    // Un contador por scope y IP: los cobros con ficha no gastan el de buscar por código.
    expect(ipLimit('lookupCard').scope).not.toBe('wallet-lookup');
  });
});
