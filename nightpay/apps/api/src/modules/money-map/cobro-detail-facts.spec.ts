import { describe, expect, it } from 'vitest';
import { paymentDetailFacts, saldoDetailFacts, sharesOf, type PaymentDetailInput, type SaldoDetailInput } from './cobro-detail-facts';
import type { PersonLike } from './cobros-rows';

const PAY = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const REQ = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const CARLOS = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03';
const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const JAVI = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d06';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00.000Z`);

const people = new Map<string, PersonLike>([
  [CARLOS, { id: CARLOS, displayName: 'Carlos Pérez', email: 'carlos@bambu.es', role: 'WAITER' }],
  [LOLA, { id: LOLA, displayName: 'Lola', email: 'lola@bambu.es', role: 'OPERATOR' }],
  [JAVI, { id: JAVI, displayName: null, email: 'javi@bambu.es', role: 'MANAGER' }],
]);

function card(over: Partial<PaymentDetailInput['payment']> = {}): PaymentDetailInput {
  return {
    venueName: 'Sala Bambú (Madrid)',
    people,
    earnings: [],
    audits: [],
    panelBase: 'https://admin.paytomaxx.com',
    payment: {
      id: PAY,
      tenantId: 'a1a1a1a1-0000-4000-8000-000000000001',
      ref: 24,
      createdAt: at('00:20'),
      updatedAt: at('01:00'),
      amountCents: 4500,
      tipCents: 300,
      serviceFeeCents: 450,
      availableAmountCents: 4250,
      currency: 'EUR',
      status: 'PARTIALLY_REFUNDED',
      provider: 'REDSYS',
      providerTxId: '1108A6B2',
      captureMethod: null,
      revenueCategory: 'VENUE_BAR',
      serviceName: '2× Copa',
      walletId: null,
      posOperationNumber: null,
      authCode: '123456',
      cardLast4: '4242',
      cardBrand: '1',
      cardType: 'D',
      cardCountry: '826',
      secure3ds: false,
      payMethodCode: 'C',
      tokenizationData: { identifier: 'tok-x', expiry: '2812' },
      authorizedAt: at('00:23'),
      platformCommissionBps: 1000,
      idempotencyKey: 'k-1',
      createdByUserId: CARLOS,
      attempts: [
        { providerTxId: '1108A6B1', status: 'DENIED', createdAt: at('00:21'), amountCents: 4750, tipCents: 300, payMethod: 'card' },
        { providerTxId: '1108A6B2', status: 'APPROVED', createdAt: at('00:22'), amountCents: 4750, tipCents: 300, payMethod: 'wallet' },
      ],
      terminal: { externalId: 'T-1', label: 'Barra' },
      createdBy: people.get(CARLOS)!,
      wallet: null,
      lines: [{ category: 'VENUE_BAR', label: 'Copa', qty: 2, unitCents: 2250, amountCents: 4500, serviceItemId: null }],
      events: [
        { eventType: 'payment.created', payload: { amountCents: 4500 }, occurredAt: at('00:20') },
        {
          eventType: 'payment.device',
          payload: { who: 'staff', step: 'create', userId: CARLOS, model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', mobile: true, inApp: null, ip: '10.0.0.7' },
          occurredAt: at('00:20'),
        },
        {
          eventType: 'payment.device',
          payload: { who: 'client', step: 'card', attemptId: 'x', model: 'SM-S918B', os: 'Android', osVersion: '14', browser: 'Chrome 130', mobile: true, inApp: null, ipErased: true },
          occurredAt: at('00:22'),
        },
        { eventType: 'payment.authorized', payload: { providerTxId: '1108A6B2' }, occurredAt: at('00:23') },
      ],
      refunds: [
        {
          id: 'r-1',
          amountCents: 1000,
          reason: ' Copa derramada ',
          requestedBy: JAVI,
          status: 'SUCCEEDED',
          createdAt: at('01:00'),
          registeredManually: false,
          bankRefundedAt: null,
          serviceFeeCents: 100,
        },
      ],
      ...over,
    },
  };
}

describe('detalle de un cobro con tarjeta', () => {
  it('lo básico: qué, cuándo, dónde, quién, cómo (con los 4 últimos), el código y lo pagado', () => {
    const f = paymentDetailFacts(card());
    expect(f.base).toMatchObject({
      kind: 'PAYMENT',
      ref: 'C-0024',
      confirmationCode: 'A6B',
      status: 'PARTIALLY_REFUNDED',
      paidAt: '2026-11-08T00:23:00.000Z',
      venueName: 'Sala Bambú (Madrid)',
      sections: [{ category: 'VENUE_BAR', amountCents: 4500 }],
      amountCents: 4500,
      tipCents: 300,
      serviceFeeCents: 450,
      totalCents: 5250,
      method: { method: 'MOBILE_WALLET', cardBrand: 'Visa', cardLast4: '4242', via: 'QR', fichaNumber: null },
    });
    expect(f.chargedBy).toEqual({ name: 'Carlos Pérez', displayName: 'Carlos Pérez', role: 'WAITER' });
    expect(f.panelUrl).toBe('https://admin.paytomaxx.com/?s=hoy&t=cobros&ref=C-0024');
  });

  it('devuelto en parte: quién, cuándo y por qué', () => {
    expect(paymentDetailFacts(card()).base.undo).toEqual([
      { kind: 'REFUND', at: '2026-11-08T01:00:00.000Z', amountCents: 1000, by: 'javi@bambu.es', reason: 'Copa derramada', status: 'SUCCEEDED' },
    ]);
  });

  it('el reparto: lo vendido, lo devuelto sin la comisión, OxioPay (comisión neta y su %), el personal y el local', () => {
    const f = paymentDetailFacts(
      card({}),
    );
    const withShares = paymentDetailFacts({
      ...card(),
      earnings: [{ operatorId: CARLOS, commissionCents: 0, tipCents: 300, reversedCents: 0, paymentLineId: null, debtCents: 0 }],
    });
    // Devueltos 10 €: 1 € era comisión del servicio; 9 € de lo vendido (4.800).
    expect(f.split).toMatchObject({ soldCents: 4800, refundedCents: 900, oxioPay: { serviceFeeCents: 350 } });
    // El % de OxioPay sobre lo que se queda del importe (45 € − 6 € = 39 €): 3,90 €.
    expect(f.split?.oxioPay.platformCents).toBe(390);
    expect(f.split?.venueCents).toBe(4800 - 900 - 390);
    expect(withShares.split?.venueCents).toBe(4800 - 900 - 300 - 390);
  });

  it('lo del banco: el pedido aprobado, la autorización, 3DS y el país; señales sin 3DS y tarjeta de fuera', () => {
    const f = paymentDetailFacts(card());
    expect(f.bank).toEqual({ authCode: '123456', secure3ds: false, cardCountry: '826', provider: 'REDSYS', bankOrder: '1108A6B2' });
    expect(f.flags).toEqual(['NO_3DS', 'FOREIGN_CARD']);
    expect(paymentDetailFacts(card({ cardCountry: '724', secure3ds: true })).flags).toEqual([]);
  });

  it('lo delicado: la tarjeta más allá de los 4 últimos, los dispositivos (la IP borrada se dice) y el historial sin ellos', () => {
    const f = paymentDetailFacts(card());
    expect(f.card).toEqual({ type: 'D', payMethodCode: 'C', expiry: '2812', tokenized: true });
    expect(f.devices.map((d) => [d.who, d.step, d.label, d.ip, d.ipErased, d.personName])).toEqual([
      ['staff', 'create', 'iPhone · iOS 18 · Safari 18', '10.0.0.7', false, 'Carlos Pérez'],
      ['client', 'card', 'SM-S918B · Android 14 · Chrome 130', null, true, null],
    ]);
    const whats = f.history.map((h) => h.what);
    expect(whats).toEqual([
      'Cobro creado',
      'Intento de pago con tarjeta: denegado',
      'Intento de pago con Apple Pay / Google Pay: aprobado',
      'Pagado',
      'Devolución pedida',
    ]);
  });

  it('cancelado sin pagar: quién lo canceló', () => {
    const f = paymentDetailFacts(
      card({
        status: 'CANCELED',
        authorizedAt: null,
        refunds: [],
        events: [{ eventType: 'payment.canceled', payload: { type: 'CANCELED', reason: 'user-canceled', byUserId: LOLA }, occurredAt: at('00:25') }],
      }),
    );
    expect(f.base.undo).toEqual([{ kind: 'CANCEL', at: '2026-11-08T00:25:00.000Z', amountCents: null, by: 'Lola', reason: null, status: null }]);
    expect(f.split?.venueCents).toBe(0);
  });

  it('una recarga: no es venta (sin reparto) y trae el saldo antes y después', () => {
    const f = paymentDetailFacts(
      card({
        walletId: WALLET,
        wallet: { id: WALLET, shortCode: 'K7Q4M2' },
        status: 'AUTHORIZED',
        refunds: [],
        events: [{ eventType: 'payment.wallet_credited', payload: { balanceBeforeCents: 1200, balanceAfterCents: 5700 }, occurredAt: at('00:23') }],
      }),
    );
    expect(f.base).toMatchObject({ isTopUp: true, sections: [], method: { walletHint: 'K7Q-•••', via: null } });
    expect(f.split).toBeNull();
    expect(f.balance).toEqual({ beforeCents: 1200, afterCents: 5700 });
  });
});

function saldo(over: Partial<SaldoDetailInput> = {}): SaldoDetailInput {
  return {
    request: {
      id: REQ,
      tenantId: 'a1a1a1a1-0000-4000-8000-000000000001',
      ref: 31,
      createdAt: at('02:00'),
      amountCents: 6000,
      category: 'CHICA_SERVICE',
      serviceName: 'Masaje 30 min',
      status: 'ACCEPTED',
      requestedByUserId: LOLA,
      linkedPaymentId: null,
      tipCents: 0,
      decidedAt: at('02:01'),
    },
    consumption: {
      amountCents: 6000,
      tipCents: 500,
      reversedAt: null,
      reversedByUserId: null,
      notes: 'Masaje 30 min',
      authMethod: 'nfc_nopin',
      platformCommissionBps: 1000,
      serviceFeeSaldoCents: 0,
    },
    wallet: { id: WALLET, shortCode: 'K7Q4M2' },
    lines: [],
    linkedEvents: [],
    people,
    earnings: [{ operatorId: LOLA, commissionCents: 5400, tipCents: 500, reversedCents: 0, paymentLineId: null, debtCents: 0 }],
    audits: [
      {
        action: 'wallet.charge_settled',
        actorId: LOLA,
        payload: { who: 'staff', step: 'saldo', userId: LOLA, authMethod: 'nfc_nopin', balanceBeforeCents: 10000, balanceAfterCents: 3500, model: 'iPhone', os: 'iOS', osVersion: '18' },
        occurredAt: at('02:01'),
      },
    ],
    fichaNumber: '00736903',
    venueName: 'Sala Bambú (Madrid)',
    venuePlatformBps: 1000,
    panelBase: null,
    ...over,
  };
}

describe('detalle de un cobro del saldo', () => {
  it('pagado con la ficha en la pantalla de la barra: el detalle y el historial lo dicen', () => {
    const settled = {
      action: 'wallet.charge_settled',
      actorId: LOLA,
      payload: { who: 'staff', step: 'saldo', screen: true, userId: LOLA, authMethod: 'pin', pinVia: 'ficha', balanceBeforeCents: 10000, balanceAfterCents: 3500 },
      occurredAt: at('02:01'),
    };
    const f = saldoDetailFacts(saldo({ consumption: { ...saldo().consumption!, authMethod: 'pin' }, audits: [settled] }));
    expect(f.base.method.via).toBe('PIN · desde la pantalla de Lola');
    expect(f.history.find((h) => h.what.startsWith('Pagado'))?.what).toBe('Pagado con ficha desde la pantalla de Lola');
    // Sin la marca (el móvil del personal), como siempre.
    expect(saldoDetailFacts(saldo()).history.find((h) => h.what.startsWith('Pagado'))?.what).toBe('Pagado con el saldo');
  });

  it('pagado con el NFC sin PIN: la ficha, la señal, el saldo antes y después y lo de la chica', () => {
    const f = saldoDetailFacts(saldo());
    expect(f.base).toMatchObject({
      kind: 'SALDO',
      ref: 'C-0031',
      confirmationCode: null,
      status: 'ACCEPTED',
      totalCents: 6500,
      method: { method: 'SALDO', label: 'Saldo K7Q-•••', fichaNumber: '00736903', via: 'NFC sin PIN', walletHint: 'K7Q-•••' },
    });
    expect(f.flags).toEqual(['NFC_NO_PIN']);
    expect(f.balance).toEqual({ beforeCents: 10000, afterCents: 3500 });
    expect(f.shares).toEqual([
      { personId: LOLA, name: 'Lola', role: 'OPERATOR', commissionCents: 5400, tipCents: 500, invitationCents: 0, reversedCents: 0, totalCents: 5900 },
    ]);
    // Del saldo suelto el dispositivo va al registro, sin IP.
    expect(f.devices.map((d) => [d.who, d.step, d.ip])).toEqual([['staff', 'saldo', null]]);
    expect(f.bank).toBeNull();
    expect(f.card).toBeNull();
  });

  it('con PIN: la ficha solo si se dijo con ella (con el código, no)', () => {
    const conCodigo = saldo({
      consumption: { ...saldo().consumption!, authMethod: 'pin' },
      audits: [{ action: 'wallet.charge_settled', actorId: LOLA, payload: { who: 'staff', step: 'saldo', pinVia: 'código' }, occurredAt: at('02:01') }],
    });
    expect(saldoDetailFacts(conCodigo).base.method.fichaNumber).toBeNull();
    const conFicha = saldo({
      consumption: { ...saldo().consumption!, authMethod: 'pin' },
      audits: [{ action: 'wallet.charge_settled', actorId: LOLA, payload: { who: 'staff', step: 'saldo', pinVia: 'ficha' }, occurredAt: at('02:01') }],
    });
    expect(saldoDetailFacts(conFicha).base.method.fichaNumber).toBe('00736903');
  });

  it('anulado: quién, cuándo y el motivo (de las notas del consumo); estado REVERSED y la deuda en lo de la chica', () => {
    const f = saldoDetailFacts(
      saldo({
        consumption: { ...saldo().consumption!, reversedAt: at('03:00'), reversedByUserId: JAVI, notes: 'Masaje 30 min\n[REVERSED: No se hizo el servicio]' },
        earnings: [{ operatorId: LOLA, commissionCents: 5400, tipCents: 500, reversedCents: 5400, paymentLineId: null, debtCents: 500 }],
      }),
    );
    expect(f.base.status).toBe('REVERSED');
    expect(f.base.undo).toEqual([
      { kind: 'VOID', at: '2026-11-08T03:00:00.000Z', amountCents: 6500, by: 'javi@bambu.es', reason: 'No se hizo el servicio', status: null },
    ]);
    expect(f.shares[0]?.totalCents).toBe(0);
    expect(f.split).toMatchObject({ refundedCents: 6500, venueCents: 0 });
  });

  it('cobro único: el código del cobro con tarjeta, y los dispositivos de su evento (con IP)', () => {
    const f = saldoDetailFacts(
      saldo({
        request: { ...saldo().request, linkedPaymentId: PAY },
        audits: [],
        linkedEvents: [
          {
            eventType: 'payment.device',
            payload: { who: 'staff', step: 'create', userId: LOLA, walletChargeId: REQ, model: 'iPhone', ip: '10.0.0.7' },
            occurredAt: at('02:00'),
          },
          {
            eventType: 'payment.device',
            payload: { who: 'client', step: 'saldo', walletChargeId: REQ, authMethod: 'passkey', model: 'iPhone', ip: '83.45.120.7', balanceBeforeCents: 9000, balanceAfterCents: 2500 },
            occurredAt: at('02:01'),
          },
        ],
        consumption: { ...saldo().consumption!, authMethod: 'passkey' },
      }),
    );
    expect(f.base.confirmationCode).toBe('A6B');
    expect(f.base.method).toMatchObject({ via: 'Face ID', fichaNumber: null });
    expect(f.balance).toEqual({ beforeCents: 9000, afterCents: 2500 });
    expect(f.devices.map((d) => [d.who, d.step, d.ip])).toEqual([
      ['staff', 'create', '10.0.0.7'],
      ['client', 'saldo', '83.45.120.7'],
    ]);
  });

  it('alguien intentó pagarlo con una copia de la ficha: la señal', () => {
    const f = saldoDetailFacts(
      saldo({
        audits: [...saldo().audits, { action: 'wallet.card_copy_suspected', actorId: null, payload: { cardId: 'c', requestId: REQ }, occurredAt: at('02:00') }],
      }),
    );
    expect(f.flags).toContain('CARD_COPY_SUSPECTED');
    expect(f.history.map((h) => h.what)).toContain('Intentaron pagar con una copia de la ficha');
  });
});

describe('lo de cada persona', () => {
  it('la comisión o la parte de la invitación, la propina y lo descontado (también lo que ya debe)', () => {
    expect(
      sharesOf(
        [
          { operatorId: LOLA, commissionCents: 1000, tipCents: 0, reversedCents: 0, paymentLineId: 'line-1', debtCents: 0 },
          { operatorId: CARLOS, commissionCents: 200, tipCents: 100, reversedCents: 50, paymentLineId: null, debtCents: 25 },
        ],
        people,
      ),
    ).toEqual([
      { personId: LOLA, name: 'Lola', role: 'OPERATOR', commissionCents: 0, tipCents: 0, invitationCents: 1000, reversedCents: 0, totalCents: 1000 },
      { personId: CARLOS, name: 'Carlos Pérez', role: 'WAITER', commissionCents: 200, tipCents: 100, invitationCents: 0, reversedCents: 75, totalCents: 225 },
    ]);
  });
});
