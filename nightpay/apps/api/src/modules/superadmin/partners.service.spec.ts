import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createFakeRedis } from '../auth/testing/fake-redis';
import { SuperAdminPartnersService } from './partners.service';

const actor = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'super@oxiopay.es' };
const NOW = new Date('2026-12-05T10:00:00Z');

function partnerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    name: 'Cajeros',
    legalName: 'Cajeros S.L.',
    taxId: 'B12345678',
    contactEmail: 'it@cajeros.es',
    status: 'ACTIVE',
    allowedScopes: ['wallet:balance'],
    collectionModel: 'VENUE_COLLECTS',
    channel: 'IN_VENUE',
    egressIps: ['203.0.113.7'],
    egressRangeReason: null,
    kybCheckedAt: null,
    kybNotes: null,
    dataRole: null,
    dpaSignedAt: null,
    dpaVersion: null,
    dataCountry: null,
    transferMechanism: null,
    notes: null,
    createdById: actor.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** Como Prisma: las fechas vuelven como Date. */
const asStored = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' && /At$/.test(k) ? new Date(v) : v]));

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'dddddddd-0000-0000-0000-000000000001',
    tenantId: 'eeeeeeee-0000-0000-0000-000000000001',
    partnerId: partnerRow().id,
    status: 'ACTIVE',
    scopes: ['wallet:balance', 'wallet:load'],
    pausedScopes: [],
    pausedReason: null,
    keyMode: 'live',
    keyHash: 'a'.repeat(64),
    keyHint: 'oxp_live_…ab12',
    keyCreatedAt: NOW,
    keyExpiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
    prevKeyHash: null,
    prevKeyExpiresAt: null,
    keyExposedAt: null,
    keySuspendedAt: null,
    keyResumedAt: null,
    keyClaimHash: 'b'.repeat(64),
    keyClaimSealed: 'sellada',
    keyClaimExpiresAt: NOW,
    lastUsedAt: null,
    lastUsedIp: null,
    ipAllowlist: ['203.0.113.7'],
    createdAt: NOW,
    partner: { name: 'Cajeros' },
    venue: { name: 'Sala Centro' },
    ...over,
  };
}

function build(redis = createFakeRedis(), locked: { id: string; tenantId: string; status: string } | null = {
  id: connectionRow().id,
  tenantId: connectionRow().tenantId,
  status: 'ACTIVE',
}) {
  const tx = {
    partner: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => partnerRow(asStored(data))),
      findUnique: vi.fn(async () => partnerRow()),
      findMany: vi.fn(async () => [partnerRow()]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => partnerRow(asStored(data))),
    },
    partnerConnection: {
      findMany: vi.fn(async () => [connectionRow()]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => connectionRow(data)),
    },
    partnerApiState: {
      findUnique: vi.fn(async () => ({ id: 1, freeze: 'none', reason: null, updatedAt: NOW })),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => ({ id: 1, updatedAt: NOW, ...update })),
    },
    $queryRaw: vi.fn(async () => (locked ? [locked] : [])),
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const stepUp = { verify: vi.fn(async () => undefined) };
  const audit = { logInTx: vi.fn(async () => undefined) };
  const saAudit = { writeInTx: vi.fn(async () => undefined) };
  const service = new SuperAdminPartnersService(prisma as never, redis as never, audit as never, stepUp as never, saAudit as never);
  return { service, tx, stepUp, audit, saAudit, redis };
}

const create = {
  name: 'Cajeros',
  legalName: 'Cajeros S.L.',
  taxId: 'B12345678',
  contactEmail: 'it@cajeros.es',
  allowedScopes: ['wallet:balance' as const],
  channel: 'in_venue' as const,
  egressIps: ['203.0.113.7'],
  totpCode: '123456',
};

