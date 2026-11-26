import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { OperatorsService } from './operators.service';
import { openPayoutValue, sealPayoutValue } from './payout-account-crypto';

process.env.ENCRYPTION_KEK ??= 'clave-de-pruebas-de-la-cuenta-de-cobro-0123456789';
const IBAN = 'ES9121000418450200051332';
/** Lo guardado (cifrado) en claro, como lo abre el API. */
const opened = (stored: unknown, field: 'address' | 'holder' = 'address') =>
  openPayoutValue(String(stored), { userId: 'op-1', field });

const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const EVM = '0x55d398326f99059ff775485246999027b3197955';
/** El enlace de la chica (lo que firma jwt.signAsync en makeOps) y lo que guarda la base de él. */
const TOKEN = 'header.payload.signature-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

const baseOperator = {
  id: 'op-1',
  tenantId: 't-1',
  email: 'chica@example.com',
  displayName: 'Ana',
  role: 'OPERATOR',
  commissionBps: null as number | null,
  deletedAt: null as Date | null,
  invitedAt: null as Date | null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  payoutMethod: null as string | null,
  payoutAddress: null as string | null,
  payoutLabel: null as string | null,
  payoutMetadata: null as unknown,
  payoutAddressMasked: null as string | null,
  payoutHolderMasked: null as string | null,
  payoutAccountChangedAt: null as Date | null,
  payoutHoldUntil: null as Date | null,
  payoutNoticeSeenAt: null as Date | null,
  onboardingStatus: 'NEW',
};

interface MakeOptions {
  operator?: Partial<typeof baseOperator> | null;
  /** Payload que devuelve verifyAsync (token del enlace de la chica). */
  tokenPayload?: Record<string, unknown>;
}

function makeOps(opts: MakeOptions = {}) {
  const operator = opts.operator === null ? null : { ...baseOperator, ...(opts.operator ?? {}) };
  /** Si cada user.update corrió dentro de asSystem (rutas públicas sin local). */
  const updateInSystem: boolean[] = [];
  let inSystem = false;
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(operator),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        updateInSystem.push(inSystem);
        return { ...operator, ...data };
      }),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...baseOperator,
        invitedAt: new Date(),
        ...data,
      })),
    },
    venue: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Local', operatorCommissionDefaults: { CHICA_SERVICE: 9000 } }),
      // Días de espera del local: null = PAYOUT_HOLD_DAYS.
      findUnique: vi.fn().mockResolvedValue({ payoutHoldDays: null }),
    },
    // Su ficha NFC (cobro por el encargado, fase 2): sin ficha viva.
    staffCard: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
  };
  Object.assign(prisma, {
    asSystem: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      inSystem = true;
      try {
        return await fn(prisma);
      } finally {
        inSystem = false;
      }
    }),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    withTenant: vi.fn().mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma)),
  });
  const email = { send: vi.fn().mockResolvedValue({ delivered: false }), isEnabled: () => false };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const config = {
    get: vi.fn((key: string) => (key === 'OPERATOR_BASE_URL' ? 'https://chicas.example.com' : undefined)),
  };
  const jwt = {
    signAsync: vi.fn().mockResolvedValue('header.payload.signature-token'),
    verifyAsync: vi.fn().mockResolvedValue(
      opts.tokenPayload ?? { sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding', payout: true },
    ),
  };
  const fx = { getEurToUsdtRateInfo: vi.fn().mockResolvedValue({ rate: 1.07, degraded: false }) };
  const sessions = { revokeAllForUser: vi.fn(async (_userId: string) => 2) };
  const svc = new OperatorsService(
    prisma as never,
    email as never,
    audit as never,
    config as never,
    jwt as never,
    fx as never,
    sessions as never,
  );
  return { svc, prisma, audit, jwt, email, updateInSystem, sessions };
}

