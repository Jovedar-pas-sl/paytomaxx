import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

// Sala Bambú (Madrid): Javier (dueño) confirma a mano un pago a Lucía.
const TENANT = '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d';
const OTHER_TENANT = '7d6c5b4a-3e2f-4a1b-9c0d-8e7f6a5b4c3d';
const PAYOUT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OWNER = '0f1e2d3c-4b5a-4968-8776-655443322110';
const NOW = new Date('2026-10-18T12:40:00+02:00');

interface Opts {
  payout?: Record<string, unknown> | null;
  updateError?: Error;
  rate?: { rate: number; degraded: boolean };
}

function makeService(opts: Opts = {}) {
  const payout =
    opts.payout === null
      ? null
      : {
          id: PAYOUT_ID,
          tenantId: TENANT,
          totalCents: 48_000,
          externalRail: 'SEPA_IBAN',
          externalTxId: null,
          reconciliationStatus: 'UNRECONCILED',
          ...(opts.payout ?? {}),
        };
  const tx = {
    operatorPayout: {
      findUnique: vi.fn().mockResolvedValue(payout),
      update: opts.updateError ? vi.fn().mockRejectedValue(opts.updateError) : vi.fn().mockResolvedValue(payout),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const factory = {
    getEurToUsdtRateInfo: vi.fn().mockResolvedValue(opts.rate ?? { rate: 1.0832, degraded: false }),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const svc = new TreasuryService(prisma as never, audit as never, factory as never, { get: vi.fn() } as never);
  return { svc, tx, audit, factory };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TreasuryService.confirmManual — hace falta un justificante', () => {
  it.each([
    ['nada', {}],
    ['referencia de menos de 4 caracteres', { externalTxId: 'T12' }],
    ['nota en blanco', { notes: '   ' }],
    ['enlace vacío', { receiptUrl: '' }],
  ])('%s → 400 sin leer el pago', async (_caso, artifact) => {
    const { svc, tx } = makeService();
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.operatorPayout.findUnique).not.toHaveBeenCalled();
  });

  // Antes una referencia o un enlace solo con espacios pasaban por justificante:
  // el pago quedaba MANUAL_OK con una «referencia» en blanco.
  it.each([
    ['referencia solo con espacios', { externalTxId: '    ' }],
    ['referencia corta con espacios alrededor', { externalTxId: '  T12  ' }],
    ['enlace solo con espacios', { receiptUrl: '   ' }],
  ])('%s no cuenta como justificante → 400', async (_caso, artifact) => {
    const { svc, tx } = makeService();
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
  });

  it('la referencia se guarda sin espacios alrededor (así el índice único ve el hash repetido)', async () => {
    const { svc, tx } = makeService();
    await svc.confirmManual(TENANT, PAYOUT_ID, OWNER, { externalTxId: ' TRF-20261018-0042 ' });
    expect(tx.operatorPayout.update.mock.calls[0]![0].data).toMatchObject({ externalTxId: 'TRF-20261018-0042' });
  });

  it.each([
    ['referencia de la transferencia', { externalTxId: 'TRF-20261018-0042' }, 'externalTxId'],
    ['enlace al justificante', { receiptUrl: 'https://docs.salabambu.es/justificantes/0042.pdf' }, 'receiptUrl'],
    ['nota', { notes: 'Pagado en mano por Javier en la oficina' }, 'notes'],
  ])('con %s basta: queda MANUAL_OK con quién y cuándo', async (_caso, artifact, key) => {
    const { svc, tx } = makeService();
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).resolves.toEqual({ ok: true });
    const { where, data } = tx.operatorPayout.update.mock.calls[0]![0];
    expect(where).toEqual({ id: PAYOUT_ID });
    expect(data).toEqual({
      reconciliationStatus: 'MANUAL_OK',
      reconciledAt: NOW,
      reconciledByUserId: OWNER,
      [key]: Object.values(artifact)[0],
    });
  });
});

describe('TreasuryService.confirmManual — estado y local del pago', () => {
  const artifact = { externalTxId: 'TRF-20261018-0042', notes: 'Transferencia CaixaBank' };

  it('pago que no existe → 404', async () => {
    const { svc } = makeService({ payout: null });
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pago de otro local → 403 y no se toca', async () => {
    const { svc, tx, audit } = makeService({ payout: { tenantId: OTHER_TENANT } });
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('ya verificado on-chain (MATCHED) → 409 sin rebajarlo a manual', async () => {
    const { svc, tx } = makeService({ payout: { reconciliationStatus: 'MATCHED' } });
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
  });

  it('ya confirmado a mano → ok sin reescribir ni registrar otra vez', async () => {
    const { svc, tx, audit } = makeService({ payout: { reconciliationStatus: 'MANUAL_OK' } });
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).resolves.toEqual({ ok: true });
    expect(tx.operatorPayout.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('un pago en MISMATCH sí se puede confirmar a mano, con todos sus justificantes', async () => {
    const { svc, tx } = makeService({ payout: { reconciliationStatus: 'MISMATCH' } });
    await svc.confirmManual(TENANT, PAYOUT_ID, OWNER, { ...artifact, receiptUrl: 'https://docs.salabambu.es/j/42.pdf' });
    expect(tx.operatorPayout.update.mock.calls[0]![0].data).toMatchObject({
      reconciliationStatus: 'MANUAL_OK',
      externalTxId: 'TRF-20261018-0042',
      receiptUrl: 'https://docs.salabambu.es/j/42.pdf',
      notes: 'Transferencia CaixaBank',
    });
  });

  it('queda en el registro qué justificantes había, sin copiarlos', async () => {
    const { svc, audit } = makeService();
    await svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact);
    expect(audit.log).toHaveBeenCalledWith({
      action: 'operator.payout.confirmed_manual',
      tenantId: TENANT,
      actorId: OWNER,
      targetType: 'OperatorPayout',
      targetId: PAYOUT_ID,
      payload: { hasExternalTxId: true, hasReceiptUrl: false, hasNotes: true },
    });
  });

  it('hash ya apuntado en otro pago (índice único) → 409 PAYOUT_TX_ALREADY_USED y sin registro', async () => {
    const { svc, audit } = makeService({
      payout: { externalRail: 'USDT_TRC20' },
      updateError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    });
    const err = await svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(((err as HttpException).getResponse() as { code: string }).code).toBe('PAYOUT_TX_ALREADY_USED');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('otro fallo de la base se propaga tal cual', async () => {
    const boom = new Error('canceling statement due to statement timeout');
    const { svc } = makeService({ updateError: boom });
    await expect(svc.confirmManual(TENANT, PAYOUT_ID, OWNER, artifact)).rejects.toBe(boom);
  });
});

describe('TreasuryService.getExchangeRate — tipo EUR→USDT para el panel', () => {
  it('Binance en marcha: el tipo en vivo con la hora de la consulta', async () => {
    const { svc } = makeService();
    expect(await svc.getExchangeRate()).toEqual({ pair: 'EUR/USDT', rate: 1.0832, at: NOW.toISOString(), degraded: false });
  });

  it('Binance caído: el tipo de reserva, marcado como degradado', async () => {
    const { svc } = makeService({ rate: { rate: 1.07, degraded: true } });
    expect(await svc.getExchangeRate()).toMatchObject({ rate: 1.07, degraded: true });
  });
});
