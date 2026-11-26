import { describe, it, expect, vi } from 'vitest';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { FOREIGN_IPS_TO_PAUSE, PartnerForeignIpService } from './partner-foreign-ip';

const CONN = {
  id: '11111111-2222-3333-4444-555555555555',
  tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
  keyHint: 'oxp_live_…ab12',
  scopes: ['wallet:balance', 'wallet:load'],
  partner: { name: 'Cajeros Demo' },
};

function build(row: { scopes: string[]; pausedScopes: string[] } | null = { scopes: CONN.scopes, pausedScopes: [] }) {
  const tx = {
    $queryRaw: vi.fn(async () => (row ? [row] : [])),
    partnerConnection: { update: vi.fn(async () => ({})) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async (_entry: Record<string, unknown>) => undefined), logInTx: vi.fn(async () => undefined) };
  const service = new PartnerForeignIpService(createFakeRedis() as never, prisma as never, audit as never);
  return { service, tx, audit, prisma };
}

describe('una clave buena desde una IP ajena', () => {
  it('cada IP nueva avisa una vez en 24 h, con la IP en la columna y sin la clave', async () => {
    const s = build();
    await s.service.record(CONN, '198.51.100.7');
    await s.service.record(CONN, '198.51.100.7');
    expect(s.audit.log).toHaveBeenCalledTimes(1);
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'partner.foreign_ip',
        tenantId: CONN.tenantId,
        ip: '198.51.100.7',
        payload: { connectionId: CONN.id, keyHint: CONN.keyHint, name: 'Cajeros Demo', scopes: CONN.scopes },
      }),
    );
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
  });

  it('IPv6: el mismo /64 cuenta como una IP', async () => {
    const s = build();
    await s.service.record(CONN, '2001:db8:1:2::10');
    await s.service.record(CONN, '2001:db8:1:2::99');
    expect(s.audit.log).toHaveBeenCalledTimes(1);
  });

  it(`a la ${FOREIGN_IPS_TO_PAUSE}.ª, los permisos de dinero en pausa (los demás siguen) y su registro en la transacción; luego, nada`, async () => {
    const s = build({ scopes: ['wallet:balance', 'wallet:load'], pausedScopes: [] });
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4']) await s.service.record(CONN, ip);
    expect(s.audit.log).toHaveBeenCalledTimes(FOREIGN_IPS_TO_PAUSE);
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
    expect(s.tx.partnerConnection.update).toHaveBeenCalledWith({
      where: { id: CONN.id },
      data: { pausedScopes: ['wallet:load'], pausedReason: 'foreign_ip' },
    });
    expect(s.audit.logInTx).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({ action: 'partner.connection.paused', payload: expect.objectContaining({ reason: 'foreign_ip' }) }),
    );
  });

  it('sin permisos de dinero no se pausa nada; sin IP, cuenta como «desconocida»', async () => {
    const s = build();
    const reader = { ...CONN, scopes: ['wallet:balance'] };
    for (const ip of [null, '198.51.100.2', '198.51.100.3']) await s.service.record(reader, ip);
    expect(s.audit.log).toHaveBeenCalledTimes(3);
    expect(s.audit.log.mock.calls[0]![0]).not.toHaveProperty('ip');
    expect(s.prisma.asSystem).not.toHaveBeenCalled();
  });
});
