import { describe, expect, it, vi } from 'vitest';
import { ReservationOpsService, type StaffActor } from './reservation-ops.service';
import { ReservationsService } from './reservations.service';

/**
 * El local anula un reservado (decisión del dueño del 17-nov, con el abogado):
 * lo pagado (con tarjeta o con bitcoin) NO se devuelve: se queda como saldo del
 * grupo para otra noche. Sin pagar, se cancela sin más. El RRPP pierde la
 * comisión igual que antes. Con la base de verdad: reservados*.int.spec.ts.
 */

const ID = '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const owner: StaffActor = { userId: '0f0e0d0c-0000-4000-8000-000000000001', role: 'OWNER', tenantId: '0f0e0d0c-0000-4000-8000-0000000000aa' };

/** La fila de la base (lo que lee la vista y lo que bloquea `locked`). */
function row(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    tenantId: owner.tenantId,
    ref: 'K7Q4M2',
    status: 'DEPOSIT_PAID',
    nightDate: new Date('2026-12-21T00:00:00Z'),
    previousNightDate: null,
    dateChangedAt: null,
    packageName: 'Mesa consumo',
    kind: 'CREDIT',
    priceCents: 50000,
    creditCents: 40000,
    depositCents: 15000,
    paidCents: 15000,
    entries: 4,
    items: [],
    customerName: 'Laura Gómez',
    customerPhone: '600112233',
    notes: null,
    tableLabel: null,
    source: 'WEB',
    soldByUserId: null,
    promoterId: null,
    walletId: 'w-1',
    arrivedAt: null,
    noShowAuto: false,
    canceledAt: null,
    cancelReason: null,
    recognizedAt: null,
    createdAt: new Date('2026-11-16T12:00:00Z'),
    guests: [],
    spends: [],
    wallet: { balanceCents: 15000, status: 'ACTIVE', qrToken: 'w-tok' },
    promoter: null,
    payments: [],
    ...over,
  };
}

/** El servicio con una base de mentira: lo que escribe queda en `updates` y `executed`. */
function opsWith(start: ReturnType<typeof row>) {
  const state = { ...start };
  const updates: Array<Record<string, unknown>> = [];
  const executed: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('operator_earnings') ? [] : [{ id: state.id }])),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      executed.push(strings.join('?'));
      return 1;
    }),
    reservation: {
      findMany: async () => [state],
      findUniqueOrThrow: async () => state,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        Object.assign(state, data);
        return state;
      },
    },
    user: { findMany: async () => [] },
  };
  const prisma = { withTenant: async (_tenant: string, fn: (t: typeof tx) => unknown) => fn(tx) };
  const audit = { logInTx: vi.fn(async () => undefined) };
  const reservations = { cancelOpenPayments: vi.fn(async () => undefined), cancelLeftoverPayments: vi.fn(async () => undefined) };
  const ops = new ReservationOpsService(prisma as never, audit as never, reservations as never, {} as never, {} as never);
  return { ops, updates, executed, audit, reservations };
}

describe('el local anula: lo pagado queda como saldo del grupo', () => {
  it('pagada: anulada, lo pagado (150 €) sigue en el saldo del grupo y nada se devuelve', async () => {
    const { ops, updates, audit } = opsWith(row());
    const out = await ops.venueCancel(owner, ID, 'Cerramos esa noche');
    expect(out).toMatchObject({ saldoCents: 15000, walletId: 'w-1' });
    expect(out).not.toHaveProperty('refundCents');
    expect(out.reservation).toMatchObject({ status: 'CANCELED', statusText: 'Anulada por el local', paidCents: 15000 });
    expect(updates[0]).toMatchObject({ status: 'CANCELED', canceledByUserId: owner.userId, cancelReason: 'Cerramos esa noche' });
    // Pasa a saldo ahora: «Señales de reservas» lo cuenta en este día.
    expect(updates[0]?.recognizedAt).toBeInstanceOf(Date);
    expect(audit.logInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'reservation.canceled_by_venue', payload: expect.objectContaining({ paidCents: 15000, saldoCents: 15000 }) }),
    );
  });

  it('sin pagar: se cancela sin saldo (nada pasa a saldo)', async () => {
    const { ops, updates } = opsWith(row({ status: 'PENDING', paidCents: 0, walletId: null, wallet: null }));
    const out = await ops.venueCancel(owner, ID, 'Cerramos esa noche');
    expect(out).toMatchObject({ saldoCents: 0, walletId: null });
    expect(updates[0]).toMatchObject({ status: 'CANCELED' });
    expect(updates[0]).not.toHaveProperty('recognizedAt');
  });

  it('vendida por un RRPP: pierde la comisión, igual que antes', async () => {
    const { ops, executed } = opsWith(row({ source: 'RRPP', promoterId: '0f0e0d0c-0000-4000-8000-0000000000bb' }));
    await ops.venueCancel(owner, ID, 'Cerramos esa noche');
    expect(executed.some((sql) => sql.includes('"commissionVoidedAt" = now()'))).toBe(true);
  });

  it('antes de anular cancela su pago a medias (como siempre) y después el que se abrió entretanto', async () => {
    const { ops, reservations } = opsWith(row());
    await ops.venueCancel(owner, ID, 'Cerramos esa noche');
    expect(reservations.cancelOpenPayments).toHaveBeenCalledWith(ID, owner.tenantId, expect.objectContaining({ reason: 'Reserva anulada por el local' }));
    expect(reservations.cancelLeftoverPayments).toHaveBeenCalledWith(ID, owner.tenantId, 'Reserva anulada por el local', owner.userId);
  });

  it('el camarero no puede', async () => {
    const { ops } = opsWith(row());
    await expect(ops.venueCancel({ ...owner, role: 'WAITER' }, ID, 'x')).rejects.toThrow('Solo el encargado o el dueño');
  });
});

describe('la página del grupo de una reserva anulada por el local', () => {
  function groupOf(over: Record<string, unknown>) {
    const r = { ...row(over), manageToken: 'M'.repeat(32), venue: { name: 'Sala Aurora', reservationsOpenMinute: 23 * 60 } };
    const tx = { reservation: { findUnique: async () => r }, reservationPayment: { findMany: async () => [] } };
    const prisma = { asSystem: async (fn: (t: typeof tx) => unknown) => fn(tx) };
    return new ReservationsService(prisma as never, {} as never, {} as never, {} as never).groupView('M'.repeat(32), new Date('2026-11-17T12:00:00Z'));
  }

  it('con lo pagado en su saldo: el enlace al saldo', async () => {
    const view = await groupOf({ status: 'CANCELED', paidCents: 15000 });
    expect(view?.saldoHref).toBe('/w/w-tok');
    expect(view?.payable).toEqual([]);
    expect(view?.cancel).toBeNull();
  });

  it('sin pagar (o con el saldo ya gastado): sin enlace', async () => {
    expect((await groupOf({ status: 'CANCELED', paidCents: 0, walletId: null, wallet: null }))?.saldoHref).toBeNull();
    expect((await groupOf({ status: 'CANCELED', paidCents: 15000, wallet: { balanceCents: 0, status: 'DEPLETED', qrToken: 'w-tok' } }))?.saldoHref).toBeNull();
  });
});
