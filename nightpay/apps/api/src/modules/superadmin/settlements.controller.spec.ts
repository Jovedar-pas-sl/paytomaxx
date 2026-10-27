import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { OxioPayPayee, SettlementDetail } from '@nightpay/contracts';
import { SuperAdminSettlementsController } from './settlements.controller';
import type { SuperAdminSettlementsService } from './settlements.service';
import type { SuperAdminActor } from './superadmin.guard';

/**
 * Las escrituras de la consola de «Liquidaciones OxioPay» pasan tal cual al
 * servicio, con quién lo hace (los permisos, el 2FA y la validación se prueban
 * con la app de verdad en oxiopay-settlements.http.spec.ts).
 */
const ACTOR: SuperAdminActor = { id: '00000000-0000-4000-8000-000000000001', email: 'jefe@x.es', ip: '203.0.113.9', userAgent: 'vitest' };
const ID = '00000000-0000-4000-8000-0000000000cc';
const DETAIL = { id: ID, reference: 'OXP-2026-S44-LUNA' } as SettlementDetail;
const PAYEE: OxioPayPayee = { name: 'OxioPay', iban: 'ES9121000418450200051332', holder: 'OxioPay SL', updatedAt: '2026-10-27T10:00:00.000Z' };

function make() {
  const svc = {
    setPayee: vi.fn().mockResolvedValue(PAYEE),
    setStartWeek: vi.fn().mockResolvedValue({ startWeek: '2026-11-09' }),
    generate: vi.fn().mockResolvedValue(DETAIL),
    void: vi.fn().mockResolvedValue({ ...DETAIL, status: 'VOID' }),
    recordPayment: vi.fn().mockResolvedValue(DETAIL),
  };
  return { svc, ctrl: new SuperAdminSettlementsController(svc as unknown as SuperAdminSettlementsService) };
}

describe('consola: escrituras de las liquidaciones', () => {
  it('la cuenta de OxioPay: la del servicio, dentro de { payee }', async () => {
    const { svc, ctrl } = make();
    const dto = { name: 'OxioPay', iban: PAYEE.iban, holder: 'OxioPay SL', totpCode: '123456' };
    await expect(ctrl.setPayee(ACTOR, dto)).resolves.toEqual({ payee: PAYEE });
    expect(svc.setPayee).toHaveBeenCalledWith(ACTOR, dto);
  });

  it('la semana de inicio, generar, anular y apuntar un pago: con quién lo hace', async () => {
    const { svc, ctrl } = make();
    const start = { startWeek: '2026-11-09', reason: 'Empezamos', totpCode: '123456' };
    await expect(ctrl.setSettings(ACTOR, start)).resolves.toEqual({ startWeek: '2026-11-09' });
    expect(svc.setStartWeek).toHaveBeenCalledWith(ACTOR, start);

    const gen = { venueId: '00000000-0000-4000-8000-0000000000aa', week: '2026-10-26', totpCode: '123456' };
    await expect(ctrl.generate(ACTOR, gen)).resolves.toBe(DETAIL);
    expect(svc.generate).toHaveBeenCalledWith(ACTOR, gen);

    const voided = { reason: 'Cifras mal', totpCode: '123456' };
    await expect(ctrl.void(ACTOR, ID, voided)).resolves.toMatchObject({ status: 'VOID' });
    expect(svc.void).toHaveBeenCalledWith(ACTOR, ID, voided);

    const pay = { amountCents: 2_235, paidOn: '2026-11-03', bankReference: 'TRF-1', confirmDuplicate: true, totpCode: '123456' };
    await expect(ctrl.recordPayment(ACTOR, ID, pay)).resolves.toBe(DETAIL);
    expect(svc.recordPayment).toHaveBeenCalledWith(ACTOR, ID, pay);
  });
});
