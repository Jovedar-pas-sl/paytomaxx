import { describe, it, expect, vi } from 'vitest';
import { hashPartnerKey } from '../auth/partner-key';
import { PartnerKeyExposureService } from './partner-key-exposure.service';

const KEY = `oxp_live_${'ab12'.repeat(12)}`;
const CONN = {
  id: '11111111-2222-3333-4444-555555555555',
  tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
  keyHint: 'oxp_live_…ab12',
  scopes: ['wallet:balance'],
  partner: { name: 'Cajeros Demo' },
};

function build(opts: { conn?: typeof CONN | null; marked?: number; ipBlocked?: boolean; keyBlocked?: boolean; breaker?: boolean } = {}) {
  const tx = {
    partnerConnection: {
      findFirst: vi.fn(async (_args: Record<string, unknown>) => (opts.conn === undefined ? CONN : opts.conn)),
      updateMany: vi.fn(async (_args: Record<string, unknown>) => ({ count: opts.marked ?? 1 })),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { logInTx: vi.fn(async () => undefined) };
  const limiter = {
    state: vi.fn(async () => ({ keyBlocked: opts.keyBlocked ?? false, known: false, breaker: opts.breaker ?? false, ipBlocked: opts.ipBlocked ?? false })),
    recordFailure: vi.fn(async () => undefined),
  };
  const service = new PartnerKeyExposureService(prisma as never, audit as never, limiter as never);
  return { service, tx, prisma, audit, limiter };
}

describe('una clave en una URL', () => {
  it('si existe (actual o en solape): keyExposedAt y el aviso, en la misma transacción y sin la clave', async () => {
    const s = build();
    await s.service.report(KEY, '203.0.113.9');
    const where = s.tx.partnerConnection.findFirst.mock.calls[0]![0].where as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0]).toEqual({ keyHash: hashPartnerKey(KEY) });
    expect(where.OR[1]).toMatchObject({ prevKeyHash: hashPartnerKey(KEY) });
    expect(s.tx.partnerConnection.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: CONN.id, tenantId: CONN.tenantId, keyExposedAt: null },
    });
    expect(s.audit.logInTx).toHaveBeenCalledWith(s.tx, expect.objectContaining({ action: 'partner.key.exposed', ip: '203.0.113.9' }));
    expect(JSON.stringify(s.audit.logInTx.mock.calls)).not.toContain(KEY);
    expect(s.limiter.recordFailure).not.toHaveBeenCalled();
  });

  it('ya marcada: ni otro registro ni otro aviso', async () => {
    const s = build({ marked: 0 });
    await s.service.report(KEY, '203.0.113.9');
    expect(s.audit.logInTx).not.toHaveBeenCalled();
  });

  it('si no existe, cuenta como un fallo; desde una IP bloqueada no se mira nada', async () => {
    const missing = build({ conn: null });
    await missing.service.report(KEY, '203.0.113.9');
    expect(missing.limiter.recordFailure).toHaveBeenCalledWith(hashPartnerKey(KEY), '203.0.113.9');

    const blocked = build({ ipBlocked: true });
    await blocked.service.report(KEY, '203.0.113.9');
    expect(blocked.prisma.asSystem).not.toHaveBeenCalled();
    expect(blocked.limiter.recordFailure).not.toHaveBeenCalled();
  });

  it('la clave ya bloqueada o el cortacircuitos levantado: ni una consulta a la base ni otro fallo', async () => {
    for (const opts of [{ keyBlocked: true }, { breaker: true }]) {
      const s = build({ conn: null, ...opts });
      await s.service.report(KEY, '203.0.113.9');
      expect(s.prisma.asSystem).not.toHaveBeenCalled();
      expect(s.limiter.recordFailure).not.toHaveBeenCalled();
    }
  });

  it('un aviso atrasado no marca la clave nueva: el UPDATE vuelve a mirar que la presentada sea la actual o la anterior aún válida', async () => {
    const s = build();
    await s.service.report(KEY, '203.0.113.9');
    const where = s.tx.partnerConnection.updateMany.mock.calls[0]![0].where as { OR?: Array<Record<string, unknown>> };
    expect(where.OR?.[0]).toEqual({ keyHash: hashPartnerKey(KEY) });
    expect(where.OR?.[1]).toMatchObject({ prevKeyHash: hashPartnerKey(KEY), prevKeyExpiresAt: { gt: expect.any(Date) } });
  });
});
