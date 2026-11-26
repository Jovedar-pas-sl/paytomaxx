import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { FOREIGN_IPS_TO_PAUSE, PartnerForeignIpService } from './partner-foreign-ip';

const CONN = {
  id: '11111111-2222-3333-4444-555555555555',
  tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
  keyHint: 'oxp_live_…ab12',
  scopes: ['wallet:balance', 'wallet:load'],
  partner: { name: 'Cajeros Demo' },
};

type LockedRow = { status: string; scopes: string[]; pausedScopes: string[] };

function build(row: LockedRow | null = { status: 'ACTIVE', scopes: CONN.scopes, pausedScopes: [] }) {
  const tx = {
    $queryRaw: vi.fn(async () => (row ? [row] : [])),
    partnerConnection: { update: vi.fn(async () => ({})) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async (_entry: Record<string, unknown>) => undefined), logInTx: vi.fn(async () => undefined) };
  const redis = createFakeRedis();
  const service = new PartnerForeignIpService(redis as never, prisma as never, audit as never);
  return { service, tx, audit, prisma, redis };
}

const HOUR = 3_600_000;
afterEach(() => vi.useRealTimers());

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

  it(`a la ${FOREIGN_IPS_TO_PAUSE}.ª, los permisos de dinero en pausa (los demás siguen) y su registro en la transacción; luego, cada IP nueva avisa y la pausa no se repite`, async () => {
    const s = build({ status: 'ACTIVE', scopes: ['wallet:balance', 'wallet:load'], pausedScopes: [] });
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.4']) await s.service.record(CONN, ip);
    // Cada dirección nueva avisa (§3.3 del diseño y el contrato), también la cuarta.
    expect(s.audit.log).toHaveBeenCalledTimes(4);
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
    expect(s.tx.partnerConnection.update).toHaveBeenCalledWith({
      where: { id: CONN.id, tenantId: CONN.tenantId },
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

  it('cuenta las IP de las últimas 24 h (ventana móvil): A a las 00:00, B a las 23:00, C y D al día siguiente → B, C y D pausan', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-12-05T00:00:00Z').getTime();
    const s = build();
    const at = async (ms: number, ip: string) => {
      vi.setSystemTime(new Date(t0 + ms));
      await s.service.record(CONN, ip);
    };
    await at(0, '198.51.100.1');
    await at(23 * HOUR, '198.51.100.2');
    await at(24 * HOUR + 60_000, '198.51.100.3');
    expect(s.tx.partnerConnection.update).not.toHaveBeenCalled();
    await at(24 * HOUR + 120_000, '198.51.100.4');
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
    expect(s.tx.partnerConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: { pausedScopes: ['wallet:load'], pausedReason: 'foreign_ip' } }));
  });

  it('si la transacción de la pausa falla, la pausa queda pendiente: la reintenta la siguiente llamada ajena, aunque sea de una IP ya vista', async () => {
    const s = build();
    s.prisma.asSystem.mockRejectedValueOnce(new Error('could not obtain lock'));
    await s.service.record(CONN, '198.51.100.1');
    await s.service.record(CONN, '198.51.100.2');
    await expect(s.service.record(CONN, '198.51.100.3')).rejects.toThrow('could not obtain lock');
    expect(s.tx.partnerConnection.update).not.toHaveBeenCalled();
    await s.service.record(CONN, '198.51.100.3');
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
    expect(s.audit.log).toHaveBeenCalledTimes(3);
    await s.service.record(CONN, '198.51.100.5');
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
  });

  it('solo pausa una conexión activa (dentro del bloqueo de la fila): una en pausa de OxioPay o anulada no cambia', async () => {
    for (const status of ['PAUSED', 'REVOKED']) {
      const s = build({ status, scopes: ['wallet:balance', 'wallet:load'], pausedScopes: [] });
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await s.service.record(CONN, ip);
      expect(s.tx.$queryRaw).toHaveBeenCalled();
      expect(s.tx.partnerConnection.update, status).not.toHaveBeenCalled();
      expect(s.audit.logInTx, status).not.toHaveBeenCalled();
    }
  });

  it('pausada por OxioPay mientras llegan las IP ajenas: al reanudarla, la pausa pendiente se aplica con la siguiente llamada ajena', async () => {
    const row: LockedRow = { status: 'PAUSED', scopes: ['wallet:balance', 'wallet:load'], pausedScopes: [] };
    const s = build(row);
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await s.service.record(CONN, ip);
    expect(s.tx.partnerConnection.update).not.toHaveBeenCalled();
    row.status = 'ACTIVE';
    await s.service.record(CONN, '198.51.100.3');
    expect(s.tx.partnerConnection.update).toHaveBeenCalledTimes(1);
  });
});
