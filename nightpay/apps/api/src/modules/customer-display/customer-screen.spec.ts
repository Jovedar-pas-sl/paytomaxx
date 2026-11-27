import { describe, it, expect } from 'vitest';
import { displayKey, screenViewOf, type ScreenCharge, type ScreenInput, type ScreenPayment } from './customer-screen';

const NOW = new Date('2026-11-17T23:00:00Z');
const LATER = new Date(NOW.getTime() + 5 * 60_000);
const EARLIER = new Date(NOW.getTime() - 60_000);
const URLS = { api: 'https://api.oxio.test', client: 'https://api.oxio.test', operator: 'https://operator.oxio.test' };
const PAY_ID = '7d0f4f9e-0000-4000-8000-000000000001';
const CHARGE_ID = '7d0f4f9e-0000-4000-8000-000000000002';

function card(over: Partial<ScreenPayment> = {}): ScreenPayment {
  return {
    id: PAY_ID,
    status: 'CREATED',
    amountCents: 3300,
    serviceFeeCents: 0,
    currency: 'EUR',
    qrToken: 'tok-qr-123',
    qrExpiresAt: LATER,
    captureMethod: null,
    walletId: null,
    tipCents: 0,
    tipGoesTo: null,
    ...over,
  };
}

function saldo(over: Partial<ScreenCharge> = {}): ScreenCharge {
  return { id: CHARGE_ID, status: 'PENDING', amountCents: 3300, expiresAt: LATER, payToken: null, tipCents: 0, ...over };
}

function input(over: Partial<ScreenInput> = {}): ScreenInput {
  return {
    venueName: 'Sala Luna',
    fichas: true,
    message: { line1: null, line2: null },
    pairedUntil: new Date(NOW.getTime() + 12 * 3600_000),
    payment: null,
    charge: null,
    cleared: false,
    now: NOW,
    urls: URLS,
    tip: { on: true, presets: {}, creatorRole: 'WAITER', chosenCents: 0 },
    pinKeypad: 'fixed',
    noPinMaxCents: 2000,
    ...over,
  };
}

