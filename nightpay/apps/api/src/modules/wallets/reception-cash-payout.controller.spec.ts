import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@nightpay/contracts';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ReceptionCashPayoutController, ReceptionCashSchema, ReceptionPasskeySchema, deviceOf } from './reception-cash-payout.controller';

const body = { card: 'q3VbX9kLmN2pR7sT4wYz1A', uid: '04A23B110001', pin: '0017', expectedAmountCents: 500, requestKey: 'exit_12345678' };
const pipe = new ZodValidationPipe(ReceptionCashSchema);
const passkeyPipe = new ZodValidationPipe(ReceptionPasskeySchema);
const user = { sub: 'staff-1', role: 'WAITER', tenantId: 'venue-1' } as JwtPayload;

describe('reception cash payout HTTP boundary', () => {
  it('preserves the NFC proof, PIN zeroes and amount for the authenticated actor, with the reception device', async () => {
    const payouts = { payout: vi.fn().mockResolvedValue({ refundedCents: 500 }) };
    const controller = new ReceptionCashPayoutController(payouts as never);
    const parsed = pipe.transform(body);
    const req = { ip: '10.1.2.3', headers: { 'user-agent': 'Android Chrome' } };
    await expect(controller.payout(user, 'wallet-1', parsed, req as never)).resolves.toEqual({ refundedCents: 500 });
    expect(payouts.payout).toHaveBeenCalledWith({ userId: user.sub, role: user.role, tenantId: user.tenantId }, 'wallet-1', body,
      expect.objectContaining({ userAgent: 'Android Chrome' }));
    expect(deviceOf(undefined)).toEqual({});
  });

  it('a saldo with Face ID confirmed on the phone goes without PIN; the QR request never takes a PIN', () => {
    const { pin: _pin, ...noPin } = body;
    expect(pipe.transform(noPin)).toEqual(noPin);
    expect(passkeyPipe.transform(noPin)).toEqual(noPin);
    expect(() => passkeyPipe.transform(body)).toThrow(BadRequestException);
  });

  it.each([
    { code: 'ABC123', pin: '0017', expectedAmountCents: 500, requestKey: 'exit_12345678' },
    { ...body, card: undefined }, { ...body, uid: undefined }, { ...body, uid: '' },
    { ...body, pin: 17 }, { ...body, pin: '123' }, { ...body, pin: '12a4' },
    { ...body, expectedAmountCents: undefined }, { ...body, expectedAmountCents: 0 }, { ...body, expectedAmountCents: -1 },
    { ...body, expectedAmountCents: 1.5 }, { ...body, expectedAmountCents: '500' }, { ...body, expectedAmountCents: 100000 },
    { ...body, requestKey: undefined }, { ...body, requestKey: 'short' }, { ...body, requestKey: 'x'.repeat(101) }, { ...body, requestKey: 'exit key with spaces' },
    { ...body, amountCents: 1 }, { ...body, method: 'CASH' }, { ...body, code: 'ABC123' }, { ...body, totpCode: '12345' },
  ])('rejects incomplete or altered financial requests %#', (input) => {
    expect(() => pipe.transform(input)).toThrow(BadRequestException);
  });

  it('allows exactly reception staff roles, requires authentication and has a bounded rate limit', () => {
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
    expect(reflector.get('np:ip-rate-limit', ReceptionCashPayoutController.prototype.payout)).toEqual({ max: 20, windowSec: 60, scope: 'reception-payout' });
  });
});
