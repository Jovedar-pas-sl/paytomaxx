import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { IncidentsController } from './incidents.controller';

const TENANT = 't-1';
const user = (role: string, sub = 'u-chica') => ({ sub, role, tenantId: TENANT }) as unknown as JwtPayload;

function make(payment: { createdByUserId: string | null; status: string } | null) {
  const findFirst = vi.fn(async () => payment);
  const prisma = { asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ payment: { findFirst } })) };
  const alerts = { notifyPaymentNow: vi.fn(async () => ({ sent: true, telegram: true })) };
  const ctrl = new IncidentsController({} as never, {} as never, prisma as never, alerts as never);
  return { ctrl, alerts, findFirst };
}

describe('POST /v1/incidents/notify — «Avisar al encargado» de un cobro que el banco no confirma', () => {
  it('la chica que lo cobró avisa: la incidencia del cobro le llega al encargado', async () => {
    const { ctrl, alerts, findFirst } = make({ createdByUserId: 'u-chica', status: 'ORPHAN' });
    await expect(ctrl.notify(user('OPERATOR'), { paymentId: 'p-1' })).resolves.toEqual({ notified: true, telegram: true });
    expect(alerts.notifyPaymentNow).toHaveBeenCalledWith(TENANT, 'p-1');
    // Solo un cobro de su local.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-1', tenantId: TENANT } }));
  });

  it('de otro (o de otro local): como si no existiera; el encargado y el dueño, de cualquiera del local', async () => {
    const other = make({ createdByUserId: 'u-otra', status: 'ORPHAN' });
    await expect(other.ctrl.notify(user('OPERATOR'), { paymentId: 'p-1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(other.ctrl.notify(user('WAITER', 'u-carlos'), { paymentId: 'p-1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(other.ctrl.notify(user('MANAGER', 'u-enc'), { paymentId: 'p-1' })).resolves.toMatchObject({ notified: true });
    expect(other.alerts.notifyPaymentNow).toHaveBeenCalledTimes(1);
    const none = make(null);
    await expect(none.ctrl.notify(user('OWNER', 'u-boss'), { paymentId: 'p-x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un cobro que ya no espera al banco (pagado, caducado…): 409 sin avisar', async () => {
    const paid = make({ createdByUserId: 'u-chica', status: 'AUTHORIZED' });
    await expect(paid.ctrl.notify(user('OPERATOR'), { paymentId: 'p-1' })).rejects.toBeInstanceOf(ConflictException);
    expect(paid.alerts.notifyPaymentNow).not.toHaveBeenCalled();
    // Esperando al banco aún (AUTHORIZING largo), sí.
    const slow = make({ createdByUserId: 'u-chica', status: 'AUTHORIZING' });
    await expect(slow.ctrl.notify(user('OPERATOR'), { paymentId: 'p-1' })).resolves.toMatchObject({ telegram: true });
  });
});