describe('OperatorsService.updateOperator — dar de baja corta sus sesiones al momento', () => {
  beforeEach(() => vi.clearAllMocks());

  it('baja con dinero sin cobrar: queda para Incidencias, con el importe y su nombre', async () => {
    const { svc, audit } = makeOps();
    vi.spyOn(svc, 'getBalance').mockResolvedValue({ pendingCents: 12_000 } as never);
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { active: false });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.left_with_balance', targetId: 'op-1', payload: expect.objectContaining({ amountCents: 12_000 }) }),
    );
  });

  it('sin nada que cobrar no avisa, y un fallo al mirarlo no deshace la baja', async () => {
    const { svc, audit, sessions } = makeOps();
    vi.spyOn(svc, 'getBalance').mockResolvedValueOnce({ pendingCents: 0 } as never);
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { active: false });
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'operator.left_with_balance' }));
    vi.spyOn(svc, 'getBalance').mockRejectedValueOnce(new Error('BD caída'));
    await expect(svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { active: false })).resolves.toBeDefined();
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(2);
  });

  it('active=false → se guarda la baja y se cierran todas sus sesiones (refresh y tokens de acceso)', async () => {
    const { svc, prisma, sessions } = makeOps();
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { active: false });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('op-1');
    expect(prisma.user.update.mock.invocationCallOrder[0]!).toBeLessThan(
      sessions.revokeAllForUser.mock.invocationCallOrder[0]!,
    );
  });

  it('otros cambios (o volver a darla de alta) no tocan sus sesiones', async () => {
    const { svc, sessions } = makeOps();
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { displayName: 'Ana B.' });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { active: true });
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('OperatorsService.updateOperator — dirección de cobro válida para su método', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dirección que no es del método guardado → 400 y no se guarda', async () => {
    const { svc, prisma } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    await expect(svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutAddress: EVM })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('cambiar solo el método dejando una dirección de otro método → 400', async () => {
    const { svc } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    await expect(
      svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutMethod: 'USDT_BEP20' }),
    ).rejects.toThrow(/0x/);
  });

  it('válida → se guarda normalizada (IBAN en mayúsculas y sin espacios), cifrada y tapada aparte', async () => {
    const { svc, prisma } = makeOps();
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', {
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: ' es91 2100 0418 4502 0005 1332 ',
      payoutMetadata: { accountHolder: ' Ana López ' },
    });
    const data = prisma.user.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'A••• L•••' });
    expect(opened(data.payoutAddress)).toBe(IBAN);
    expect(opened((data.payoutMetadata as { accountHolder: string }).accountHolder, 'holder')).toBe('Ana López');
    expect(JSON.stringify(data)).not.toContain(IBAN);
    expect(JSON.stringify(data)).not.toContain('López');
  });

  it('IBAN SEPA sin titular → 400 y no se guarda', async () => {
    const { svc, prisma } = makeOps();
    await expect(
      svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN }),
    ).rejects.toThrow('Falta el titular de la cuenta');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('cambios que no tocan el cobro no revalidan lo guardado', async () => {
    const { svc, prisma, audit } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: 'vieja-mal' } });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { displayName: 'Ana B.' });
    expect(prisma.user.update).toHaveBeenCalled();
    expect(audit.log.mock.calls.map(([e]) => e.action)).toEqual(['operator.updated']);
  });

  it('cambiar la cuenta de cobro queda en el registro con la de antes, todo tapado; el código 2FA no se apunta', async () => {
    const { svc, audit, email } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON, payoutLabel: 'Binance' } });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', {
      payoutMethod: 'USDT_BEP20',
      payoutAddress: EVM,
      totpCode: '123456',
    });
    const updated = audit.log.mock.calls.find(([e]) => e.action === 'operator.updated')![0];
    expect(updated.payload.changes).toEqual({ payoutMethod: 'USDT_BEP20', payoutAddress: '0x…7955' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.payout_account_changed',
        tenantId: 't-1',
        actorId: 'u-owner',
        targetId: 'op-1',
        payload: expect.objectContaining({
          via: 'panel',
          name: 'Ana',
          before: { payoutMethod: 'USDT_TRC20', payoutAddress: 'T…uFiV', payoutHolder: null, payoutLabel: 'Binance' },
          after: { payoutMethod: 'USDT_BEP20', payoutAddress: '0x…7955', payoutHolder: null, payoutLabel: 'Binance' },
        }),
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(EVM);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(TRON);
    // A ella, un correo (con la cuenta tapada).
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'chica@example.com' }));
    expect(JSON.stringify(email.send.mock.calls)).not.toContain(EVM);
  });

  it('solo el alias: ni aviso ni correo (no cambia a dónde va el dinero)', async () => {
    const { svc, audit, email } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutLabel: 'Mi Binance' });
    expect(audit.log.mock.calls.map(([e]) => e.action)).toEqual(['operator.updated']);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('transferencia internacional: cambiar solo el SWIFT (misma cuenta y titular) también avisa, espera 48 h y deja en el registro el banco de antes', async () => {
    const wire = {
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutAddress: 'GE29NB0000000101904917',
      payoutMetadata: { country: 'Georgia', bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Ana Beridze' },
    };
    const { svc, prisma, audit, email } = makeOps({ operator: wire });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', {
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'BAGAGE22', country: 'Georgia', accountHolder: 'Ana Beridze' },
    });
    const data = prisma.user.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.payoutHoldUntil).toBeInstanceOf(Date);
    expect(data.payoutAccountChangedAt).toBeInstanceOf(Date);
    const changed = audit.log.mock.calls.find(([e]) => e.action === 'operator.payout_account_changed')![0];
    expect(changed.payload).toMatchObject({
      before: { payoutAddress: 'GE29 •••• •••• 4917', payoutBank: { swiftBic: 'TBCBGE22' } },
      after: { payoutAddress: 'GE29 •••• •••• 4917', payoutBank: { swiftBic: 'BAGAGE22' } },
      holdUntil: (data.payoutHoldUntil as Date).toISOString(),
    });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'chica@example.com' }));
  });

  it('la cuenta se guarda solo si sigue como se leyó: si cambió por otro lado a la vez, 409 y ni registro ni correo', async () => {
    const changedAt = new Date('2026-10-01T10:00:00Z');
    const { svc, prisma, audit, email } = makeOps({
      operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON, payoutAccountChangedAt: changedAt },
    });
    const change = { payoutMethod: 'USDT_BEP20' as const, payoutAddress: EVM };
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', change);
    expect(prisma.user.update.mock.calls[0]![0].where).toEqual({
      id: 'op-1',
      payoutAccountChangedAt: { gte: changedAt, lt: new Date('2026-10-01T10:00:00.001Z') },
    });

    // Otro cambio entró entre leerla y guardarla: la fila ya no está «como se leyó» (P2025).
    vi.clearAllMocks();
    prisma.user.update.mockRejectedValueOnce(Object.assign(new Error('Record to update not found'), { code: 'P2025' }));
    const err = await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', change).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/acaba de cambiar por otro lado/);
    expect(audit.log).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('la primera cuenta: solo si sigue sin ninguna (dos «primeras» a la vez no se saltan la espera)', async () => {
    const { svc, prisma } = makeOps();
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    expect(prisma.user.update.mock.calls[0]![0].where).toEqual({ id: 'op-1', payoutAccountChangedAt: null });
  });

  it('un fallo de la base que no es ese (o sin tocar la cuenta) sale tal cual', async () => {
    const { svc, prisma } = makeOps();
    const gone = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    prisma.user.update.mockRejectedValueOnce(gone);
    await expect(svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { displayName: 'Ana B.' })).rejects.toBe(gone);
    const down = new Error('base caída');
    prisma.user.update.mockRejectedValueOnce(down);
    await expect(
      svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON }),
    ).rejects.toBe(down);
  });
});

