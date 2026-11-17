import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  InvalidTransitionError,
  isIdempotentTransition,
  type PaymentContext,
} from './payment.machine';

const baseCtx = (over: Partial<PaymentContext> = {}): PaymentContext => ({
  paymentId: 'p1',
  amountCents: 4850,
  availableAmountCents: 4850,
  ...over,
});

describe('paymentMachine', () => {
  it('CREATED + QR_VIEWED → AWAITING_CAPTURE', () => {
    const r = applyEvent('CREATED', baseCtx(), { type: 'QR_VIEWED' });
    expect(r?.nextState).toBe('AWAITING_CAPTURE');
  });

  it('CREATED + TIMEOUT → EXPIRED', () => {
    const r = applyEvent('CREATED', baseCtx(), { type: 'TIMEOUT' });
    expect(r?.nextState).toBe('EXPIRED');
  });

  it('AUTHORIZING + AUTHORIZED persists providerTxId', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-1',
      provider: 'WIPAY',
    });
    expect(r?.nextState).toBe('AUTHORIZED');
    expect(r?.nextContext.providerTxId).toBe('TX-1');
    expect(r?.nextContext.provider).toBe('WIPAY');
  });

  it('AUTHORIZING + TIMEOUT → ORPHAN', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), { type: 'TIMEOUT' });
    expect(r?.nextState).toBe('ORPHAN');
  });

  it('ORPHAN + AUTHORIZED → AUTHORIZED', () => {
    const r = applyEvent('ORPHAN', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-2',
      provider: 'PEANPE',
    });
    expect(r?.nextState).toBe('AUTHORIZED');
  });

  it('AUTHORIZED + REFUND_PARTIAL (parcial) → PARTIALLY_REFUNDED', () => {
    const r = applyEvent('AUTHORIZED', baseCtx({ availableAmountCents: 4850 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 1200,
    });
    expect(r?.nextState).toBe('PARTIALLY_REFUNDED');
    expect(r?.nextContext.availableAmountCents).toBe(3650);
  });

  it('AUTHORIZED + REFUND_PARTIAL que cubre todo → REFUNDED', () => {
    const r = applyEvent('AUTHORIZED', baseCtx({ availableAmountCents: 4850 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 4850,
    });
    expect(r?.nextState).toBe('REFUNDED');
  });

  it('PARTIALLY_REFUNDED + REFUND_PARTIAL adicional → PARTIALLY_REFUNDED', () => {
    const r = applyEvent('PARTIALLY_REFUNDED', baseCtx({ availableAmountCents: 3650 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 1000,
    });
    expect(r?.nextState).toBe('PARTIALLY_REFUNDED');
    expect(r?.nextContext.availableAmountCents).toBe(2650);
  });

  it('FAILED es terminal — REFUND_PARTIAL no transiciona', () => {
    const r = applyEvent('FAILED', baseCtx(), { type: 'REFUND_PARTIAL', amountCents: 100 });
    expect(r).toBeNull();
  });

  it('CREATED + AUTHORIZED es transición ilegal', () => {
    const r = applyEvent('CREATED', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'X',
      provider: 'WIPAY',
    });
    expect(r).toBeNull();
  });

  it('EXPIRED + cualquier cosa → null (terminal)', () => {
    const r = applyEvent('EXPIRED', baseCtx(), { type: 'AUTHORIZING' });
    expect(r).toBeNull();
  });

  it('devolución mayor que lo que queda → rechazada, no se recorta a 0 (Fase 1C)', () => {
    expect(
      applyEvent('PARTIALLY_REFUNDED', baseCtx({ availableAmountCents: 1000 }), {
        type: 'REFUND_PARTIAL',
        amountCents: 1001,
      }),
    ).toBeNull();
    expect(
      applyEvent('AUTHORIZED', baseCtx({ availableAmountCents: 1000 }), { type: 'REFUND_PARTIAL', amountCents: 0 }),
    ).toBeNull();
  });

  it('PARTIALLY_REFUNDED + REFUND_PARTIAL que vacia el saldo → REFUNDED', () => {
    const r = applyEvent('PARTIALLY_REFUNDED', baseCtx({ availableAmountCents: 1000 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 1000,
    });
    expect(r?.nextState).toBe('REFUNDED');
    expect(r?.nextContext.availableAmountCents).toBe(0);
  });

  it('ORPHAN + FAILED → FAILED (saga reconcile failure)', () => {
    const r = applyEvent('ORPHAN', baseCtx(), { type: 'FAILED', reason: 'gateway-confirmed-fail' });
    expect(r?.nextState).toBe('FAILED');
    expect(r?.nextContext.failureReason).toBe('gateway-confirmed-fail');
  });

  it('AUTHORIZING + FAILED registra reason', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), { type: 'FAILED', reason: 'card-declined' });
    expect(r?.nextState).toBe('FAILED');
    expect(r?.nextContext.failureReason).toBe('card-declined');
  });

  it('AUTHORIZED + AUTHORIZING (re-autorizar) es ilegal', () => {
    const r = applyEvent('AUTHORIZED', baseCtx(), { type: 'AUTHORIZING' });
    expect(r).toBeNull();
  });

  it('AUTHORIZED + AUTHORIZED duplicado (webhook re-emitido) → null', () => {
    // Caso real: pasarela re-envia el mismo webhook. La idempotencia de
    // webhookDelivery deberia atraparlo, pero la FSM es la 2a linea de defensa.
    const r = applyEvent('AUTHORIZED', baseCtx(), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-DUP',
      provider: 'WIPAY',
    });
    expect(r).toBeNull();
  });

  it('REFUNDED es terminal — REFUND_PARTIAL adicional → null', () => {
    const r = applyEvent('REFUNDED', baseCtx({ availableAmountCents: 0 }), {
      type: 'REFUND_PARTIAL',
      amountCents: 100,
    });
    expect(r).toBeNull();
  });

  it('CREATED + REFUND_PARTIAL (sin haber autorizado) → null', () => {
    const r = applyEvent('CREATED', baseCtx(), { type: 'REFUND_PARTIAL', amountCents: 1000 });
    expect(r).toBeNull();
  });

  it('AUTHORIZING + QR_VIEWED (out-of-order) → null', () => {
    const r = applyEvent('AUTHORIZING', baseCtx(), { type: 'QR_VIEWED' });
    expect(r).toBeNull();
  });
});