describe('pantalla del cliente: qué enseña', () => {
  it('sin cobro: reposo con el nombre del local, si cobra con ficha y el mensaje del local', () => {
    expect(screenViewOf(input())).toEqual({
      state: 'idle',
      venueName: 'Sala Luna',
      fichas: true,
      message: { line1: null, line2: null },
      pairedUntil: '2026-11-18T11:00:00.000Z',
    });
    const message = { line1: '2x1 en copas hasta la 1', line2: 'Sábado: fiesta blanca' };
    expect(screenViewOf(input({ message }))).toMatchObject({ state: 'idle', message });
    // También con un cobro delante: la tablet lo tiene para cuando vuelva al reposo.
    expect(screenViewOf(input({ message, payment: card() }))).toMatchObject({ state: 'waiting', message });
  });

  it('cobro único esperando: importe, el mismo QR que el camarero y la ficha', () => {
    const view = screenViewOf(input({ payment: card(), charge: saldo() }));
    expect(view).toMatchObject({
      state: 'waiting',
      amountCents: 3300,
      cardAmountCents: null,
      qrUrl: 'https://api.oxio.test/pay/tok-qr-123',
      ficha: true,
      paying: false,
      topUp: false,
      key: displayKey(PAY_ID, CHARGE_ID),
    });
  });

  it('con «Comisión del servicio»: lo que paga la tarjeta aparte', () => {
    const view = screenViewOf(input({ payment: card({ serviceFeeCents: 330 }), charge: saldo() }));
    expect(view).toMatchObject({ state: 'waiting', amountCents: 3300, cardAmountCents: 3630 });
  });

  it('sin fichas en el local o sin cobro del saldo: sin «acerca tu ficha»', () => {
    expect(screenViewOf(input({ fichas: false, payment: card(), charge: saldo() }))).toMatchObject({ ficha: false });
    expect(screenViewOf(input({ payment: card() }))).toMatchObject({ ficha: false });
  });

  it('solo saldo (sin tarjeta): el QR del saldo suelto', () => {
    const view = screenViewOf(input({ charge: saldo({ payToken: 'pt/1' }) }));
    expect(view).toMatchObject({ state: 'waiting', qrUrl: 'https://api.oxio.test/s/pt%2F1', ficha: true, amountCents: 3300 });
  });

  it('recarga de recepción: su importe y su QR', () => {
    expect(screenViewOf(input({ payment: card({ walletId: 'w1', amountCents: 5000 }) }))).toMatchObject({
      state: 'waiting',
      topUp: true,
      amountCents: 5000,
      ficha: false,
    });
  });

  it('el cliente ya está en su banco: sin QR, «terminando el pago»', () => {
    for (const status of ['AUTHORIZING', 'ORPHAN']) {
      expect(screenViewOf(input({ payment: card({ status }), charge: saldo() }))).toMatchObject({
        state: 'waiting',
        paying: true,
        qrUrl: null,
      });
    }
  });

  it('con datáfono: sin QR (el del datáfono es para el camarero) y sin comisión aparte', () => {
    expect(
      screenViewOf(input({ payment: card({ captureMethod: 'POS_EXTERNAL', serviceFeeCents: 200 }) })),
    ).toMatchObject({ state: 'waiting', qrUrl: null, cardAmountCents: null });
  });

  it('«Pagado» con tarjeta o con la ficha (la tarjeta se cancela sola)', () => {
    expect(screenViewOf(input({ payment: card({ status: 'AUTHORIZED' }), charge: saldo({ status: 'CANCELED' }) }))).toMatchObject({
      state: 'paid',
    });
    expect(screenViewOf(input({ payment: card({ status: 'CANCELED' }), charge: saldo({ status: 'ACCEPTED' }) }))).toMatchObject({
      state: 'paid',
    });
    // Ya salió de ese cobro: el «Pagado» se sigue enseñando (la tablet decide cuánto).
    expect(screenViewOf(input({ payment: card({ status: 'AUTHORIZED' }), cleared: true }))).toMatchObject({ state: 'paid' });
  });

  it('sin pagar: cancelado, caducado o fallido', () => {
    expect(screenViewOf(input({ payment: card({ status: 'CANCELED' }), charge: saldo({ status: 'CANCELED' }) }))).toMatchObject({
      state: 'ended',
      reason: 'canceled',
    });
    expect(screenViewOf(input({ payment: card({ status: 'EXPIRED' }) }))).toMatchObject({ state: 'ended', reason: 'expired' });
    expect(screenViewOf(input({ payment: card({ status: 'FAILED' }) }))).toMatchObject({ state: 'ended', reason: 'failed' });
    // El QR caducó y la tarea aún no lo marcó.
    expect(screenViewOf(input({ payment: card({ qrExpiresAt: EARLIER }) }))).toMatchObject({ state: 'ended', reason: 'expired' });
    expect(screenViewOf(input({ charge: saldo({ status: 'REJECTED' }) }))).toMatchObject({ state: 'ended', reason: 'failed' });
    expect(screenViewOf(input({ charge: saldo({ expiresAt: EARLIER }) }))).toMatchObject({ state: 'ended', reason: 'expired' });
  });

  it('el camarero salió de un cobro sin pagar: reposo (no se deja un QR suelto)', () => {
    expect(screenViewOf(input({ payment: card(), charge: saldo(), cleared: true }))).toMatchObject({ state: 'idle' });
  });

  it('nunca lleva datos personales ni ids: solo lo de la lista', () => {
    const views = [
      screenViewOf(input()),
      screenViewOf(input({ payment: card({ serviceFeeCents: 100 }), charge: saldo() })),
      screenViewOf(input({ payment: card({ status: 'AUTHORIZED' }) })),
      screenViewOf(input({ payment: card({ status: 'CANCELED' }) })),
    ];
    const allowed = new Set([
      // `message`: el texto que el local escribe para su reposo (nada del cliente ni del personal).
      'state', 'venueName', 'fichas', 'message', 'pairedUntil', 'key', 'currency', 'amountCents', 'totalCents', 'cardAmountCents',
      'qrUrl', 'tip', 'pinKeypad', 'noPinMaxCents', 'ficha', 'paying', 'topUp', 'reason',
      // Lo pagado en el «Pagado» (idea 70): un importe, nada de nadie.
      'paidCents',
    ]);
    for (const view of views) {
      for (const field of Object.keys(view)) expect(allowed.has(field), field).toBe(true);
      expect(JSON.stringify(view)).not.toContain(PAY_ID);
      expect(JSON.stringify(view)).not.toContain(CHARGE_ID);
    }
  });

  it('la clave del cobro es estable y distinta para cada cobro', () => {
    expect(displayKey(PAY_ID, CHARGE_ID)).toBe(displayKey(PAY_ID, CHARGE_ID));
    expect(displayKey(PAY_ID, null)).not.toBe(displayKey(PAY_ID, CHARGE_ID));
    expect(displayKey(PAY_ID, null)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('propina: las sugeridas de siempre, sin nada marcado; la elegida va al total y al QR, nunca a la comisión', () => {
    const none = screenViewOf(input({ payment: card({ serviceFeeCents: 330 }), charge: saldo() }));
    expect(none).toMatchObject({
      totalCents: 3300,
      cardAmountCents: 3630,
      tip: { presets: [{ cents: 200, percent: null }, { cents: 500, percent: null }], maxCents: 3300, chosenCents: 0 },
    });
    const chosen = screenViewOf(
      input({ payment: card({ serviceFeeCents: 330 }), charge: saldo(), tip: { on: true, presets: {}, creatorRole: 'OPERATOR', chosenCents: 500 } }),
    );
    // 33 € + 3,30 € de comisión (sobre los 33) + 5 € de propina.
    expect(chosen).toMatchObject({ totalCents: 3800, cardAmountCents: 4130, tip: { chosenCents: 500, toStaff: true } });
    expect(chosen.state === 'waiting' ? chosen.qrUrl : null).toBe('https://api.oxio.test/pay/tok-qr-123?tip=500');
    // Por encima de 40 €, los porcentajes del local.
    const big = screenViewOf(
      input({ payment: card({ amountCents: 10000 }), tip: { on: true, presets: { percents: [10] }, creatorRole: 'WAITER', chosenCents: 0 } }),
    );
    expect(big).toMatchObject({ tip: { presets: [{ cents: 1000, percent: 10 }] } });
  });

  it('«Otra»: euros enteros hasta el tope (como en /pay); céntimos sueltos o de más no cuentan', () => {
    const other = (chosenCents: number) =>
      screenViewOf(input({ payment: card(), tip: { on: true, presets: {}, creatorRole: 'WAITER', chosenCents } }));
    expect(other(700)).toMatchObject({ totalCents: 4000, tip: { chosenCents: 700 }, qrUrl: 'https://api.oxio.test/pay/tok-qr-123?tip=700' });
    expect(other(3300)).toMatchObject({ totalCents: 6600 });
    for (const bad of [750, 3400]) expect(other(bad)).toMatchObject({ totalCents: 3300, tip: { chosenCents: 0 } });
  });

  it('sin propinas, en una recarga o con datáfono: sin propina', () => {
    expect(screenViewOf(input({ payment: card(), tip: { on: false, presets: {}, creatorRole: 'WAITER', chosenCents: 0 } }))).toMatchObject({
      tip: null,
    });
    expect(screenViewOf(input({ payment: card({ walletId: 'w1' }) }))).toMatchObject({ tip: null });
    expect(screenViewOf(input({ payment: card({ captureMethod: 'POS_EXTERNAL' }) }))).toMatchObject({ tip: null });
  });

  it('solo saldo con propina: el QR del saldo la lleva (?tip=) y el total la suma', () => {
    const view = screenViewOf(input({ charge: saldo({ payToken: 'pt1' }), tip: { on: true, presets: {}, creatorRole: 'WAITER', chosenCents: 200 } }));
    expect(view).toMatchObject({ qrUrl: 'https://api.oxio.test/s/pt1?tip=200', totalCents: 3500, pinKeypad: 'fixed' });
  });
});

describe('pantalla del cliente: el «Pagado» lleva lo pagado (idea 70)', () => {
  it('con tarjeta: lo vendido + la comisión + la propina', () => {
    const view = screenViewOf(input({ payment: card({ status: 'AUTHORIZED', serviceFeeCents: 330, tipCents: 300 }), charge: saldo({ status: 'CANCELED' }) }));
    expect(view).toMatchObject({ state: 'paid', paidCents: 3930 });
  });

  it('con la ficha: lo vendido + la propina (sin comisión, aunque el cobro con tarjeta la tuviera)', () => {
    const view = screenViewOf(
      input({ payment: card({ status: 'CANCELED', serviceFeeCents: 330 }), charge: saldo({ status: 'ACCEPTED', tipCents: 200 }) }),
    );
    expect(view).toMatchObject({ state: 'paid', paidCents: 3500 });
    expect(screenViewOf(input({ charge: saldo({ status: 'ACCEPTED' }) }))).toMatchObject({ state: 'paid', paidCents: 3300 });
  });
});

describe('pantalla del cliente: a quién va la propina (idea 66)', () => {
  const tipTo = (over: Partial<ScreenInput>) => {
    const view = screenViewOf(input(over));
    return view.state === 'waiting' ? view.tip?.toStaff : undefined;
  };
  const tip = (creatorRole: string | null, served = false) => ({ on: true, presets: {}, creatorRole, served, chosenCents: 0 });

  it('con tarjeta, la del cobro (tipGoesTo), como en /pay', () => {
    expect(tipTo({ payment: card({ tipGoesTo: 'operator' }), tip: tip('OPERATOR') })).toBe(true);
    expect(tipTo({ payment: card({ tipGoesTo: 'venue' }), tip: tip('OPERATOR') })).toBe(false);
    expect(tipTo({ payment: card({ tipGoesTo: 'beneficiary' }), tip: tip('WAITER') })).toBe(true);
    expect(tipTo({ payment: card({ tipGoesTo: 'operator' }), tip: tip('WAITER') })).toBe(false);
    // «shared» (nadie lo usa hoy): cuenta como del local.
    expect(tipTo({ payment: card({ tipGoesTo: 'shared' }), tip: tip('OPERATOR') })).toBe(false);
  });

  it('sin regla en el cobro o solo saldo: la de quien cobra (una chica: para ella; si no, del local)', () => {
    expect(tipTo({ payment: card(), tip: tip('OPERATOR') })).toBe(true);
    expect(tipTo({ payment: card(), tip: tip('WAITER') })).toBe(false);
    expect(tipTo({ charge: saldo(), tip: tip('OPERATOR') })).toBe(true);
    expect(tipTo({ charge: saldo(), tip: tip('MANAGER') })).toBe(false);
  });

  it('cobrado por el encargado a nombre de una compañera: para ella (como en /pay)', () => {
    expect(tipTo({ payment: card(), tip: tip('MANAGER', true) })).toBe(true);
    expect(tipTo({ charge: saldo(), tip: tip('MANAGER', true) })).toBe(true);
  });
});