describe('OperatorsService.submitSelfOnboarding — la chica pone su cuenta de cobro', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dirección que no es del método → 400 y el enlace sigue valiendo', async () => {
    const { svc, prisma } = makeOps();
    await expect(
      svc.submitSelfOnboarding('header.payload.signature-token', { payoutMethod: 'USDT_TRC20', payoutAddress: EVM }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('ruta pública: se guarda con asSystem (sin local en el contexto)', async () => {
    const { svc, updateInSystem } = makeOps();
    await svc.submitSelfOnboarding('header.payload.signature-token', { phone: '600000000' });
    expect(updateInSystem).toEqual([true]);
  });

  it('válida → se guarda normalizada, cifrada y tapada; aviso (por el enlace) y correo', async () => {
    const { svc, prisma, audit, email } = makeOps();
    await svc.submitSelfOnboarding('header.payload.signature-token', {
      payoutMethod: 'USDT_TRC20',
      payoutAddress: ` ${TRON} `,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'op-1', selfOnboardingToken: TOKEN_HASH },
      data: expect.objectContaining({ payoutMethod: 'USDT_TRC20', payoutAddressMasked: 'T…uFiV' }),
    });
    expect(opened(prisma.user.update.mock.calls[0]![0].data.payoutAddress)).toBe(TRON);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.payout_account_changed', actorId: 'op-1', payload: expect.objectContaining({ via: 'enlace' }) }),
    );
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'chica@example.com' }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(TRON);
  });

  it('IBAN SEPA sin titular → 400', async () => {
    const { svc, prisma } = makeOps();
    await expect(svc.submitSelfOnboarding(TOKEN, { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN })).rejects.toThrow(
      'Falta el titular de la cuenta',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('transferencia internacional: IBAN junto y los datos del banco, limpios', async () => {
    const { svc, prisma } = makeOps();
    await svc.submitSelfOnboarding(TOKEN, {
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutAddress: ' ge29 nb00 0000 0101 9049 17 ',
      payoutMetadata: { bankName: ' TBC Bank ', swiftBic: 'tbcb ge22', country: '', accountHolder: ' Camila Pérez ' },
    });
    const data = prisma.user.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      payoutMethod: 'WIRE_INTERNATIONAL',
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22' },
      payoutHolderMasked: 'C••• P•••',
    });
    expect(opened(data.payoutAddress)).toBe('GE29NB0000000101904917');
    expect(opened(data.payoutMetadata.accountHolder, 'holder')).toBe('Camila Pérez');
  });

  it('otros métodos no guardan datos de banco; si no se aplica la cuenta, van en la propuesta', async () => {
    const plain = makeOps();
    await plain.svc.submitSelfOnboarding(TOKEN, { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    expect(plain.prisma.user.update.mock.calls[0]![0].data).not.toHaveProperty('payoutMetadata');
    const manager = makeOps({ tokenPayload: { sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding', payout: false } });
    const meta = { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Camila' };
    await manager.svc.submitSelfOnboarding(TOKEN, { payoutMethod: 'WIRE_INTERNATIONAL', payoutAddress: '0012345678', payoutMetadata: meta });
    expect(manager.prisma.user.update.mock.calls[0]![0].data).not.toHaveProperty('payoutMetadata');
    expect(manager.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          proposedPayout: expect.objectContaining({ metadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'C•••' } }),
        }),
      }),
    );
    // La propuesta va tapada: nunca la cuenta entera en el registro.
    expect(JSON.stringify(manager.audit.log.mock.calls)).not.toContain('0012345678');
  });
});

