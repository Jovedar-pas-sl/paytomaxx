import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { JwtPayload } from '@nightpay/contracts';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { PartnerConnectionsService } from './partner-connections.service';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARTNER = 'bbbbbbbb-0000-0000-0000-000000000001';
const CONN = 'cccccccc-0000-0000-0000-000000000001';
const owner = { sub: 'dddddddd-0000-0000-0000-000000000001', tenantId: TENANT, role: 'OWNER' } as JwtPayload;

type Row = Record<string, unknown>;

/** El where de Prisma que usa el servicio: igualdad, `{ not }` y `{ in }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== (v as { not: unknown }).not;
    if (v && typeof v === 'object' && 'in' in v) return (v as { in: unknown[] }).in.includes(row[k]);
    return row[k] === v;
  });
}

/**
 * Base de mentira con transacciones de verdad: lo que se escribe dentro de
 * withTenant se aplica solo si la transacción acaba bien.
 */
function fakeDb() {
  const state: { connections: Row[] } = {
    connections: [
      {
        id: CONN,
        tenantId: TENANT,
        partnerId: PARTNER,
        businessId: 'eeeeeeee-0000-0000-0000-000000000001',
        status: 'ACTIVE',
        scopes: ['wallet:balance'],
        pausedScopes: [],
        pausedReason: null,
        keyMode: 'test',
        keyHash: 'a'.repeat(64),
        keyHint: 'oxp_test_…aaaa',
        keyCreatedAt: new Date('2026-11-01T10:00:00Z'),
        keyExpiresAt: null,
        prevKeyHash: null,
        prevKeyExpiresAt: null,
        keyExposedAt: null,
        keySuspendedAt: null,
        keyResumedAt: null,
        keyClaimHash: null,
        keyClaimSealed: null,
        keyClaimExpiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        ipAllowlist: [],
        createdAt: new Date('2026-11-01T10:00:00Z'),
        partner: { id: PARTNER, name: 'Cajeros Demo' },
      },
    ],
  };
  const partner = {
    id: PARTNER,
    name: 'Cajeros Demo',
    status: 'ACTIVE',
    allowedScopes: ['wallet:balance', 'wallet:load'],
    egressIps: ['203.0.113.0/24'],
    channel: 'IN_VENUE',
    collectionModel: 'VENUE_COLLECTS',
    contactEmail: 'it@cajeros.example',
    kybCheckedAt: new Date(),
    dataRole: 'PROCESSOR_OF_VENUE',
    dpaSignedAt: new Date(),
    dpaVersion: 'v1',
    dataCountry: 'ES',
    transferMechanism: null,
  };
  const prisma = {
    withTenant: vi.fn(async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) => {
      const draft = structuredClone(state.connections);
      const tx = {
        $queryRaw: vi.fn(async (_q: unknown, id: string) => draft.filter((c) => c.id === id && c.tenantId === TENANT).map((c) => ({ id: c.id }))),
        partner: { findUnique: vi.fn(async ({ where }: { where: Row }) => ({ ...partner, id: where.id })), findMany: vi.fn(async () => [partner]) },
        venue: {
          findUnique: vi.fn(async () => ({ name: 'Local Demo Centro', businessId: 'eeeeeeee-0000-0000-0000-000000000001', business: { name: 'Empresa Demo S.L.', taxId: 'B00000000' } })),
        },
        auditEvent: { findMany: vi.fn(async () => []) },
        partnerConnection: {
          findFirst: vi.fn(async ({ where }: { where: Row }) => draft.find((c) => matches(c, where)) ?? null),
          findMany: vi.fn(async () => draft),
          create: vi.fn(async ({ data }: { data: Row }) => {
            const row = { status: 'ACTIVE', pausedScopes: [], pausedReason: null, ...data, id: 'ffffffff-0000-0000-0000-000000000001', createdAt: new Date(), partner: { id: PARTNER, name: 'Cajeros Demo' } };
            draft.push(row);
            return row;
          }),
          delete: vi.fn(async ({ where }: { where: Row }) => {
            const i = draft.findIndex((c) => c.id === where.id);
            return draft.splice(i, 1)[0];
          }),
          update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
            const row = draft.find((c) => c.id === where.id)!;
            Object.assign(row, data);
            return row;
          }),
        },
      };
      const out = await fn(tx);
      state.connections = draft;
      return out;
    }),
  };
  return { prisma, state };
}