describe('consola: socios', () => {
  it('el alta pide la 2FA, guarda «el local cobra» y deja el registro (tapado) en la misma transacción', async () => {
    const s = build();
    const view = await s.service.create(actor, create);
    expect(s.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'partner.create');
    expect(s.tx.partner.create).toHaveBeenCalledWith({ data: expect.objectContaining({ channel: 'IN_VENUE', createdById: actor.id }) });
    expect(s.tx.partner.create.mock.calls[0]![0].data).not.toHaveProperty('collectionModel');
    expect(view).toMatchObject({ collectionModel: 'VENUE_COLLECTS', ready: false });
    expect(s.saAudit.writeInTx).toHaveBeenCalledWith(s.tx, actor, expect.objectContaining({ action: 'partner.created' }));
  });

  it('IP declaradas: un rango sin motivo, una interna o un /16, no; fuera del EEE, el mecanismo de transferencia', async () => {
    const s = build();
    await expect(s.service.create(actor, { ...create, egressIps: ['203.0.113.0/24'] })).rejects.toThrow(/necesita el motivo/);
    await expect(s.service.create(actor, { ...create, egressIps: ['203.0.113.0/24'], egressRangeReason: 'Su red de salida' })).resolves.toBeDefined();
    await expect(s.service.create(actor, { ...create, egressIps: ['10.0.0.0/24'], egressRangeReason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.create(actor, { ...create, egressIps: ['203.0.0.0/16'], egressRangeReason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.service.create(actor, { ...create, dataCountry: 'US' })).rejects.toThrow(/mecanismo de transferencia/);
  });

  it('editar pide la 2FA solo si cambian permisos, IP, KYB o el contrato de datos', async () => {
    const s = build();
    await s.service.update(actor, partnerRow().id, { notes: 'Llamar el lunes' });
    expect(s.stepUp.verify).not.toHaveBeenCalled();
    await s.service.update(actor, partnerRow().id, { allowedScopes: ['wallet:balance', 'wallet:load'], totpCode: '123456' });
    await s.service.update(actor, partnerRow().id, { dpaSignedAt: NOW.toISOString(), totpCode: '123456' });
    expect(s.stepUp.verify).toHaveBeenCalledTimes(2);
  });

  it('suspender: 2FA y motivo, con su registro', async () => {
    const s = build();
    const view = await s.service.suspend(actor, partnerRow().id, { totpCode: '123456', reason: 'Impago del contrato' });
    expect(s.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'partner.suspend');
    expect(view.status).toBe('SUSPENDED');
    expect(s.saAudit.writeInTx).toHaveBeenCalledWith(s.tx, actor, expect.objectContaining({ action: 'partner.suspended', reason: 'Impago del contrato' }));
  });
});

describe('consola: las conexiones de todos los locales', () => {
  // El servicio mira la hora (dormida, caducada): la de las filas de prueba.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('el resumen: socios, conexiones con su local y solo la pista (sin hashes ni enlace) y la congelación', async () => {
    const s = build();
    const overview = await s.service.overview();
    expect(overview.partners).toHaveLength(1);
    expect(overview.connections[0]).toMatchObject({ venueName: 'Sala Centro', tenantId: connectionRow().tenantId, keyHint: 'oxp_live_…ab12' });
    expect(JSON.stringify(overview)).not.toMatch(/keyHash|keyClaim|sellada|a{64}|b{64}/);
    expect(overview.api).toMatchObject({ enabled: false, freeze: 'none' });
  });

  it('pausar: sin 2FA, con motivo; queda «pausada por OxioPay» y el registro va al local de la conexión', async () => {
    const s = build();
    const view = await s.service.pauseConnection(actor, connectionRow().id, { reason: 'Revisión de seguridad' });
    expect(s.stepUp.verify).not.toHaveBeenCalled();
    expect(s.tx.partnerConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: connectionRow().id, tenantId: connectionRow().tenantId }, data: { status: 'PAUSED', pausedReason: 'oxiopay' } }),
    );
    expect(view).toMatchObject({ state: 'paused', pausedBy: 'oxiopay', venueName: 'Sala Centro' });
    expect(s.audit.logInTx).toHaveBeenCalledWith(
      s.tx,
      expect.objectContaining({ action: 'partner.connection.paused', tenantId: connectionRow().tenantId, payload: expect.objectContaining({ by: 'oxiopay' }) }),
    );
    expect(s.saAudit.writeInTx).toHaveBeenCalledWith(s.tx, actor, expect.objectContaining({ action: 'partner_connection.paused', reason: 'Revisión de seguridad' }));
  });

  it('reanudar pide la 2FA y quita la pausa, los permisos en pausa y la dormida', async () => {
    const s = build();
    await s.service.resumeConnection(actor, connectionRow().id, { totpCode: '123456' });
    expect(s.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'partner.connection.resume');
    expect(s.tx.partnerConnection.update.mock.calls[0]![0].data).toMatchObject({ status: 'ACTIVE', pausedScopes: [], pausedReason: null, keySuspendedAt: null });
  });

  it('anular pide 2FA y motivo y borra el enlace pendiente; una anulada no se pausa ni se reanuda', async () => {
    const s = build();
    await s.service.revokeConnection(actor, connectionRow().id, { totpCode: '123456', reason: 'Clave filtrada' });
    expect(s.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'partner.connection.revoke');
    expect(s.tx.partnerConnection.update.mock.calls[0]![0].data).toEqual({ status: 'REVOKED', keyClaimHash: null, keyClaimSealed: null, keyClaimExpiresAt: null });

    const revoked = build(createFakeRedis(), { id: connectionRow().id, tenantId: connectionRow().tenantId, status: 'REVOKED' });
    await expect(revoked.service.pauseConnection(actor, connectionRow().id, { reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
    await expect(revoked.service.resumeConnection(actor, connectionRow().id, { totpCode: '123456' })).rejects.toBeInstanceOf(ConflictException);
    expect(revoked.tx.partnerConnection.update).not.toHaveBeenCalled();
  });

  it('una que no existe: 404, sin registro', async () => {
    const s = build(createFakeRedis(), null);
    await expect(s.service.pauseConnection(actor, connectionRow().id, { reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    expect(s.audit.logInTx).not.toHaveBeenCalled();
  });

  it('reanudar un socio suspendido pide la 2FA', async () => {
    const s = build();
    await s.service.resume(actor, partnerRow().id, { totpCode: '123456' });
    expect(s.stepUp.verify).toHaveBeenCalledWith(actor, '123456', 'partner.resume');
    expect(s.saAudit.writeInTx).toHaveBeenCalledWith(s.tx, actor, expect.objectContaining({ action: 'partner.resumed' }));
  });
});

describe('consola: congelar la API', () => {
  it('la fila y su registro y, tras confirmar, la copia de Redis (60 s): vale ya en todas las réplicas', async () => {
    const s = build();
    const state = await s.service.setApiState(actor, { freeze: 'money', reason: 'Incidente en cajeros', totpCode: '123456' });
    expect(state.freeze).toBe('money');
    expect(await s.redis.get('np:partner-api:freeze')).toBe('money');
    expect(await s.redis.ttl('np:partner-api:freeze')).toBeLessThanOrEqual(60);
    expect(s.audit.logInTx).toHaveBeenCalledWith(s.tx, expect.objectContaining({ action: 'partner.api_frozen', payload: expect.objectContaining({ freeze: 'money', before: 'none' }) }));
    await s.service.setApiState(actor, { freeze: 'none', reason: 'Resuelto', totpCode: '123456' });
    expect(s.audit.logInTx).toHaveBeenLastCalledWith(s.tx, expect.objectContaining({ action: 'partner.api_unfrozen' }));
  });

  it('sin Redis: 503 (la fila ya cambió y la copia caduca en 60 s)', async () => {
    const redis = createFakeRedis();
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('Connection is closed.'));
    const s = build(redis);
    await expect(s.service.setApiState(actor, { freeze: 'all', reason: 'Incidente', totpCode: '123456' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(s.tx.partnerApiState.upsert).toHaveBeenCalled();
  });
});