describe('paymentMachine — aprobación del banco después de un FAILED', () => {
  it('FAILED + AUTHORIZED → AUTHORIZED (el cliente reintentó y pagó): se apunta con su pedido', () => {
    const r = applyEvent('FAILED', baseCtx({ failureReason: 'card-declined' }), {
      type: 'AUTHORIZED',
      providerTxId: 'TX-RETRY',
      provider: 'PAYTEF',
    });
    expect(r?.nextState).toBe('AUTHORIZED');
    expect(r?.nextContext.providerTxId).toBe('TX-RETRY');
    expect(r?.nextContext.provider).toBe('PAYTEF');
  });

  it('FAILED solo sale con una aprobación: ni reintento, ni caducidad, ni devoluciones', () => {
    expect(applyEvent('FAILED', baseCtx(), { type: 'AUTHORIZING' })).toBeNull();
    expect(applyEvent('FAILED', baseCtx(), { type: 'TIMEOUT' })).toBeNull();
    expect(applyEvent('FAILED', baseCtx(), { type: 'FAILED', reason: 'otra' })).toBeNull();
    expect(applyEvent('FAILED', baseCtx(), { type: 'CANCELED' })).toBeNull();
  });

  it('EXPIRED y CANCELED no reviven ni con una aprobación', () => {
    const approval = { type: 'AUTHORIZED', providerTxId: 'TX', provider: 'REDSYS' } as const;
    expect(applyEvent('EXPIRED', baseCtx(), approval)).toBeNull();
    expect(applyEvent('CANCELED', baseCtx(), approval)).toBeNull();
  });
});

describe('isIdempotentTransition — qué avisos rechazados se dan por procesados', () => {
  const rejected = (state: Parameters<typeof applyEvent>[0], eventType: string) =>
    isIdempotentTransition(new InvalidTransitionError(state, eventType));

  it('aviso repetido o tardío de un cobro ya hecho → procesado sin más', () => {
    expect(rejected('AUTHORIZED', 'AUTHORIZED')).toBe(true);
    expect(rejected('PARTIALLY_REFUNDED', 'AUTHORIZED')).toBe(true);
    expect(rejected('REFUNDED', 'AUTHORIZED')).toBe(true);
    expect(rejected('FAILED', 'FAILED')).toBe(true);
  });

  it('denegación que llega después de la aprobación → no deshace el cobro', () => {
    expect(rejected('AUTHORIZED', 'FAILED')).toBe(true);
    expect(rejected('PARTIALLY_REFUNDED', 'FAILED')).toBe(true);
  });

  it('aprobación del banco para un cobro caducado/cancelado → NO se ignora (es dinero cobrado)', () => {
    expect(rejected('EXPIRED', 'AUTHORIZED')).toBe(false);
    expect(rejected('CANCELED', 'AUTHORIZED')).toBe(false);
    // Lo demás que llega tarde a un cobro cerrado sí es solo informativo.
    expect(rejected('EXPIRED', 'FAILED')).toBe(true);
    expect(rejected('CANCELED', 'TIMEOUT')).toBe(true);
  });

  it('aprobación para un cobro que nunca fue al banco → no es idempotente', () => {
    expect(rejected('CREATED', 'AUTHORIZED')).toBe(false);
    expect(rejected('AWAITING_CAPTURE', 'AUTHORIZED')).toBe(false);
  });
});