function service(prisma: unknown, audit: unknown, email: unknown = { isEnabled: () => false, send: vi.fn() }) {
  const totp = { assertForUser: vi.fn(async () => undefined) };
  const config = { get: () => undefined };
  return new PartnerConnectionsService(prisma as never, createFakeRedis() as never, audit as never, totp as never, email as never, config as never);
}

beforeEach(() => {
  vi.stubEnv('PARTNER_API_ENABLED', 'true');
  vi.stubEnv('PARTNER_API_MODE', 'test');
  vi.stubEnv('ENCRYPTION_KEK', 'kek-de-prueba-0123456789abcdef0123456789');
});
afterEach(() => vi.unstubAllEnvs());

describe('sin registro no hay cambio', () => {
  const failing = { log: vi.fn(), logInTx: vi.fn(async () => Promise.reject(new Error('audit_events no responde'))) };

  it('conectar: si el registro falla, la conexión no se crea', async () => {
    const { prisma, state } = fakeDb();
    const other = 'bbbbbbbb-0000-0000-0000-000000000002';
    await expect(
      service(prisma, failing).create(owner, { partnerId: other, scopes: ['wallet:balance'], ipAllowlist: [], expiresAt: null, delivery: 'copy' }),
    ).rejects.toThrow(/audit_events/);
    expect(state.connections).toHaveLength(1);
  });

  it('anular, pausar y reanudar: si el registro falla, la conexión sigue como estaba', async () => {
    const { prisma, state } = fakeDb();
    const s = service(prisma, failing);
    await expect(s.revoke(owner, CONN)).rejects.toThrow(/audit_events/);
    await expect(s.pause(owner, CONN)).rejects.toThrow(/audit_events/);
    expect(state.connections[0]).toMatchObject({ status: 'ACTIVE', pausedReason: null });
  });

  it('cambiar la clave: si el registro falla, la clave sigue siendo la misma', async () => {
    const { prisma, state } = fakeDb();
    await expect(service(prisma, failing).rotate(owner, CONN, { overlap: '24h', expiresAt: null, delivery: 'copy' })).rejects.toThrow(
      /audit_events/,
    );
    expect(state.connections[0]).toMatchObject({ keyHash: 'a'.repeat(64), prevKeyHash: null });
  });

  it('con el registro bien, el cambio queda y el registro va en la misma transacción', async () => {
    const { prisma, state } = fakeDb();
    const audit = { log: vi.fn(), logInTx: vi.fn(async () => undefined) };
    await service(prisma, audit).revoke(owner, CONN);
    expect(state.connections[0]).toMatchObject({ status: 'REVOKED' });
    expect(audit.logInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'partner.key.revoked', tenantId: TENANT }));
  });
});

