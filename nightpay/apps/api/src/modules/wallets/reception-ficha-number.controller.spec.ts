import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ReceptionNumberTopUpSchema, type JwtPayload } from '@nightpay/contracts';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRateLimitGuard } from '../../common/guards/user-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ReceptionFichaNumberController, FichaNumberLookupSchema, FichaNumberSchema } from './reception-ficha-number.controller';

const user = { sub: 'staff-1', role: 'WAITER', tenantId: 'venue-1' } as JwtPayload;
const lookupPipe = new ZodValidationPipe(FichaNumberLookupSchema);
const labelPipe = new ZodValidationPipe(FichaNumberSchema);
const topUpPipe = new ZodValidationPipe(ReceptionNumberTopUpSchema);
const label = { card: 'q3VbX9kLmN2pR7sT4wYz1A', uid: '04A23B110001', printedNumber: '00017' };

describe('printed ficha number HTTP boundaries', () => {
  it.each(['0', '00017', '123456789012'])('preserves all factory digits in lookup %s', async (printedNumber) => {
    const view = { kind: 'new', printedNumber };
    const numbers = { lookup: vi.fn().mockResolvedValue(view) };
    const controller = new ReceptionFichaNumberController({} as never, numbers as never);
    await expect(controller.lookupNumber(user, lookupPipe.transform({ printedNumber }))).resolves.toEqual(view);
    expect(numbers.lookup).toHaveBeenCalledWith({ userId: user.sub, role: user.role, tenantId: user.tenantId }, printedNumber);
  });

  it('top-up by number: only the number, the amount and its key (no code, card or PIN)', async () => {
    const numbers = { topUp: vi.fn().mockResolvedValue({ topUpId: 't', codeHint: 'K7Q-•••', amountCents: 2_000, balanceCents: 5_000, replayed: false }) };
    const controller = new ReceptionFichaNumberController({} as never, numbers as never);
    const body = topUpPipe.transform({ printedNumber: '00017', amountCents: 2_000, idempotencyKey: 'rec-12345678' });
    await expect(controller.topUpByNumber(user, body)).resolves.toMatchObject({ codeHint: 'K7Q-•••' });
    for (const bad of [{ ...body, code: 'ABC123' }, { ...body, card: label.card }, { ...body, amountCents: 100_000 }, { ...body, printedNumber: '1x' }, { printedNumber: '00017', amountCents: 2_000 }]) {
      expect(() => topUpPipe.transform(bad)).toThrow(BadRequestException);
    }
  });

  it.each([
    {}, { printedNumber: '' }, { printedNumber: 17 }, { printedNumber: '1234567890123' },
    { printedNumber: '17a' }, { printedNumber: ' 17' }, { printedNumber: '17 ' }, { printedNumber: '1.7' },
    { printedNumber: '00017', card: label.card }, { printedNumber: '00017', uid: label.uid },
    { printedNumber: '00017', pin: '1234' }, { printedNumber: '00017', code: 'ABC123' },
  ])('rejects malformed aliases and credential fields %#', (input) => {
    expect(() => lookupPipe.transform(input)).toThrow(BadRequestException);
  });

  it('passes physical-card proof and exact alias to the staff service', async () => {
    const cards = { labelStock: vi.fn().mockResolvedValue({ printedNumber: '00017' }) };
    const controller = new ReceptionFichaNumberController(cards as never, {} as never);
    await expect(controller.label(user, labelPipe.transform(label))).resolves.toEqual({ printedNumber: '00017' });
    expect(cards.labelStock).toHaveBeenCalledWith({ userId: user.sub, role: user.role, tenantId: user.tenantId }, label);
  });

  it.each([{ ...label, uid: undefined }, { ...label, printedNumber: '1x' }, { ...label, pin: '1234' }])('rejects missing proof or extra credential on numbering %#', (input) => {
    expect(() => labelPipe.transform(input)).toThrow(BadRequestException);
  });

  it('both endpoints use the staff guard, exact staff roles and separate bounded rate limits', () => {
    const reflector = new Reflector();
    expect(reflector.get(GUARDS_METADATA, ReceptionFichaNumberController)).toContain(RolesGuard);
    for (const [method, scope] of [['lookupNumber', 'reception-fichas-lookup-number'], ['label', 'reception-fichas-number']] as const) {
      const handler = ReceptionFichaNumberController.prototype[method];
      expect(reflector.get('roles', handler)).toEqual(['WAITER', 'MANAGER', 'OWNER']);
      expect(reflector.get('np:ip-rate-limit', handler)).toEqual({ max: 60, windowSec: 60, scope });
    }
    // Buscar por número: además, un tope por persona (el wifi del local es de todos).
    const lookup = ReceptionFichaNumberController.prototype.lookupNumber;
    expect(reflector.get(GUARDS_METADATA, lookup)).toContain(UserRateLimitGuard);
    expect(reflector.get('np:user-rate-limit', lookup)).toEqual({ max: 20, windowSec: 60, scope: 'reception-fichas-lookup-number' });
    expect(reflector.get('roles', ReceptionFichaNumberController.prototype.topUpByNumber)).toEqual(['WAITER', 'MANAGER', 'OWNER']);
  });
});