describe('paymentMachine — la pasarela no pudo abrir el pago (CHECKOUT_FAILED)', () => {
  it('CREATED o AWAITING_CAPTURE → FAILED con el motivo: nunca llegó al banco', () => {
    for (const from of ['CREATED', 'AWAITING_CAPTURE'] as const) {
      const r = applyEvent(from, baseCtx(), { type: 'CHECKOUT_FAILED', reason: 'gateway-authorize-error' });
      expect(r?.nextState).toBe('FAILED');
      expect(r?.nextContext.failureReason).toBe('gateway-authorize-error');
    }
  });

  it('con un intento ya en el banco (AUTHORIZING, ORPHAN) o terminado, no vale', () => {
    for (const from of ['AUTHORIZING', 'ORPHAN', 'AUTHORIZED', 'FAILED', 'EXPIRED', 'CANCELED'] as const) {
      expect(applyEvent(from, baseCtx(), { type: 'CHECKOUT_FAILED', reason: 'x' })).toBeNull();
    }
  });
});

describe('paymentMachine: factura de bitcoin abierta (BTCPAY)', () => {
  const btc = (over: Partial<PaymentContext> = {}) => baseCtx({ provider: 'BTCPAY', providerTxId: 'INV1', ...over });

  it('AUTHORIZING + INVOICE_CLOSED → AWAITING_CAPTURE: el cobro sigue abierto para pagarlo de otra forma', () => {
    const r = applyEvent('AUTHORIZING', btc(), { type: 'INVOICE_CLOSED' });
    expect(r?.nextState).toBe('AWAITING_CAPTURE');
  });

  it('INVOICE_CLOSED solo vale con una factura de bitcoin: con tarjeta no se vuelve atrás', () => {
    expect(applyEvent('AUTHORIZING', baseCtx({ provider: 'REDSYS' }), { type: 'INVOICE_CLOSED' })).toBeNull();
    expect(applyEvent('AUTHORIZING', baseCtx(), { type: 'INVOICE_CLOSED' })).toBeNull();
  });

  it('INVOICE_CLOSED en cualquier otro estado es ilegal', () => {
    for (const s of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZED', 'ORPHAN', 'FAILED', 'CANCELED', 'EXPIRED'] as const) {
      expect(applyEvent(s, btc(), { type: 'INVOICE_CLOSED' }), s).toBeNull();
    }
  });

  it('el personal puede cancelar un cobro con la factura de bitcoin abierta', () => {
    const r = applyEvent('AUTHORIZING', btc(), { type: 'CANCELED', reason: 'user-canceled', byUserId: 'u1' });
    expect(r?.nextState).toBe('CANCELED');
  });

  it('con tarjeta (cliente en su banco) un cobro AUTHORIZING también se cancela (decisión del dueño)', () => {
    for (const provider of ['REDSYS', 'PAYTEF', 'PEANPE', 'WIPAY'] as const) {
      expect(applyEvent('AUTHORIZING', baseCtx({ provider }), { type: 'CANCELED', reason: 'user-canceled', byUserId: 'u2' })?.nextState).toBe('CANCELED');
    }
  });

  it('el bitcoin que llega a un cobro cancelado no se da por pagado: no es idempotente (queda en Incidencias)', () => {
    const err = new InvalidTransitionError('CANCELED', 'AUTHORIZED');
    expect(isIdempotentTransition(err)).toBe(false);
  });

  it('AUTHORIZING + AUTHORIZED con BTCPAY guarda proveedor y factura', () => {
    const r = applyEvent('AUTHORIZING', btc(), { type: 'AUTHORIZED', providerTxId: 'INV1', provider: 'BTCPAY' });
    expect(r?.nextState).toBe('AUTHORIZED');
    expect(r?.nextContext).toMatchObject({ provider: 'BTCPAY', providerTxId: 'INV1' });
  });
});

describe('paymentMachine: el banco cobra después de cancelar', () => {
  const approval = { type: 'AUTHORIZED', providerTxId: 'TX9', provider: 'REDSYS' } as const;

  it('el aviso del banco no lo saca de CANCELED (ni se da por procesado: queda en Incidencias)', () => {
    expect(applyEvent('CANCELED', baseCtx({ provider: 'REDSYS' }), approval)).toBeNull();
    expect(isIdempotentTransition(new InvalidTransitionError('CANCELED', 'AUTHORIZED'))).toBe(false);
  });

  it('«Dar por bueno» (con la marca) lo pasa a AUTHORIZED con su pedido; desde otro estado la marca no cambia nada', () => {
    const r = applyEvent('CANCELED', baseCtx({ provider: 'REDSYS' }), { ...approval, acceptedAfterCancel: true });
    expect(r?.nextState).toBe('AUTHORIZED');
    expect(r?.nextContext).toMatchObject({ provider: 'REDSYS', providerTxId: 'TX9' });
    expect(applyEvent('EXPIRED', baseCtx(), { ...approval, acceptedAfterCancel: true })).toBeNull();
  });

  it('CANCELED sigue sin aceptar nada más (ni otro cancelar, ni caducar, ni devolver)', () => {
    for (const e of [{ type: 'CANCELED' }, { type: 'TIMEOUT' }, { type: 'FAILED', reason: 'x' }, { type: 'REFUND_PARTIAL', amountCents: 100 }] as const) {
      expect(applyEvent('CANCELED', baseCtx(), e)).toBeNull();
    }
  });
});
