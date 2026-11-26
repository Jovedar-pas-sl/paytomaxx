import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { JwtPayload } from '@nightpay/contracts';
import { createFakeRedis } from '../../auth/testing/fake-redis';
import { PartnerConnectionsService } from './partner-connections.service';

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const PARTNER = 'bbbbbbbb-0000-0000-0000-000000000001';
const CONN = 'cccccccc-0000-0000-0000-000000000001';
const owner = { sub: 'dddddddd-0000-0000-0000-000000000001', tenantId: TENANT, role: 'OWNER' } as JwtPayload;

type Row = Record<string, unknown>;

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
        $queryRaw: vi.fn(async () => draft.filter((c) => c.id === CONN && c.tenantId === TENANT).map((c) => ({ id: c.id }))),
        partner: { findUnique: vi.fn(async ({ where }: { where: Row }) => ({ ...partner, id: where.id })), findMany: vi.fn(async () => [partner]) },
        venue: {
          findUnique: vi.fn(async () => ({ name: 'Local Demo Centro', businessId: 'eeeeeeee-0000-0000-0000-000000000001', business: { name: 'Empresa Demo S.L.', taxId: 'B00000000' } })),
        },
        auditEvent: { findMany: vi.fn(async () => []) },
        partnerConnection: {
          findFirst: vi.fn(async ({ where }: { where: Row }) =>
            draft.find((c) => (where.id === undefined || c.id === where.id) && c.tenantId === where.tenantId && (where.partnerId === undefined || c.partnerId === where.partnerId) && c.status !== 'REVOKED') ?? null,
          ),
          findMany: vi.fn(async () => draft),
          create: vi.fn(async ({ data }: { data: Row }) => {
            const row = { ...data, id: 'ffffffff-0000-0000-0000-000000000001', createdAt: new Date(), partner: { id: PARTNER, name: 'Cajeros Demo' } };
            draft.push(row);
            return row;
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

function service(prisma: unknown, audit: unknown) {
  const totp = { assertForUser: vi.fn(async () => undefined) };
  const email = { isEnabled: () => false, send: vi.fn() };
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
