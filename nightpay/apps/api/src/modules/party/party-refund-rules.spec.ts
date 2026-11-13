import { describe, it, expect } from 'vitest';
import { PartyRefundAskSchema, isRefundWindowOpen, madridDay } from '@nightpay/contracts';
import {
  PARTY_REFUND_BLOCK_REASON,
  ZERO_BY_METHOD,
  blockedByRefund,
  pendingByMethod,
  planRefundAsk,
  refundAvailability,
  walletAfterRefund,
  type RefundMoney,
  type RefundWallet,
} from './party-refund-rules';

const IBAN = 'ES9121000418450200051332';
const NOW = new Date('2027-06-25T10:00:00Z');

function wallet(o: Partial<RefundWallet> = {}): RefundWallet {
  return { status: 'ACTIVE', balanceCents: 1300, blockedAt: null, blockedReason: null, mergedIntoId: null, ...o };
}

function money(o: Partial<RefundMoney> = {}): RefundMoney {
  return { balanceCents: 1300, cashLeftCents: 0, pending: { ...ZERO_BY_METHOD }, ...o };
}

function plan(
  o: {
    wallet?: RefundWallet;
    deadline?: string | null;
    allowDonation?: boolean;
    money?: RefundMoney;
    topUp?: boolean;
    method?: 'CARD' | 'TRANSFER' | 'DONATE';
    expected?: number;
    now?: Date;
  } = {},
) {
  return planRefundAsk({
    wallet: o.wallet ?? wallet(),
    deadline: o.deadline === undefined ? '2027-06-30' : o.deadline,
    allowDonation: o.allowDonation ?? true,
    money: o.money ?? money(),
    topUpInProgress: o.topUp ?? false,
    dto: { method: o.method ?? 'CARD', expectedAmountCents: o.expected },
    now: o.now ?? NOW,
  });
}

describe('«Lo que sobra»: el plazo', () => {
  it('hasta el último día incluido, en hora de Madrid', () => {
    // 30 de junio a las 23:30 en Madrid (21:30 UTC): todavía vale.
    expect(isRefundWindowOpen('2027-06-30', new Date('2027-06-30T21:30:00Z'))).toBe(true);
    // 1 de julio a las 00:30 en Madrid (22:30 UTC del 30): ya no.
    expect(isRefundWindowOpen('2027-06-30', new Date('2027-06-30T22:30:00Z'))).toBe(false);
    expect(madridDay(new Date('2027-06-30T22:30:00Z'))).toBe('2027-07-01');
  });

  it('sin plazo, siempre se puede pedir', () => {
    expect(isRefundWindowOpen(null, NOW)).toBe(true);
    expect(plan({ deadline: null })).toEqual({ ok: true, amountCents: 1300, doneNow: false });
  });

  it('pasado el plazo, no se puede pedir (por ninguna vía)', () => {
    for (const method of ['CARD', 'TRANSFER', 'DONATE'] as const) {
      expect(plan({ deadline: '2027-06-24', method, money: money({ cashLeftCents: 1300 }) })).toMatchObject({ ok: false, code: 'REFUND_CLOSED' });
    }
  });
});

