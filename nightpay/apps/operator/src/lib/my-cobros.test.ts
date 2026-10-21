import { expect, it } from 'vitest';
import type { OwnCobro } from '@nightpay/contracts';
import { mergeOwnCobros, ownCobroStatus } from './my-cobros';
const row = (id: string, kind: OwnCobro['kind'], createdAt: string, status = 'AUTHORIZED'): OwnCobro => ({ id, kind, createdAt, status, ref: null, amountCents: 2000, tipCents: 0, methodLabel: kind === 'SALDO' ? 'Saldo' : 'Tarjeta', service: 'Invitar a una copa', via: null, isTopUp: false, invitedName: 'Lola' });
it('actualiza estados sin duplicar páginas y conserva cobros de ambos canales', () => {
  const previous = [row('a', 'PAYMENT', '2026-10-21T20:00:00Z', 'CREATED'), row('older', 'SALDO', '2026-10-20T20:00:00Z')];
  const merged = mergeOwnCobros(previous, [row('a', 'PAYMENT', '2026-10-21T20:00:00Z'), row('a', 'SALDO', '2026-10-21T21:00:00Z', 'ACCEPTED')]);
  expect(merged).toHaveLength(3);
  expect(merged[0]!.kind).toBe('SALDO');
  expect(merged[1]!.status).toBe('AUTHORIZED');
  expect(merged[2]!.id).toBe('older');
  expect(ownCobroStatus('ACCEPTED')).toBe('Cobrado');
  expect(ownCobroStatus('REVERSED')).toBe('Anulado');
});