describe('Enlace de la chica — un solo uso, y un reintento con la respuesta perdida sabe que ya se guardó', () => {
  beforeEach(() => vi.clearAllMocks());

  /** La base: el enlace activo (hash) o ya usado (used:hash); cualquier otro, nada. */
  function withToken(stored: string | null) {
    const made = makeOps();
    made.prisma.user.findFirst.mockImplementation(async ({ where }: { where: { selfOnboardingToken?: string } }) =>
      where.selfOnboardingToken !== undefined && where.selfOnboardingToken === stored ? { ...baseOperator, selfOnboardingToken: stored } : null,
    );
    return made;
  }

  it('al guardar, el enlace queda usado (no se borra): solo si sigue siendo el activo', async () => {
    const { svc, prisma } = withToken(TOKEN_HASH);
    await expect(svc.submitSelfOnboarding(TOKEN, { phone: '600000000' })).resolves.toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'op-1', selfOnboardingToken: TOKEN_HASH },
      data: expect.objectContaining({ phone: '600000000', selfOnboardingToken: `used:${TOKEN_HASH}` }),
    });
  });

  it('el mismo enlace otra vez (la respuesta se perdió y reintenta, o lo vuelve a abrir): 409 «ya se guardó», nada nuevo', async () => {
    const { svc, prisma } = withToken(`used:${TOKEN_HASH}`);
    const attempts = [() => svc.submitSelfOnboarding(TOKEN, { phone: '611111111' }), () => svc.getSelfOnboardingProfile(TOKEN)];
    for (const attempt of attempts) {
      const err = await attempt().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'SELF_ONBOARDING_ALREADY_SAVED',
        message: expect.stringMatching(/ya se guardaron.*enlace nuevo/),
      });
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('un enlace que ya no es el de la chica (el admin hizo otro) sigue siendo inválido: 401', async () => {
    const { svc } = withToken('otro-hash');
    await expect(svc.submitSelfOnboarding(TOKEN, { phone: '600000000' })).rejects.toThrow(UnauthorizedException);
    await expect(svc.getSelfOnboardingProfile(TOKEN)).rejects.toThrow(UnauthorizedException);
  });

  it('dos «Guardar» a la vez con el mismo enlace: si el otro ganó, este dice «ya se guardó» (no lo guarda dos veces)', async () => {
    const { svc, prisma } = withToken(TOKEN_HASH);
    prisma.user.update.mockImplementationOnce(async () => {
      // Entre medias, el otro guardó: el enlace ya está usado.
      prisma.user.findFirst.mockImplementation(async ({ where }: { where: { selfOnboardingToken?: string } }) =>
        where.selfOnboardingToken === `used:${TOKEN_HASH}` ? { ...baseOperator } : null,
      );
      throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' });
    });
    const err = await svc.submitSelfOnboarding(TOKEN, { phone: '600000000' }).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'SELF_ONBOARDING_ALREADY_SAVED' });
  });
});

