import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { debtView, maskPayoutAddress, payoutAccountView } from './my-payout-info';
import { OperatorsService } from './operators.service';

describe('maskPayoutAddress — la cuenta de cobro sin enseñarla entera', () => {
  it('cripto, IBAN, teléfono: solo los 4 últimos', () => {
    expect(maskPayoutAddress('TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toBe('••••uFiV');
    expect(maskPayoutAddress(' ES9121000418450200051332 ')).toBe('••••1332');
  });

  it('email: la primera letra y el dominio', () => {
    expect(maskPayoutAddress('ana.lopez@gmail.com')).toBe('a•••@gmail.com');
  });

  it('muy corta: nada a la vista; vacía o sin dirección: null', () => {
    expect(maskPayoutAddress('1234')).toBe('••••');
    expect(maskPayoutAddress('   ')).toBeNull();
    expect(maskPayoutAddress(null)).toBeNull();
  });
});

describe('payoutAccountView', () => {
  it('método, su etiqueta y la dirección enmascarada', () => {
    expect(
      payoutAccountView({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES9121000418450200051332', payoutLabel: ' Mi banco ' }),
    ).toEqual({ method: 'SEPA_IBAN', label: 'Mi banco', masked: '••••1332' });
  });

  it('efectivo sin dirección: el método solo', () => {
    expect(payoutAccountView({ payoutMethod: 'MANUAL_CASH', payoutAddress: null, payoutLabel: null })).toEqual({
      method: 'MANUAL_CASH',
      label: null,
      masked: null,
    });
  });

  it('sin cuenta todavía (o sin chica): null', () => {
    expect(payoutAccountView({ payoutMethod: null, payoutAddress: null, payoutLabel: '' })).toBeNull();
    expect(payoutAccountView(null)).toBeNull();
  });
});

describe('debtView', () => {
  it('fechas en ISO, importes en número; abierta = sin pago que la descuente', () => {
    const view = debtView({
      id: 'r-1',
      paymentId: 'p-1',
      chargeCents: 12_000,
      cents: 4_500,
      at: new Date('2026-10-14T10:00:00Z'),
      chargedAt: new Date('2026-10-12T22:40:00Z'),
      settledPayoutId: null,
      settledAt: null,
    });
    expect(view).toEqual({
      id: 'r-1',
      paymentId: 'p-1',
      chargeCents: 12_000,
      cents: 4_500,
      at: '2026-10-14T10:00:00.000Z',
      chargedAt: '2026-10-12T22:40:00.000Z',
      settledPayoutId: null,
      settledAt: null,
    });
  });
});

function makeOps(holdDays: string | undefined) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue({ payoutMethod: 'BINANCE_PAY_ID', payoutAddress: '123456789', payoutLabel: null }),
    },
    $queryRaw: vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      queries.push({ text: sql.text, values: sql.values });
      return [
        {
          id: 'r-1',
          paymentId: 'p-1',
          chargeCents: 10_000,
          cents: 3_000,
          at: new Date('2026-10-14T10:00:00Z'),
          chargedAt: new Date('2026-10-12T22:00:00Z'),
          settledPayoutId: null,
          settledAt: null,
        },
      ];
    }),
  };
  const asSystem = vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  Object.assign(prisma, { asSystem });
  const config = { get: vi.fn((key: string) => (key === 'PAYOUT_HOLD_DAYS' ? holdDays : undefined)) };
  const svc = new OperatorsService(
    prisma as never,
    {} as never,
    {} as never,
    config as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma, queries, asSystem };
}

describe('OperatorsService.getMyPayoutInfo — GET /operators/me/payout-info', () => {
  it('días de espera, su cuenta enmascarada y sus deudas, solo las suyas y de su local', async () => {
    const { svc, prisma, queries, asSystem } = makeOps('0');
    const info = await svc.getMyPayoutInfo('op-1', 't-1');

    expect(info.holdDays).toBe(0);
    expect(info.account).toEqual({ method: 'BINANCE_PAY_ID', label: null, masked: '••••6789' });
    expect(info.debts).toEqual([expect.objectContaining({ id: 'r-1', cents: 3_000, settledPayoutId: null })]);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'op-1', tenantId: 't-1' } }),
    );
    // Las tablas de dinero, dentro de una transacción con el local fijado.
    expect(asSystem).toHaveBeenCalledTimes(1);
    const sql = queries[0]!;
    expect(sql.text).toContain('r."afterPayout"');
    expect(sql.values).toEqual(expect.arrayContaining(['op-1', 't-1']));
  });

  it('sin PAYOUT_HOLD_DAYS: los 7 días de siempre', async () => {
    const { svc } = makeOps(undefined);
    expect((await svc.getMyPayoutInfo('op-1', 't-1')).holdDays).toBe(7);
  });
});
