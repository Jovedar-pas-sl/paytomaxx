import { describe, expect, it, vi } from 'vitest';
import { OwnCobrosQuerySchema, type JwtPayload } from '@nightpay/contracts';
import { OwnCobrosController } from './own-cobros.controller';
const user = { sub: 'self', tenantId: 'my-venue', role: 'WAITER' } as JwtPayload;
it('impone la persona y local de la sesión; no expone detalles bancarios ni identificadores del saldo', async () => {
  const list = vi.fn().mockResolvedValue({ nextCursor: 'next', items: [{ kind: 'SALDO', id: 'sale', ref: 'C-0001', createdAt: '2026-10-21T10:00:00Z', amountCents: 2000, tipCents: 0, status: 'ACCEPTED', methodLabel: 'Saldo', via: 'NFC', service: 'Invitar a una copa', isTopUp: false, invited: { name: 'Lola', id: 'girl', role: 'OPERATOR' }, wallet: { id: 'private' }, person: { id: 'self' }, payment: { authCode: 'private-code' }, lines: [] }] });
  const currentWindow = vi.fn();
  const controller = new OwnCobrosController({ list } as never, { currentWindow } as never);
  const page = await controller.list(user, { limit: 50, cursor: 'cursor' });
  expect(list).toHaveBeenCalledWith('my-venue', { limit: 50, cursor: 'cursor', operatorId: 'self' });
  expect(page.items[0]).toMatchObject({ service: 'Invitar a una copa', invitedName: 'Lola', via: 'NFC' });
  for (const key of ['wallet', 'person', 'payment', 'lines']) expect(page.items[0]).not.toHaveProperty(key);
  expect(page.nextCursor).toBe('next');
  // Con cursor (página siguiente) no se pide la noche.
  expect(currentWindow).not.toHaveBeenCalled();
  expect(page).not.toHaveProperty('night');
});

it('la primera página trae la noche del local y lo devuelto de cada cobro con tarjeta', async () => {
  const card = { kind: 'PAYMENT', id: 'p1', ref: 'C-0002', createdAt: '2026-10-21T23:00:00Z', amountCents: 2000, tipCents: 500, status: 'PARTIALLY_REFUNDED', methodLabel: 'Tarjeta', via: 'QR', service: '2 copas', isTopUp: false, invited: null, payment: { availableAmountCents: 1500 } };
  const list = vi.fn().mockResolvedValue({ nextCursor: null, items: [card, { ...card, id: 'p2', status: 'AUTHORIZED', payment: { availableAmountCents: 2500 } }] });
  const currentWindow = vi.fn().mockResolvedValue({ from: new Date('2026-10-21T19:00:00Z'), to: new Date(), nightId: 'n1', open: true, openingFloatCents: null });
  const controller = new OwnCobrosController({ list } as never, { currentWindow } as never);
  const page = await controller.list(user, { limit: 50 });
  expect(currentWindow).toHaveBeenCalledWith('my-venue');
  expect(page.night).toEqual({ from: '2026-10-21T19:00:00.000Z', open: true });
  expect(page.items.map((r) => r.refundedCents)).toEqual([1000, 0]);
});
describe('consulta del historial propio', () => {
  it('solo admite paginación; no permite suplantar usuario, local ni consultar otro saldo', () => {
    expect(OwnCobrosQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const query of [{ operatorId: 'someone' }, { tenantId: 'other' }, { walletId: 'other' }, { limit: 9999 }]) {
      expect(OwnCobrosQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

it('la lista y la noche, una detrás de otra: una petición no ocupa dos conexiones a la vez (P2028)', async () => {
  let open = 0;
  let maxOpen = 0;
  const busy = async <T>(value: T): Promise<T> => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    await new Promise((r) => setTimeout(r, 5));
    open -= 1;
    return value;
  };
  const list = vi.fn(() => busy({ nextCursor: null, items: [] }));
  const currentWindow = vi.fn(() => busy({ from: new Date('2026-10-21T19:00:00Z'), to: new Date(), nightId: 'n1', open: true, openingFloatCents: null }));
  const controller = new OwnCobrosController({ list } as never, { currentWindow } as never);
  await controller.list(user, { limit: 50 });
  expect(maxOpen).toBe(1);
});