describe('OperatorsService.createPayout — un hash on-chain no se apunta en dos pagos', () => {
  beforeEach(() => vi.clearAllMocks());

  function withPayoutDb(opts: { other?: { id: string; createdAt: Date } | null; createError?: Error } = {}) {
    const made = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    const prisma = made.prisma as unknown as Record<string, unknown>;
    Object.assign(prisma, {
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray) =>
        strings.join('?').includes('earning_reversals')
          ? []
          : [{ id: 'e-1', commissionCents: 9000, tipCents: 0, reversedCents: 0 }],
      ),
      $executeRaw: vi.fn().mockResolvedValue(1),
      operatorPayout: {
        findFirst: vi.fn().mockResolvedValue(opts.other ?? null),
        create: opts.createError
          ? vi.fn().mockRejectedValue(opts.createError)
          : vi.fn().mockResolvedValue({ id: 'po-1', totalCents: 9000, createdAt: new Date() }),
      },
    });
    return { ...made, payouts: prisma.operatorPayout as { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } };
  }

  it('el hash ya está en otro pago del local → 409 sin crear nada', async () => {
    const { svc, payouts } = withPayoutDb({ other: { id: 'po-0', createdAt: new Date('2026-10-01T00:00:00Z') } });
    await expect(
      svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalTxId: 'abcd1234', externalRail: 'USDT_TRC20' }),
    ).rejects.toThrow(/ya está apuntado en otro pago/);
    expect(payouts.create).not.toHaveBeenCalled();
  });

  it('a la vez (índice único, P2002) → 409', async () => {
    const { svc } = withPayoutDb({ createError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) });
    await expect(
      svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalTxId: 'abcd1234', externalRail: 'USDT_TRC20' }),
    ).rejects.toThrow(/ya está apuntado en otro pago/);
  });

  it('referencia de un método manual: no se cruza', async () => {
    const { svc, payouts } = withPayoutDb({ other: { id: 'po-0', createdAt: new Date() } });
    await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalTxId: 'EFECTIVO', externalRail: 'MANUAL_CASH' });
    expect(payouts.findFirst).not.toHaveBeenCalled();
    expect(payouts.create).toHaveBeenCalled();
  });

  it('se apunta con el local en la sesión (RLS forzado en comisiones y pagos)', async () => {
    const { svc, prisma } = withPayoutDb();
    await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalTxId: 'EFECTIVO', externalRail: 'MANUAL_CASH' });
    const { withTenant } = prisma as unknown as { withTenant: ReturnType<typeof vi.fn> };
    expect(withTenant).toHaveBeenCalledWith('t-1', expect.any(Function));
  });
});

describe('OperatorsService — días de espera del local (pago al cierre de la noche)', () => {
  beforeEach(() => vi.clearAllMocks());

  /** El corte (fecha) que llega a la consulta de comisiones pendientes. */
  function cutoffOf(queryRaw: ReturnType<typeof vi.fn>): Date {
    const call = queryRaw.mock.calls.find(([strings]) => (strings as string[]).join('?').includes('"createdAt" <='));
    return (call!.slice(1) as unknown[]).find((v): v is Date => v instanceof Date)!;
  }

  function withVenueHoldDays(payoutHoldDays: number | null) {
    const made = makeOps({ operator: { payoutMethod: 'MANUAL_CASH' } });
    const prisma = made.prisma as unknown as Record<string, unknown> & { venue: { findUnique: ReturnType<typeof vi.fn> } };
    prisma.venue.findUnique.mockResolvedValue({ payoutHoldDays });
    const queryRaw = vi.fn().mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('earning_reversals') ? [] : [{ id: 'e-1', commissionCents: 9000, tipCents: 0, reversedCents: 0 }],
    );
    Object.assign(prisma, {
      $queryRaw: queryRaw,
      $executeRaw: vi.fn().mockResolvedValue(1),
      operatorPayout: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'po-1', totalCents: 9000, createdAt: new Date() }),
      },
    });
    return { ...made, queryRaw };
  }

  describe('con el reloj fijo (corte exacto)', () => {
    const NOW = new Date('2026-10-17T06:00:00Z');
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('el local con 0 días: se paga todo lo de la noche (corte = ahora), sin mirar PAYOUT_HOLD_DAYS', async () => {
      const { svc, queryRaw } = withVenueHoldDays(0);
      await svc.createPayout('t-1', 'op-1', 'u-owner');
      expect(cutoffOf(queryRaw)).toEqual(NOW);
    });

    it('sin regla del local (null): PAYOUT_HOLD_DAYS (7 por defecto)', async () => {
      const { svc, queryRaw } = withVenueHoldDays(null);
      await svc.createPayout('t-1', 'op-1', 'u-owner');
      expect(cutoffOf(queryRaw)).toEqual(new Date('2026-10-10T06:00:00Z'));
    });
  });

  it('0 días y nada pendiente: el aviso no habla de "más de 0 días"', async () => {
    const { svc, queryRaw } = withVenueHoldDays(0);
    queryRaw.mockResolvedValue([]);
    const err = await svc.createPayout('t-1', 'op-1', 'u-owner').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/comisiones pendientes/);
    expect((err as Error).message).not.toMatch(/0 días/);
  });
});

