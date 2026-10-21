import { describe, expect, it, vi } from 'vitest';
import { OwnCobrosQuerySchema, type JwtPayload } from '@nightpay/contracts';
import { OwnCobrosController } from './own-cobros.controller';
const user = { sub: 'self', tenantId: 'my-venue', role: 'WAITER' } as JwtPayload;
it('impone la persona y local de la sesión; no expone detalles bancarios ni identificadores del saldo', async () => {
  const list = vi.fn().mockResolvedValue({ nextCursor: 'next', items: [{ kind: 'SALDO', id: 'sale', ref: 'C-0001', createdAt: '2026-10-21T10:00:00Z', amountCents: 2000, tipCents: 0, status: 'ACCEPTED', methodLabel: 'Saldo', via: 'NFC', service: 'Invitar a una copa', isTopUp: false, invited: { name: 'Lola', id: 'girl', role: 'OPERATOR' }, wallet: { id: 'private' }, person: { id: 'self' }, payment: { authCode: 'private-code' }, lines: [] }] });
  const controller = new OwnCobrosController({ list } as never);
  const page = await controller.list(user, { limit: 50, cursor: 'cursor' });
  expect(list).toHaveBeenCalledWith('my-venue', { limit: 50, cursor: 'cursor', operatorId: 'self' });
  expect(page.items[0]).toMatchObject({ service: 'Invitar a una copa', invitedName: 'Lola', via: 'NFC' });
  for (const key of ['wallet', 'person', 'payment', 'lines']) expect(page.items[0]).not.toHaveProperty(key);
  expect(page.nextCursor).toBe('next');
});
describe('consulta del historial propio', () => {
  it('solo admite paginación; no permite suplantar usuario, local ni consultar otro saldo', () => {
    expect(OwnCobrosQuerySchema.parse({})).toEqual({ limit: 50 });
    for (const query of [{ operatorId: 'someone' }, { tenantId: 'other' }, { walletId: 'other' }, { limit: 9999 }]) {
      expect(OwnCobrosQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
