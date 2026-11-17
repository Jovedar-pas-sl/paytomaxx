import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConflictException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@nightpay/contracts';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ReceptionCashPayoutController } from './reception-cash-payout.controller';

const user = { sub: 'staff-1', role: 'WAITER', tenantId: 'venue-1' } as JwtPayload;

/** El 409 del saldo que no se devuelve (decisión del dueño, 17-nov). */
async function refusal(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse();
  }
  throw new Error('se esperaba el 409 SALDO_NO_SE_DEVUELVE');
}

describe('la salida de recepción ya no devuelve el saldo', () => {
  it('devolver, el plan, el QR de Face ID y su estado: 409 SALDO_NO_SE_DEVUELVE, sin tocar nada', async () => {
    const controller = new ReceptionCashPayoutController();
    const expected = { code: 'SALDO_NO_SE_DEVUELVE', message: 'El saldo no se devuelve: se guarda para la próxima visita.' };
    await expect(refusal(() => controller.payout())).resolves.toEqual(expected);
    await expect(refusal(() => controller.plan())).resolves.toEqual(expected);
    await expect(refusal(() => controller.passkey())).resolves.toEqual(expected);
    await expect(refusal(() => controller.passkeyStatus())).resolves.toEqual(expected);
  });

  it('las mismas rutas, personas y topes de peticiones que antes (una app antigua recibe el 409, no un 404)', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, ReceptionCashPayoutController)).toContain(RolesGuard);
    const limits = { payout: 'reception-payout', plan: 'reception-payout-plan', passkey: 'reception-payout-passkey', passkeyStatus: 'reception-payout-passkey-status' } as const;
    for (const [method, scope] of Object.entries(limits) as Array<[keyof typeof limits, string]>) {
      const handler = ReceptionCashPayoutController.prototype[method];
      expect(reflector.get('np:ip-rate-limit', handler)).toMatchObject({ windowSec: 60, scope });
      const guard = new RolesGuard(reflector);
      for (const role of ['WAITER', 'MANAGER', 'OWNER', 'OPERATOR', 'SUPERADMIN', null]) {
        const ctx = { getHandler: () => handler, getClass: () => ReceptionCashPayoutController, switchToHttp: () => ({ getRequest: () => ({ user: role ? { ...user, role } : undefined }) }) } as unknown as ExecutionContext;
        if (['WAITER', 'MANAGER', 'OWNER'].includes(role ?? '')) expect(guard.canActivate(ctx)).toBe(true);
        else expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      }
    }
  });
});