describe('OperatorsService.createOperator — la comisión la fija el dueño', () => {
  beforeEach(() => vi.clearAllMocks());
  const dto = { email: 'Nueva@Example.com', displayName: 'Nueva', commissionBps: 10_000 };

  it('encargado: la comisión que mande se ignora (se aplica la del local) y se le dice; el enlace de invitación sigue', async () => {
    const { svc, prisma, audit } = makeOps({ operator: null });
    const res = await svc.createOperator('t-1', 'u-manager', dto, 'MANAGER');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ commissionBps: null, role: 'OPERATOR' }),
    });
    expect(res.inviteUrl).toMatch(/^https:\/\/chicas\.example\.com\/accept-invite\?token=/);
    expect(res.notice).toMatch(/comisión la fija el dueño/);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'operator.created', payload: expect.objectContaining({ commissionIgnored: true }) }),
    );
  });

  it('dueño: la que ponga; sin ella, la del local (null)', async () => {
    const owner = makeOps({ operator: null });
    const res = await owner.svc.createOperator('t-1', 'u-owner', { ...dto, commissionBps: 1500 }, 'OWNER');
    expect(owner.prisma.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ commissionBps: 1500 }) });
    expect(res.notice).toBeUndefined();
    const ownerDefault = makeOps({ operator: null });
    await ownerDefault.svc.createOperator('t-1', 'u-owner', { email: 'x@example.com', displayName: 'X' }, 'OWNER');
    expect(ownerDefault.prisma.user.create).toHaveBeenCalledWith({ data: expect.objectContaining({ commissionBps: null }) });
  });

  it('encargado sin comisión en el cuerpo → sin aviso', async () => {
    const { svc } = makeOps({ operator: null });
    const res = await svc.createOperator('t-1', 'u-manager', { email: 'y@example.com', displayName: 'Y' }, 'MANAGER');
    expect(res.notice).toBeUndefined();
  });
});

describe('Enlace de la chica — su primera cuenta de cobro solo con enlace del dueño', () => {
  beforeEach(() => vi.clearAllMocks());

  it('el enlace lleva si permite la cuenta de cobro: del dueño sí, del encargado no', async () => {
    const owner = makeOps();
    await owner.svc.createSelfOnboardingLink('t-1', 'op-1', 'u-owner', 'OWNER');
    expect(owner.jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ payout: true }), expect.anything());
    const manager = makeOps();
    await manager.svc.createSelfOnboardingLink('t-1', 'op-1', 'u-manager', 'MANAGER');
    expect(manager.jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ payout: false }), expect.anything());
  });

  it('enlace del encargado: la cuenta de cobro NO se guarda; queda como propuesta para el dueño', async () => {
    const { svc, prisma, audit } = makeOps({
      tokenPayload: { sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding', payout: false },
    });
    const res = await svc.submitSelfOnboarding('header.payload.signature-token', {
      phone: '600000000',
      payoutMethod: 'USDT_TRC20',
      payoutAddress: TRON,
    });
    expect(res).toEqual({ ok: true, payoutIgnored: 'owner_required' });
    const data = prisma.user.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.phone).toBe('600000000');
    expect(data).not.toHaveProperty('payoutAddress');
    expect(data).not.toHaveProperty('payoutMethod');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.self_onboarding.submitted',
        payload: expect.objectContaining({ proposedPayout: { method: 'USDT_TRC20', address: 'T…uFiV', label: null } }),
      }),
    );
  });

  it('enlaces de antes (sin el dato) cuentan como del encargado', async () => {
    const { svc, prisma } = makeOps({
      tokenPayload: { sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding' },
    });
    await svc.submitSelfOnboarding('header.payload.signature-token', { payoutMethod: 'USDT_TRC20', payoutAddress: TRON });
    expect(prisma.user.update.mock.calls[0]![0].data).not.toHaveProperty('payoutAddress');
  });

  it('enlace del dueño pero ya tenía cuenta → no se cambia (lo hace el dueño en el panel)', async () => {
    const { svc, prisma } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    const res = await svc.submitSelfOnboarding('header.payload.signature-token', {
      payoutMethod: 'USDT_BEP20',
      payoutAddress: EVM,
    });
    expect(res).toEqual({ ok: true, payoutIgnored: 'existing' });
    expect(prisma.user.update.mock.calls[0]![0].data).not.toHaveProperty('payoutAddress');
  });

  it('el formulario sabe si puede pedir la cuenta de cobro', async () => {
    const owner = makeOps();
    expect((await owner.svc.getSelfOnboardingProfile('header.payload.signature-token')).canSetPayout).toBe(true);
    const manager = makeOps({
      tokenPayload: { sub: 'op-1', tenantId: 't-1', purpose: 'operator-self-onboarding', payout: false },
    });
    expect((await manager.svc.getSelfOnboardingProfile('header.payload.signature-token')).canSetPayout).toBe(false);
    const hasOne = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON } });
    const profile = await hasOne.svc.getSelfOnboardingProfile('header.payload.signature-token');
    expect(profile.canSetPayout).toBe(false);
    // La respuesta del enlace nunca lleva la cuenta entera.
    expect(profile.payoutAddressMasked).toBe('T…uFiV');
    expect(JSON.stringify(profile)).not.toContain(TRON);
  });
});

