import { describe, it, expect, vi } from 'vitest';
import type { CustomerScreenView } from '@nightpay/contracts';
import { CustomerDisplayService } from './customer-display.service';
import type { DisplaySession } from './display-auth';

/**
 * La propina que el cliente elige en la «Pantalla del cliente» (setTip): en un
 * cobro con tarjeta queda apuntada en payment_events (`display.tip`, uno por
 * cambio) para que /pay la marque solo si de verdad se eligió allí (idea 66,
 * parte B). Con solo el saldo, sin apunte.
 */

const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const PAYMENT = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const CHARGE = '2c1b0a9f-8e7d-4c6b-9a5f-4e3d2c1b0a9f';

function display(o: Partial<DisplaySession> = {}): DisplaySession {
  return {
    id: 'd-1',
    tenantId: TENANT,
    userId: 'u-ana',
    role: 'OPERATOR',
    tokenHash: 'h',
    expiresAt: new Date(Date.now() + 3_600_000),
    paymentId: PAYMENT,
    chargeId: null,
    clearedAt: null,
    lastSeenAt: null,
    tipCents: 0,
    ...o,
  };
}

const WAITING = {
  state: 'waiting',
  key: 'k-1',
  paying: false,
  tip: { presets: [{ cents: 300 }, { cents: 500 }], maxCents: 3_300, chosenCents: 0, toStaff: true },
} as unknown as CustomerScreenView;

function makeService(view: CustomerScreenView = WAITING) {
  const tx = {
    customerDisplay: { updateMany: vi.fn(async () => ({ count: 1 })) },
    walletChargeRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    paymentEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const service = new CustomerDisplayService(prisma as never, {} as never, {} as never, {} as never);
  vi.spyOn(service, 'screen').mockResolvedValue(view);
  return { service, tx };
}

describe('setTip: la propina de la pantalla de la barra queda apuntada solo en un cobro con tarjeta', () => {
  it('cobro con tarjeta: un apunte display.tip { tipCents } por cada cambio (también «Sin propina»)', async () => {
    const { service, tx } = makeService();
    await service.setTip(display(), { key: 'k-1', tipCents: 500 });
    await service.setTip(display({ tipCents: 500 }), { key: 'k-1', tipCents: 0 });
    expect(tx.paymentEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.paymentEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ paymentId: PAYMENT, tenantId: TENANT, eventType: 'display.tip', payload: { tipCents: 500 } }),
    });
    expect(tx.paymentEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ paymentId: PAYMENT, eventType: 'display.tip', payload: { tipCents: 0 } }),
    });
    // Nada más en el apunte (ni datos del cliente).
    const first = (tx.paymentEvent.create.mock.calls[0] as unknown as [{ data: { payload: unknown } }])[0];
    expect(Object.keys(first.data.payload as object)).toEqual(['tipCents']);
  });

  it('solo el saldo (sin cobro con tarjeta): sin apunte; la propina queda en el cobro del saldo', async () => {
    const { service, tx } = makeService();
    await service.setTip(display({ paymentId: null, chargeId: CHARGE }), { key: 'k-1', tipCents: 500 });
    expect(tx.paymentEvent.create).not.toHaveBeenCalled();
    expect(tx.walletChargeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { tipCents: 500 } }));
  });

  it('cobro único (tarjeta y saldo): el apunte en el de tarjeta y la propina en el del saldo', async () => {
    const { service, tx } = makeService();
    await service.setTip(display({ chargeId: CHARGE }), { key: 'k-1', tipCents: 300 });
    expect(tx.paymentEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.walletChargeRequest.updateMany).toHaveBeenCalledTimes(1);
  });

  it('propina no válida, otro cobro o la pantalla ya no es la misma: ni apunte ni cambio', async () => {
    const { service, tx } = makeService();
    await expect(service.setTip(display(), { key: 'k-1', tipCents: 450 })).rejects.toThrow('Propina no válida');
    await expect(service.setTip(display(), { key: 'otro', tipCents: 500 })).rejects.toThrow();
    tx.customerDisplay.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.setTip(display(), { key: 'k-1', tipCents: 500 })).rejects.toThrow();
    expect(tx.paymentEvent.create).not.toHaveBeenCalled();
  });

  it('sin propinas en el cobro (datáfono, recarga): «Sin propina» no deja apunte', async () => {
    const { service, tx } = makeService({ ...WAITING, tip: null } as unknown as CustomerScreenView);
    await service.setTip(display(), { key: 'k-1', tipCents: 0 });
    expect(tx.paymentEvent.create).not.toHaveBeenCalled();
  });
});
