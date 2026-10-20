import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ALREADY_PAID_CODE } from '@nightpay/contracts';
import {
  alreadyPaid,
  cancelCardForSaldo,
  closeLinkedSaldo,
  isCardPaid,
  lockLinkedCard,
  moveLinesToSaldo,
  PAID_WITH_SALDO_EVENT,
  saldoMayPay,
  type LinkedCardRow,
} from './cobro-link';
import { applyEvent, type PaymentMachineState } from './payment.machine';

const PAYMENT = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const CHARGE = '0b7a0c5e-1d2e-4f3a-9b8c-7d6e5f4a3b2c';
const SALA = '3c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f';

/** Lo que llega al SQL: el texto y los valores (Prisma.sql de mentira). */
function fakeTx(rows: unknown[] = []) {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sql.push({ text: strings.join('$'), values });
  };
  return {
    sql,
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, ...values);
      return rows;
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, ...values);
      return 1;
    }),
  };
}

const card = (status: PaymentMachineState): LinkedCardRow => ({
  id: PAYMENT,
  tenantId: SALA,
  status,
  amountCents: 2000,
  availableAmountCents: 2000,
  providerTxId: null,
  provider: null,
});

describe('cobro único: quién gana', () => {
  it('el saldo paga si la tarjeta no está pagada ni cerrada (también en el banco o sin confirmar)', () => {
    for (const s of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN', 'FAILED'] as const) {
      expect(saldoMayPay(card(s))).toBe('ok');
    }
    for (const s of ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const) expect(saldoMayPay(card(s))).toBe('paid');
    for (const s of ['EXPIRED', 'CANCELED'] as const) expect(saldoMayPay(card(s))).toBe('closed');
  });

  it('«Ya está pagado» es un 409 con su code', () => {
    const err = alreadyPaid();
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: ALREADY_PAID_CODE, message: 'Ya está pagado' });
    expect(isCardPaid('AUTHORIZED')).toBe(true);
    expect(isCardPaid('CANCELED')).toBe(false);
    expect(isCardPaid(null)).toBe(false);
  });

  it('la máquina de estados: PAID_WITH_SALDO cancela la tarjeta desde el banco, nunca una pagada', () => {
    const ctx = { paymentId: PAYMENT, amountCents: 2000, availableAmountCents: 2000 };
    const ev = { type: 'PAID_WITH_SALDO' as const, walletChargeId: CHARGE };
    for (const s of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN', 'FAILED'] as const) {
      const r = applyEvent(s, ctx, ev);
      expect(r?.nextState).toBe('CANCELED');
      expect(r?.nextContext.failureReason).toBe('paid-with-saldo');
    }
    for (const s of ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'CANCELED'] as const) {
      expect(applyEvent(s, ctx, ev)).toBeNull();
    }
    // Y cancelado así, una aprobación tardía no lo da por pagado.
    expect(applyEvent('CANCELED', ctx, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: 'X1' })).toBeNull();
  });
});

describe('cobro único: lo que se escribe', () => {
  it('bloquea la fila del cobro con tarjeta (FOR UPDATE)', async () => {
    const tx = fakeTx([card('AUTHORIZING')]);
    expect(await lockLinkedCard(tx as never, PAYMENT)).toMatchObject({ status: 'AUTHORIZING' });
    expect(tx.sql[0]!.text).toMatch(/FROM payments[\s\S]*FOR UPDATE/);
    expect(tx.sql[0]!.values).toEqual([PAYMENT]);
    expect(await lockLinkedCard(fakeTx([]) as never, PAYMENT)).toBeNull();
  });

  it('pagado con el saldo: el cobro pasa a CANCELED con su evento, y las líneas al saldo', async () => {
    const tx = fakeTx();
    await moveLinesToSaldo(tx as never, PAYMENT, CHARGE);
    await cancelCardForSaldo(tx as never, card('AUTHORIZING'), CHARGE, 'trace-1');
    expect(tx.sql[0]!.text).toMatch(/UPDATE payment_lines[\s\S]*"walletChargeId" = \$::uuid, "paymentId" = NULL/);
    expect(tx.sql[0]!.values).toEqual([CHARGE, PAYMENT]);
    expect(tx.sql[1]!.text).toMatch(/UPDATE payments/);
    expect(tx.sql[1]!.values).toEqual(['CANCELED', PAYMENT]);
    expect(tx.sql[2]!.values).toEqual([
      PAYMENT,
      SALA,
      PAID_WITH_SALDO_EVENT,
      JSON.stringify({ type: 'PAID_WITH_SALDO', walletChargeId: CHARGE, fromStatus: 'AUTHORIZING' }),
      'trace-1',
    ]);
  });

  it('con la tarjeta ya pagada, no la cancela: «Ya está pagado» y no escribe nada', async () => {
    const tx = fakeTx();
    await expect(cancelCardForSaldo(tx as never, card('AUTHORIZED'), CHARGE, 't')).rejects.toMatchObject({
      response: { code: ALREADY_PAID_CODE },
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('la tarjeta termina: su saldo pendiente se cancela (pagada o cancelada) o caduca', async () => {
    const tx = fakeTx();
    await closeLinkedSaldo(tx as never, PAYMENT, 'AUTHORIZED');
    await closeLinkedSaldo(tx as never, PAYMENT, 'CANCELED');
    await closeLinkedSaldo(tx as never, PAYMENT, 'EXPIRED');
    expect(tx.sql.map((s) => s.values)).toEqual([
      ['CANCELED', PAYMENT],
      ['CANCELED', PAYMENT],
      ['EXPIRED', PAYMENT],
    ]);
    expect(tx.sql[0]!.text).toMatch(/WHERE "linkedPaymentId" = \$::uuid AND status = 'PENDING'/);
    // En el banco, denegada o sin confirmar: el saldo sigue libre.
    for (const s of ['AUTHORIZING', 'FAILED', 'ORPHAN', 'AWAITING_CAPTURE'] as const) {
      expect(await closeLinkedSaldo(tx as never, PAYMENT, s)).toBe(0);
    }
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });
});