// ─── Cuenta de cobro segura (19-nov-2026) ───────────────────────────

/** Una compañera con su IBAN SEPA guardado como queda ahora: cifrado y tapado aparte. */
function sealedSepa() {
  return {
    payoutMethod: 'SEPA_IBAN',
    payoutAddress: sealPayoutValue(IBAN, { userId: 'op-1', field: 'address' }),
    payoutAddressMasked: 'ES91 •••• •••• 1332',
    payoutMetadata: { accountHolder: sealPayoutValue('Ana López', { userId: 'op-1', field: 'holder' }) },
    payoutHolderMasked: 'A••• L•••',
  };
}

describe('Cuenta de cobro segura — tapada en el panel, entera solo con «Ver cuenta para pagar»', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lo que devuelve el panel (la ficha de la compañera) va tapado: ni entera ni cifrada', async () => {
    const { svc } = makeOps({ operator: sealedSepa() });
    const view = await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { displayName: 'Ana' });
    expect(view).toMatchObject({
      payoutMethod: 'SEPA_IBAN',
      payoutAddressMasked: 'ES91 •••• •••• 1332',
      payoutHolderMasked: 'A••• L•••',
      payoutHolderMismatch: false,
    });
    expect(view).not.toHaveProperty('payoutAddress');
    expect(JSON.stringify(view)).not.toContain('pa1:');
    expect(JSON.stringify(view)).not.toContain(IBAN);
  });

  it('el titular que no se parece a su nombre se marca (aviso para el dueño)', async () => {
    const { svc } = makeOps({ operator: { ...sealedSepa(), displayName: 'Marina' } });
    const view = await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { onboardingNotes: 'x' });
    expect(view.payoutHolderMismatch).toBe(true);
  });

  it('«Ver cuenta para pagar»: entera para el dueño y en el registro solo tapada', async () => {
    const { svc, audit } = makeOps({ operator: sealedSepa() });
    const full = await svc.revealPayoutAccount('t-1', 'op-1', 'u-owner');
    expect(full).toEqual({
      userId: 'op-1',
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: IBAN,
      payoutLabel: null,
      payoutMetadata: { accountHolder: 'Ana López' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.payout_account_revealed',
        tenantId: 't-1',
        actorId: 'u-owner',
        targetId: 'op-1',
        payload: { payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES91 •••• •••• 1332', payoutHolder: 'A••• L•••', payoutLabel: null },
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(IBAN);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('López');
  });

  it('«Ver cuenta» de alguien que no es de este local → 404', async () => {
    const { svc } = makeOps({ operator: null });
    await expect(svc.revealPayoutAccount('t-1', 'op-x', 'u-owner')).rejects.toThrow(NotFoundException);
  });
});

describe('Marcar pagado — 48 h de espera tras cambiar la cuenta', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  function payDb(operator: Partial<typeof baseOperator>) {
    const made = makeOps({ operator });
    const prisma = made.prisma as unknown as Record<string, unknown>;
    const create = vi.fn().mockResolvedValue({ id: 'po-1', totalCents: 9000, createdAt: new Date() });
    Object.assign(prisma, {
      $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray) =>
        strings.join('?').includes('earning_reversals') ? [] : [{ id: 'e-1', commissionCents: 9000, tipCents: 0, reversedCents: 0 }],
      ),
      $executeRaw: vi.fn().mockResolvedValue(1),
      operatorPayout: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    return { ...made, create };
  }

  it('cuenta cambiada hace menos de 48 h: 409 con la fecha desde la que se puede, y no se apunta nada', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T22:00:00Z'));
    const hold = new Date('2026-11-21T21:30:00Z');
    const { svc, create } = payDb({ ...sealedSepa(), payoutHoldUntil: hold });
    const err = await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalRail: 'SEPA_IBAN' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as { code: string; payableFrom: string; message: string };
    expect(body.code).toBe('PAYOUT_ACCOUNT_TOO_NEW');
    expect(body.payableFrom).toBe(hold.toISOString());
    expect(body.message).toContain('21 de noviembre a las 22:30');
    expect(create).not.toHaveBeenCalled();
  });

  it('sin decir cómo, se mira su método (la cuenta nueva): también espera', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T22:00:00Z'));
    const { svc, create } = payDb({ ...sealedSepa(), payoutHoldUntil: new Date('2026-11-21T21:30:00Z') });
    await expect(svc.createPayout('t-1', 'op-1', 'u-owner')).rejects.toThrow(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it('en efectivo sí se le paga ya', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T22:00:00Z'));
    const { svc, create } = payDb({ ...sealedSepa(), payoutHoldUntil: new Date('2026-11-21T21:30:00Z') });
    await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalRail: 'MANUAL_CASH' });
    expect(create).toHaveBeenCalled();
  });

  /** Lo que se lee DENTRO de la transacción del pago es otra cosa que fuera: la cuenta cambió mientras tanto. */
  function changedMeanwhile(prisma: unknown, now: Partial<typeof baseOperator>) {
    const db = prisma as { user: Record<string, unknown>; $queryRaw: ReturnType<typeof vi.fn>; withTenant: ReturnType<typeof vi.fn> };
    const findFirst = vi.fn().mockResolvedValue({ ...baseOperator, ...now });
    db.withTenant.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ ...db, user: { ...db.user, findFirst } }),
    );
    return { findFirst, lock: db.$queryRaw };
  }

  it('la espera se mira con el candado ya tomado: una cuenta cambiada mientras el pago esperaba su turno no se paga', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T22:00:00Z'));
    // Al empezar la petición no había espera; al tocarle el turno, la cuenta acaba de cambiar.
    const { svc, prisma, create } = payDb(sealedSepa());
    const { findFirst, lock } = changedMeanwhile(prisma, { ...sealedSepa(), payoutHoldUntil: new Date('2026-11-21T21:30:00Z') });
    const err = await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalRail: 'SEPA_IBAN' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(((err as ConflictException).getResponse() as { code: string }).code).toBe('PAYOUT_ACCOUNT_TOO_NEW');
    expect(create).not.toHaveBeenCalled();
    // Primero el candado de la persona, después su cuenta.
    expect(findFirst.mock.invocationCallOrder[0]!).toBeGreaterThan(lock.mock.invocationCallOrder[0]!);
  });

  it('y el pago apunta la cuenta (y el método) de ese momento, no los de antes de esperar', async () => {
    const { svc, prisma, create } = payDb(sealedSepa());
    const tron = sealPayoutValue(TRON, { userId: 'op-1', field: 'address' });
    changedMeanwhile(prisma, { payoutMethod: 'USDT_TRC20', payoutAddress: tron });
    await svc.createPayout('t-1', 'op-1', 'u-owner');
    expect(create.mock.calls[0]![0].data).toMatchObject({ paidToAddress: tron, externalRail: 'USDT_TRC20' });
  });

  it('pasadas las 48 h, sí; el pago guarda la cuenta como está guardada (cifrada), nunca en claro', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    const op = { ...sealedSepa(), payoutHoldUntil: new Date('2026-11-21T21:30:00Z') };
    const { svc, create } = payDb(op);
    await svc.createPayout('t-1', 'op-1', 'u-owner', undefined, { externalRail: 'SEPA_IBAN' });
    const data = create.mock.calls[0]![0].data as { paidToAddress: string };
    expect(data.paidToAddress).toBe(op.payoutAddress);
    expect(data.paidToAddress).not.toContain(IBAN);
  });
});