describe('«Lo que sobra»: cuánto por cada vía', () => {
  it('a la tarjeta, solo lo cargado con tarjeta (lo gastado cuenta antes como tarjeta)', () => {
    // Cargó 10 € con tarjeta y 5 € en efectivo, gastó 2 €: quedan 13 €, de ellos 5 € en efectivo.
    const a = refundAvailability(money({ balanceCents: 1300, cashLeftCents: 500 }), true);
    expect(a).toEqual({ CARD: 800, TRANSFER: 500, DONATE: 1300 });
    expect(plan({ money: money({ balanceCents: 1300, cashLeftCents: 500 }) })).toEqual({ ok: true, amountCents: 800, doneNow: false });
  });

  it('todo en efectivo: a la tarjeta nada, por transferencia todo', () => {
    const m = money({ balanceCents: 1300, cashLeftCents: 2000 });
    expect(refundAvailability(m, true)).toEqual({ CARD: 0, TRANSFER: 1300, DONATE: 1300 });
    expect(plan({ money: m, method: 'CARD' })).toMatchObject({ ok: false, code: 'REFUND_METHOD_UNAVAILABLE' });
    expect(plan({ money: m, method: 'TRANSFER' })).toEqual({ ok: true, amountCents: 1300, doneNow: false });
  });

  it('todo con tarjeta: la transferencia no vale (lo de la tarjeta vuelve a la tarjeta)', () => {
    expect(plan({ method: 'TRANSFER' })).toMatchObject({ ok: false, code: 'REFUND_METHOD_UNAVAILABLE' });
  });

  it('lo ya pedido y pendiente no se pide otra vez; el resto sí', () => {
    const m = money({ balanceCents: 1300, cashLeftCents: 500, pending: { CARD: 800, TRANSFER: 0, DONATE: 0 } });
    expect(refundAvailability(m, true)).toEqual({ CARD: 0, TRANSFER: 500, DONATE: 500 });
    expect(plan({ money: m, method: 'CARD' })).toMatchObject({ ok: false, code: 'REFUND_METHOD_UNAVAILABLE' });
    expect(plan({ money: m, method: 'TRANSFER' })).toEqual({ ok: true, amountCents: 500, doneNow: false });
  });

  it('todo pedido: no queda nada', () => {
    const m = money({ balanceCents: 1300, cashLeftCents: 500, pending: { CARD: 800, TRANSFER: 500, DONATE: 0 } });
    expect(refundAvailability(m, true)).toEqual(ZERO_BY_METHOD);
    expect(plan({ money: m, method: 'DONATE' })).toMatchObject({ ok: false, code: 'NOTHING_TO_REFUND' });
  });

  it('saldo a cero: nada que pedir', () => {
    expect(plan({ wallet: wallet({ balanceCents: 0 }), money: money({ balanceCents: 0 }) })).toMatchObject({ ok: false, code: 'NOTHING_TO_REFUND' });
  });

  it('un efectivo «negativo» (más salidas que entradas) cuenta como cero', () => {
    expect(refundAvailability(money({ cashLeftCents: -300 }), false)).toEqual({ CARD: 1300, TRANSFER: 0, DONATE: 0 });
  });
});

describe('«Lo que sobra»: donar', () => {
  it('con el local que lo deja: todo lo que queda, hecho al momento', () => {
    expect(plan({ method: 'DONATE' })).toEqual({ ok: true, amountCents: 1300, doneNow: true });
  });

  it('con donar apagado, no (y no sale como vía)', () => {
    expect(plan({ method: 'DONATE', allowDonation: false })).toMatchObject({ ok: false, code: 'DONATION_OFF' });
    expect(refundAvailability(money(), false).DONATE).toBe(0);
  });
});

