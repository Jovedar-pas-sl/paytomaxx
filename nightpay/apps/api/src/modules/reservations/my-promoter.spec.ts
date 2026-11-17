import { describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@nightpay/contracts';
import { MyPromoterController } from './my-promoter.controller';
import { myPromoterReservation, type MyPromoterRow } from './my-promoter.service';

const row = (o: Partial<MyPromoterRow> = {}): MyPromoterRow => ({
  ref: 'R-0007',
  nightDate: new Date('2026-11-21T00:00:00Z'),
  packageName: 'Mesa botellas',
  entries: 6,
  status: 'DEPOSIT_PAID',
  priceCents: 30000,
  paidCents: 9000,
  promoterBps: 1000,
  commissionEarnedAt: null,
  commissionVoidedAt: null,
  ...o,
});

describe('una reserva en «Tus reservas de RRPP»', () => {
  it('la referencia, la noche, el paquete, las personas, el estado y los importes; nada del cliente', () => {
    const v = myPromoterReservation(row());
    expect(v).toEqual({
      ref: 'R-0007',
      nightDate: '2026-11-21',
      packageName: 'Mesa botellas',
      entries: 6,
      status: 'DEPOSIT_PAID',
      statusText: 'Señal pagada',
      priceCents: 30000,
      paidCents: 9000,
      pendingCents: 21000,
      commissionCents: 3000,
      commission: 'EXPECTED',
    });
    for (const k of ['customerName', 'customerPhone', 'notes', 'manageToken', 'id', 'walletId']) expect(v).not.toHaveProperty(k);
  });

  it('pagada entera: su comisión ganada y nada pendiente', () => {
    const v = myPromoterReservation(row({ status: 'PAID', paidCents: 30000, commissionEarnedAt: new Date() }));
    expect(v).toMatchObject({ statusText: 'Pagado', pendingCents: 0, commission: 'EARNED', commissionCents: 3000 });
  });

  it('con su % de cuando la vendió (no el de ahora)', () => {
    expect(myPromoterReservation(row({ promoterBps: 1500 })).commissionCents).toBe(4500);
    expect(myPromoterReservation(row({ promoterBps: null })).commissionCents).toBe(0);
  });

  it('el local se la quitó (cambió la fecha o anuló): sin comisión, aunque estuviera ganada', () => {
    const voided = new Date();
    expect(myPromoterReservation(row({ commissionVoidedAt: voided })).commission).toBe('NONE');
    expect(myPromoterReservation(row({ status: 'CANCELED', paidCents: 30000, commissionEarnedAt: voided, commissionVoidedAt: voided }))).toMatchObject({
      statusText: 'Anulada',
      pendingCents: 0,
      commission: 'NONE',
    });
  });

  it('«No vino», anulada o llegada sin pagar entera: ya no se paga, ni falta nada ni hay comisión', () => {
    for (const status of ['NO_SHOW', 'CANCELED', 'CLIENT_CANCELED', 'ARRIVED']) {
      expect(myPromoterReservation(row({ status }))).toMatchObject({ pendingCents: 0, commission: 'NONE' });
    }
    expect(myPromoterReservation(row({ status: 'NO_SHOW' })).statusText).toBe('No vino');
    expect(myPromoterReservation(row({ status: 'ARRIVED', paidCents: 30000, commissionEarnedAt: new Date() }))).toMatchObject({
      statusText: 'Ha llegado',
      commission: 'EARNED',
    });
  });

  it('sin pagar: falta todo y la comisión llegará al pagarla entera', () => {
    expect(myPromoterReservation(row({ status: 'PENDING', paidCents: 0 }))).toMatchObject({
      statusText: 'Sin pagar',
      pendingCents: 30000,
      commission: 'EXPECTED',
    });
  });
});

describe('GET /v1/staff/me/promoter', () => {
  it('solo la persona y el local de la sesión', async () => {
    const forUser = vi.fn().mockResolvedValue(null);
    const controller = new MyPromoterController({ forUser } as never);
    const page = await controller.page({ sub: 'self', tenantId: 'my-venue', role: 'WAITER' } as JwtPayload);
    expect(forUser).toHaveBeenCalledWith({ userId: 'self', tenantId: 'my-venue', role: 'WAITER' });
    expect(page).toEqual({ promoter: null });
  });
});