describe('Aviso en su app: «Tu cuenta de cobro ha cambiado»', () => {
  beforeEach(() => vi.clearAllMocks());
  const changedAt = new Date('2026-11-19T22:00:00Z');

  it('cambiada después de la última vez que lo vio: el aviso, con la cuenta tapada', async () => {
    const { svc } = makeOps({ operator: { ...sealedSepa(), payoutAccountChangedAt: changedAt, payoutNoticeSeenAt: null } });
    expect(await svc.getPayoutNotice('op-1', 't-1')).toEqual({
      changedAt: changedAt.toISOString(),
      method: 'SEPA_IBAN',
      masked: 'ES91 •••• •••• 1332',
    });
  });

  it('ya visto, o nunca cambiada: nada', async () => {
    const seen = makeOps({ operator: { ...sealedSepa(), payoutAccountChangedAt: changedAt, payoutNoticeSeenAt: new Date('2026-11-19T23:00:00Z') } });
    expect(await seen.svc.getPayoutNotice('op-1', 't-1')).toBeNull();
    const never = makeOps({ operator: sealedSepa() });
    expect(await never.svc.getPayoutNotice('op-1', 't-1')).toBeNull();
  });

  it('«Entendido»: queda visto (solo lo suyo)', async () => {
    const { svc, prisma } = makeOps();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.user as unknown as Record<string, unknown>).updateMany = updateMany;
    await expect(svc.markPayoutNoticeSeen('op-1', 't-1')).resolves.toEqual({ ok: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'op-1', tenantId: 't-1', role: 'OPERATOR' },
      data: { payoutNoticeSeenAt: expect.any(Date) },
    });
  });
});