describe('la pausa de OxioPay no se esquiva', () => {
  const audit = { log: vi.fn(), logInTx: vi.fn(async () => undefined) };
  const manager = { ...owner, role: 'MANAGER' } as JwtPayload;
  const connect = { partnerId: PARTNER, scopes: ['wallet:balance'], ipAllowlist: [], expiresAt: null, delivery: 'copy' } as const;

  it('pausada por OxioPay: ni el dueño ni el encargado la anulan', async () => {
    const { prisma, state } = fakeDb();
    Object.assign(state.connections[0]!, { status: 'PAUSED', pausedReason: 'oxiopay' });
    const s = service(prisma, audit);
    for (const who of [owner, manager]) await expect(s.revoke(who, CONN)).rejects.toThrow('La pausó OxioPay: habla con OxioPay.');
    expect(state.connections[0]).toMatchObject({ status: 'PAUSED', pausedReason: 'oxiopay' });
  });

  it('pausada por el dueño: sí la anula', async () => {
    const { prisma, state } = fakeDb();
    Object.assign(state.connections[0]!, { status: 'PAUSED', pausedReason: 'owner' });
    await service(prisma, audit).revoke(owner, CONN);
    expect(state.connections[0]).toMatchObject({ status: 'REVOKED' });
  });

  it('anulada por OxioPay: conectar otra vez con ese socio da 409 y no sale clave', async () => {
    const { prisma, state } = fakeDb();
    Object.assign(state.connections[0]!, { status: 'REVOKED', pausedReason: 'oxiopay' });
    await expect(service(prisma, audit).create(owner, connect)).rejects.toThrow('La pausó OxioPay: habla con OxioPay.');
    expect(state.connections).toHaveLength(1);
  });

  it('anulada por el dueño: conectar otra vez sí vale', async () => {
    const { prisma, state } = fakeDb();
    Object.assign(state.connections[0]!, { status: 'REVOKED', pausedReason: 'owner' });
    const out = await service(prisma, audit).create(owner, connect);
    expect(out.key).toMatch(/^oxp_test_/);
  });
});

describe('por correo: si no sale, no se pierde la clave', () => {
  const audit = () => ({ log: vi.fn(), logInTx: vi.fn(async () => undefined) });
  const failingMail = (how: 'reject' | 'undelivered') => ({
    isEnabled: () => true,
    send: vi.fn(async () => (how === 'reject' ? Promise.reject(new Error('Resend 500')) : { ok: false, delivered: false })),
  });

  it.each(['reject', 'undelivered'] as const)('cambiar sin solape (%s): vuelve la clave de antes, entera', async (how) => {
    const { prisma, state } = fakeDb();
    const before = structuredClone(state.connections[0]!);
    Object.assign(state.connections[0]!, { keyExposedAt: new Date('2026-11-20T10:00:00Z') });
    const a = audit();
    const out = await service(prisma, a, failingMail(how)).rotate(owner, CONN, { overlap: 'none', expiresAt: null, delivery: 'email' });
    expect(out.claim.delivered).toBe(false);
    expect(out.key).toBeUndefined();
    expect(state.connections[0]).toMatchObject({
      keyHash: before.keyHash,
      keyHint: before.keyHint,
      keyCreatedAt: before.keyCreatedAt,
      prevKeyHash: null,
      keyExposedAt: new Date('2026-11-20T10:00:00Z'),
      keyClaimHash: null,
      keyClaimSealed: null,
    });
    expect(out.connection.keyHint).toBe(before.keyHint);
    expect(a.logInTx).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: 'partner.key.issue_undone' }));
  });

  it('la primera conexión: si el correo no sale, no queda conexión (se puede conectar otra vez)', async () => {
    const { prisma, state } = fakeDb();
    state.connections = [];
    const out = await service(prisma, audit(), failingMail('reject')).create(owner, {
      partnerId: PARTNER,
      scopes: ['wallet:balance'],
      ipAllowlist: [],
      expiresAt: null,
      delivery: 'email',
    });
    expect(out.claim.delivered).toBe(false);
    expect(state.connections).toHaveLength(0);
  });

  it('si sale, la clave nueva se queda', async () => {
    const { prisma, state } = fakeDb();
    const mail = { isEnabled: () => true, send: vi.fn(async () => ({ ok: true, delivered: true })) };
    const out = await service(prisma, audit(), mail).rotate(owner, CONN, { overlap: 'none', expiresAt: null, delivery: 'email' });
    expect(out.claim.delivered).toBe(true);
    expect(state.connections[0]!.keyHash).not.toBe('a'.repeat(64));
    expect(state.connections[0]!.keyClaimSealed).toEqual(expect.any(String));
  });
});
