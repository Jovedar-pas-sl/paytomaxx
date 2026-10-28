import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { payeeChangedMessage, SuperAdminSettlementsService } from './settlements.service';

const ACTOR = { id: 'sa-1', email: 'jefe@x.es', ip: '203.0.113.7', userAgent: 'vitest' };
const ID = '00000000-0000-4000-8000-0000000000cc';
const V = '00000000-0000-4000-8000-0000000000aa';
const TX = { auditEvent: {} } as never;
const row = (o: Record<string, unknown> = {}) => ({ id: ID, tenantId: V, reference: 'OXP-2026-S44-LUNA', status: 'ISSUED', totalCents: 2_235, paidCents: 0, ...o });
const PAYEE = { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', updatedAt: 'x' };

function make(o: { stepUpFails?: boolean; generate?: unknown; precheck?: Error; telegramFails?: boolean } = {}) {
  const order: string[] = [];
  const core = {
    paymentPrecheck: vi.fn(async () => {
      order.push('precheck');
      if (o.precheck) throw o.precheck;
    }),
    voidPrecheck: vi.fn(async () => {
      order.push('precheck');
      if (o.precheck) throw o.precheck;
    }),
    generationStart: vi.fn(async () => {
      order.push('precheck');
      if (o.precheck) throw o.precheck;
    }),
    recordPayment: vi.fn(async (_a: unknown, _id: string, dto: { amountCents: number }, _now: Date, onWrite?: (tx: unknown, r: unknown) => Promise<void>) => {
      order.push('write');
      const paid = dto.amountCents;
      const result = { before: row(), after: row({ paidCents: paid, status: paid === 2_235 ? 'PAID' : 'PARTIALLY_PAID' }), paymentId: 'p1' };
      await onWrite?.(TX, result);
      return result;
    }),
    voidSettlement: vi.fn(async (_a: unknown, _id: string, _r: string, _n: Date, onWrite?: (tx: unknown, r: unknown) => Promise<void>) => {
      order.push('write');
      const result = { before: row(), after: row({ status: 'VOID' }) };
      await onWrite?.(TX, result);
      return result;
    }),
    generate: vi.fn(async (_v: string, _w: unknown, opts: { onWrite?: (tx: unknown, r: unknown) => Promise<void> }) => {
      order.push('write');
      if (o.generate) return o.generate;
      await opts.onWrite?.(TX, { id: ID, reference: 'OXP-2026-S44-LUNA/R2', totalCents: 2_235, replacesId: 'old' });
      return { kind: 'created', id: ID, reference: 'OXP-2026-S44-LUNA/R2', totalCents: 2_235, replacesId: 'old' };
    }),
    setPayee: vi.fn(async (_a: unknown, _d: unknown, onWrite?: (tx: unknown, r: unknown) => Promise<void>) => {
      order.push('write');
      const result = { before: null, after: PAYEE };
      await onWrite?.(TX, result);
      return result;
    }),
    setStartWeek: vi.fn(async (_a: unknown, monday: string, onWrite?: (tx: unknown, r: unknown) => Promise<void>) => {
      order.push('write');
      const result = { before: '2026-11-02', after: monday };
      await onWrite?.(TX, result);
      return result;
    }),
    startWeek: vi.fn(async () => ({ monday: '2026-11-02' })),
    detailForSuperAdmin: vi.fn(async () => ({ id: ID })),
  };
  const stepUp = {
    verify: vi.fn(async () => {
      order.push('2fa');
      if (o.stepUpFails) throw new ForbiddenException({ message: 'Código incorrecto', code: 'TOTP_INVALID' });
    }),
  };
  const audit = { write: vi.fn(async () => undefined), writeInTx: vi.fn(async () => undefined) };
  const telegram = { send: vi.fn(async () => (o.telegramFails ? Promise.reject(new Error('caído')) : true)) };
  return { svc: new SuperAdminSettlementsService(core as never, stepUp as never, audit as never, telegram as never), core, stepUp, audit, telegram, order };
}

describe('consola: lo que no va a valer, antes del 2FA; el 2FA; y el registro en la misma transacción', () => {
  it('pagada entera → superadmin.settlement.paid; en parte → paid_partially con el motivo; el registro dentro de la transacción', async () => {
    const full = make();
    await full.svc.recordPayment(ACTOR, ID, { amountCents: 2_235, paidOn: '2026-11-03', bankReference: 'TRF-1', totpCode: '123456' });
    expect(full.order).toEqual(['precheck', '2fa', 'write']);
    expect(full.stepUp.verify).toHaveBeenCalledWith(ACTOR, '123456', 'settlement.pay');
    expect(full.audit.writeInTx).toHaveBeenCalledWith(
      TX,
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
    expect(full.audit.write).not.toHaveBeenCalled();
    // El código 2FA no llega al servicio (ni al registro).
    expect(full.core.recordPayment.mock.calls[0]![2]).not.toHaveProperty('totpCode');
    const part = make();
    await part.svc.recordPayment(ACTOR, ID, { amountCents: 1_000, paidOn: '2026-11-03', bankReference: 'TRF-2', reason: 'A cuenta', totpCode: '123456' });
    expect(part.audit.writeInTx).toHaveBeenCalledWith(TX, ACTOR, expect.objectContaining({ action: 'settlement.paid_partially', reason: 'A cuenta' }));
  });

  it('una referencia repetida, una fecha mala o una semana anterior a la de inicio: el error SIN gastar el código 2FA', async () => {
    const dup = make({ precheck: new ConflictException({ message: 'Ya hay un pago con la referencia TRF-1', code: 'SETTLEMENT_PAYMENT_DUPLICATE' }) });
    await expect(dup.svc.recordPayment(ACTOR, ID, { amountCents: 1, paidOn: '2026-11-03', bankReference: 'TRF-1', totpCode: '123456' })).rejects.toBeInstanceOf(ConflictException);
    expect(dup.stepUp.verify).not.toHaveBeenCalled();
    const early = make({ precheck: new BadRequestException('anterior a la semana de inicio') });
    await expect(early.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' })).rejects.toBeInstanceOf(BadRequestException);
    expect(early.stepUp.verify).not.toHaveBeenCalled();
    const paid = make({ precheck: new ConflictException('sin pagos') });
    await expect(paid.svc.void(ACTOR, ID, { reason: 'x', totpCode: '123456' })).rejects.toBeInstanceOf(ConflictException);
    expect(paid.stepUp.verify).not.toHaveBeenCalled();
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
    await expect(m.svc.setStartWeek(ACTOR, { startWeek: '2026-11-09', reason: 'Empezamos', totpCode: '000000' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.order.filter((x) => x === 'write')).toEqual([]);
    expect(m.audit.writeInTx).not.toHaveBeenCalled();
  });

  it('anular → settlement.voided con el motivo; generar a mano: regenerada → settlement.regenerated; 409 si ya hay una o no hay nada', async () => {
    const m = make();
    await m.svc.void(ACTOR, ID, { reason: 'Cifras mal', totpCode: '123456' });
    expect(m.audit.writeInTx).toHaveBeenCalledWith(TX, ACTOR, expect.objectContaining({ action: 'settlement.voided', reason: 'Cifras mal', after: { status: 'VOID' } }));
    await m.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }, new Date('2026-11-03T10:00:00Z'));
    expect(m.audit.writeInTx).toHaveBeenCalledWith(TX, ACTOR, expect.objectContaining({ action: 'settlement.regenerated', extra: expect.objectContaining({ replacesId: 'old' }) }));
    const exists = make({ generate: { kind: 'exists', id: ID, reference: 'OXP-2026-S44-LUNA' } });
    const err = await exists.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }).catch((e: unknown) => e);
    expect(((err as ConflictException).getResponse() as { code: string }).code).toBe('SETTLEMENT_EXISTS');
    const nothing = make({ generate: { kind: 'nothing', totalCents: 0 } });
    const err2 = await nothing.svc.generate(ACTOR, { venueId: V, week: '2026-10-26', totpCode: '123456' }).catch((e: unknown) => e);
    expect(((err2 as ConflictException).getResponse() as { code: string }).code).toBe('SETTLEMENT_NOTHING');
  });

  it('la cuenta de OxioPay: registro en la transacción y aviso por Telegram (IBAN tapado, quién); si Telegram falla, el cambio sigue hecho', async () => {
    const m = make();
    await m.svc.setPayee(ACTOR, { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', totpCode: '123456' });
    expect(m.audit.writeInTx).toHaveBeenCalledWith(TX, ACTOR, expect.objectContaining({ action: 'settlement.payee_updated', targetType: 'OxioPayPayee' }));
    const text = String(m.telegram.send.mock.calls[0]![0]);
    expect(text).toContain('jefe@x.es');
    expect(text).toContain('ES91 •••• •••• 1332');
    expect(text).not.toContain('ES9121000418450200051332');
    const failing = make({ telegramFails: true });
    await expect(failing.svc.setPayee(ACTOR, { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', totpCode: '123456' })).resolves.toEqual(PAYEE);
    expect(payeeChangedMessage(ACTOR, { ...PAYEE, holder: 'Antes SL' }, PAYEE)).toContain('antes: Antes SL');
  });

  it('la semana de inicio: se ve y se cambia con 2FA, motivo y registro', async () => {
    const m = make();
    expect(await m.svc.settings()).toEqual({ startWeek: '2026-11-02' });
    expect(await m.svc.setStartWeek(ACTOR, { startWeek: '2026-11-09', reason: 'Empezamos el 9', totpCode: '123456' })).toEqual({ startWeek: '2026-11-09' });
    expect(m.stepUp.verify).toHaveBeenCalledWith(ACTOR, '123456', 'settlement.start_week');
    expect(m.audit.writeInTx).toHaveBeenCalledWith(
      TX,
      ACTOR,
      expect.objectContaining({ action: 'settlement.start_week_updated', reason: 'Empezamos el 9', before: { startWeek: '2026-11-02' }, after: { startWeek: '2026-11-09' } }),
    );
  });
});
