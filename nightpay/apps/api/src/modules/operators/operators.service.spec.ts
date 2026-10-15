import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(operator),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...operator, ...data })),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...baseOperator,
        invitedAt: new Date(),
        ...data,
      })),
    },
    venue: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ name: 'Local', operatorCommissionDefaults: { CHICA_SERVICE: 9000 } }),
    },
  };
  Object.assign(prisma, {
    asSystem: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma)),
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
  return { svc, prisma, audit, jwt, email };
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