describe('«Lo que sobra»: el saldo', () => {
  it('bloqueado por OxioParty (otra pendiente) sí deja pedir el resto; por el super-admin, no', () => {
    const mine = wallet({ blockedAt: NOW, blockedReason: PARTY_REFUND_BLOCK_REASON });
    expect(blockedByRefund(mine)).toBe(true);
    expect(plan({ wallet: mine })).toMatchObject({ ok: true });
    const admin = wallet({ blockedAt: NOW, blockedReason: 'Fraude' });
    expect(blockedByRefund(admin)).toBe(false);
    expect(plan({ wallet: admin })).toMatchObject({ ok: false, code: 'WALLET_BLOCKED' });
  });

  it('con una recarga a medias, no se pide por ninguna vía (409 TOPUP_IN_PROGRESS)', () => {
    for (const method of ['CARD', 'TRANSFER', 'DONATE'] as const) {
      expect(plan({ method, topUp: true, money: money({ cashLeftCents: 500 }) })).toMatchObject({ ok: false, code: 'TOPUP_IN_PROGRESS' });
    }
    expect(plan({ topUp: false })).toMatchObject({ ok: true });
  });

  it('cerrado o sumado a otro: nada que devolver', () => {
    expect(plan({ wallet: wallet({ status: 'REFUNDED' }) })).toMatchObject({ ok: false, code: 'NOTHING_TO_REFUND' });
    expect(plan({ wallet: wallet({ mergedIntoId: 'otro' }) })).toMatchObject({ ok: false, code: 'NOTHING_TO_REFUND' });
  });

  it('si el importe ya no es el que vio, 409 en vez de pedir otra cosa', () => {
    expect(plan({ expected: 1200 })).toMatchObject({ ok: false, code: 'REFUND_AMOUNT_CHANGED' });
    expect(plan({ expected: 1300 })).toMatchObject({ ok: true, amountCents: 1300 });
  });

  it('al hacerla: el importe sale; a cero y sin más pendientes, se cierra y se desbloquea', () => {
    const w = wallet({ blockedAt: NOW, blockedReason: PARTY_REFUND_BLOCK_REASON });
    expect(walletAfterRefund(w, 1300, 0)).toEqual({ balanceCents: 0, status: 'REFUNDED', unblock: true });
    // Con otra pendiente: sigue bloqueado y abierto.
    expect(walletAfterRefund(w, 800, 1)).toEqual({ balanceCents: 500, unblock: false });
    // Pidió solo lo de la tarjeta: lo que queda se puede volver a gastar.
    expect(walletAfterRefund(w, 800, 0)).toEqual({ balanceCents: 500, unblock: true });
    // El bloqueo del super-admin no lo quita una devolución.
    expect(walletAfterRefund(wallet({ blockedAt: NOW, blockedReason: 'Fraude' }), 1300, 0)).toEqual({ balanceCents: 0, status: 'REFUNDED', unblock: false });
    // El saldo ya no llega (se devolvió por otro camino): nada.
    expect(walletAfterRefund(wallet({ balanceCents: 500 }), 800, 0)).toBeNull();
  });

  it('lo pendiente por vía (las hechas y anuladas no cuentan)', () => {
    expect(
      pendingByMethod([
        { method: 'CARD', amountCents: 800, status: 'PENDING' },
        { method: 'TRANSFER', amountCents: 500, status: 'DONE' },
        { method: 'TRANSFER', amountCents: 300, status: 'CANCELED' },
        { method: 'TRANSFER', amountCents: 200, status: 'PENDING' },
      ]),
    ).toEqual({ CARD: 800, TRANSFER: 200, DONATE: 0 });
  });
});

describe('«Lo que sobra»: lo que manda el asistente', () => {
  it('el IBAN se guarda sin espacios y en mayúsculas, con su dígito de control (mod-97)', () => {
    const ok = PartyRefundAskSchema.safeParse({ method: 'TRANSFER', iban: 'es91 2100 0418 4502 0005 1332' });
    expect(ok.success && ok.data.iban).toBe(IBAN);
    expect(PartyRefundAskSchema.safeParse({ method: 'TRANSFER', iban: 'ES9121000418450200051333' }).success).toBe(false);
    expect(PartyRefundAskSchema.safeParse({ method: 'TRANSFER', iban: 'hola' }).success).toBe(false);
  });

  it('la transferencia pide IBAN; la tarjeta y donar no lo llevan', () => {
    expect(PartyRefundAskSchema.safeParse({ method: 'TRANSFER' }).success).toBe(false);
    expect(PartyRefundAskSchema.safeParse({ method: 'CARD', iban: IBAN }).success).toBe(false);
    expect(PartyRefundAskSchema.safeParse({ method: 'DONATE' }).success).toBe(true);
    expect(PartyRefundAskSchema.safeParse({ method: 'BIZUM' }).success).toBe(false);
  });

  it('el correo es opcional: vacío = sin correo; uno malo, no', () => {
    const empty = PartyRefundAskSchema.safeParse({ method: 'CARD', email: '  ' });
    expect(empty.success && empty.data.email).toBeNull();
    const mail = PartyRefundAskSchema.safeParse({ method: 'CARD', email: ' Ana@Correo.ES ' });
    expect(mail.success && mail.data.email).toBe('ana@correo.es');
    expect(PartyRefundAskSchema.safeParse({ method: 'CARD', email: 'no-es-correo' }).success).toBe(false);
  });

  it('lo que no es suyo (la llave del móvil) no pasa al servicio', () => {
    const r = PartyRefundAskSchema.safeParse({ method: 'CARD', response: { id: 'x' }, amountCents: 99 });
    expect(r.success && r.data).toEqual({ method: 'CARD' });
  });
});
