import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { SuperAdminSettlementsService } from './settlements.service';

const ACTOR = { id: 'sa-1', email: 'jefe@x.es', ip: '203.0.113.7', userAgent: 'vitest' };
const ID = '00000000-0000-4000-8000-0000000000cc';
const V = '00000000-0000-4000-8000-0000000000aa';
const row = (o: Record<string, unknown> = {}) => ({ id: ID, tenantId: V, reference: 'OXP-2026-S44-LUNA', status: 'ISSUED', totalCents: 2_235, paidCents: 0, ...o });

function make(o: { stepUpFails?: boolean; generate?: unknown } = {}) {
  const order: string[] = [];
  const core = {
    recordPayment: vi.fn(async (_a: unknown, _id: string, dto: { amountCents: number }) => {
      order.push('write');
      const paid = dto.amountCents;
      return { before: row(), after: row({ paidCents: paid, status: paid === 2_235 ? 'PAID' : 'PARTIALLY_PAID' }), paymentId: 'p1' };
    }),
    voidSettlement: vi.fn(async () => {
      order.push('write');
      return { before: row(), after: row({ status: 'VOID' }) };
    }),
    generate: vi.fn(async () => {
      order.push('write');
      return o.generate ?? { kind: 'created', id: ID, reference: 'OXP-2026-S44-LUNA-2', totalCents: 2_235, replacesId: 'old' };
    }),
    setPayee: vi.fn(async () => ({ before: null, after: { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', updatedAt: 'x' } })),
    detailForSuperAdmin: vi.fn(async () => ({ id: ID })),
  };
  const stepUp = {
    verify: vi.fn(async () => {
      order.push('2fa');
      if (o.stepUpFails) throw new ForbiddenException({ message: 'Código incorrecto', code: 'TOTP_INVALID' });
    }),
  };
  const audit = { write: vi.fn(async () => undefined) };
  return { svc: new SuperAdminSettlementsService(core as never, stepUp as never, audit as never), core, stepUp, audit, order };
}

describe('consola: las escrituras de las liquidaciones piden el 2FA antes y quedan en el registro', () => {
  it('pagada entera → superadmin.settlement.paid; en parte → paid_partially con el motivo', async () => {
    const full = make();
    await full.svc.recordPayment(ACTOR, ID, { amountCents: 2_235, paidOn: '2026-11-03', bankReference: 'TRF-1', totpCode: '123456' });
    expect(full.order).toEqual(['2fa', 'write']);
    expect(full.stepUp.verify).toHaveBeenCalledWith(ACTOR, '123456', 'settlement.pay');
    expect(full.audit.write).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        action: 'settlement.paid',
        tenantId: V,
        targetType: 'OxioPaySettlement',
        before: { status: 'ISSUED', paidCents: 0 },
        after: { status: 'PAID', paidCents: 2_235 },
        extra: expect.objectContaining({ matchesPending: true, bankReference: 'TRF-1', reference: 'OXP-2026-S44-LUNA' }),
      }),
    );
    // El código 2FA no llega al servicio (ni al registro).
    expect(full.core.recordPayment.mock.calls[0]![2]).not.toHaveProperty('totpCode');
    const part = make();
    await part.svc.recordPayment(ACTOR, ID, { amountCents: 1_000, paidOn: '2026-11-03', bankReference: 'TRF-2', reason: 'A cuenta', totpCode: '123456' });
    expect(part.audit.write).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ action: 'settlement.paid_partially', reason: 'A cuenta' }));
  });

  it('con el 2FA mal no se escribe nada', async () => {
    const m = make({ stepUpFails: true });
    await expect(m.svc.void(ACTOR, ID, { reason: 'Cifras mal', totpCode: '000000' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.svc.recordPayment(ACTOR, ID, { amountCents: 1, paidOn: '2026-11-03', bankReference: 'x', totpCode: '000000' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(m.svc.setPayee(ACTOR, { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', totpCode: '000000' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(m.order).toEqual(['2fa', '2fa', '2fa']);
    expect(m.audit.write).not.toHaveBeenCalled();
  });

  it('anular → settlement.voided con el motivo; la cuenta de OxioPay → payee_updated', async () => {
    const m = make();
    await m.svc.void(ACTOR, ID, { reason: 'Cifras mal', totpCode: '123456' });
    expect(m.audit.write).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ action: 'settlement.voided', reason: 'Cifras mal', after: { status: 'VOID' } }));
    await m.svc.setPayee(ACTOR, { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', totpCode: '123456' });
    expect(m.audit.write).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ action: 'settlement.payee_updated', targetType: 'OxioPayPayee' }));
  });

  it('generar: regenerada → settlement.regenerated; si ya hay una o no hay nada, 409 con su código', async () => {
    const m = make();
    await m.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }, new Date('2026-11-03T10:00:00Z'));
    expect(m.audit.write).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ action: 'settlement.regenerated', extra: expect.objectContaining({ replacesId: 'old' }) }));
    const exists = make({ generate: { kind: 'exists', id: ID, reference: 'OXP-2026-S44-LUNA' } });
    const err = await exists.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(((err as ConflictException).getResponse() as { code: string }).code).toBe('SETTLEMENT_EXISTS');
    const nothing = make({ generate: { kind: 'nothing', totalCents: 0 } });
    const err2 = await nothing.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }).catch((e: unknown) => e);
    expect(((err2 as ConflictException).getResponse() as { code: string }).code).toBe('SETTLEMENT_NOTHING');
    expect(exists.audit.write).not.toHaveBeenCalled();
  });
});
