import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OperatorsService } from './operators.service';

const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const EVM = '0x55d398326f99059ff775485246999027b3197955';

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
  const email = { send: vi.fn().mockResolvedValue({ delivered: false }) };
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
  const svc = new OperatorsService(
    prisma as never,
    email as never,
    audit as never,
    config as never,
    jwt as never,
    fx as never,
  );
  return { svc, prisma, audit, jwt, email, updateInSystem };
}

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

  it('válida → se guarda normalizada (IBAN en mayúsculas y sin espacios)', async () => {
    const { svc, prisma } = makeOps();
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', {
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: ' es91 2100 0418 4502 0005 1332 ',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: expect.objectContaining({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES9121000418450200051332' }),
    });
  });

  it('cambios que no tocan el cobro no revalidan lo guardado', async () => {
    const { svc, prisma } = makeOps({ operator: { payoutMethod: 'USDT_TRC20', payoutAddress: 'vieja-mal' } });
    await svc.updateOperator('t-1', 'op-1', 'u-owner', 'OWNER', { displayName: 'Ana B.' });
    expect(prisma.user.update).toHaveBeenCalled();
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

  it('válida → se guarda normalizada', async () => {
    const { svc, prisma } = makeOps();
    await svc.submitSelfOnboarding('header.payload.signature-token', {
      payoutMethod: 'USDT_TRC20',
      payoutAddress: ` ${TRON} `,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: expect.objectContaining({ payoutMethod: 'USDT_TRC20', payoutAddress: TRON }),
    });
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
        payload: expect.objectContaining({ proposedPayout: { method: 'USDT_TRC20', address: TRON, label: null } }),
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
    expect((await hasOne.svc.getSelfOnboardingProfile('header.payload.signature-token')).canSetPayout).toBe(false);
  });
});
