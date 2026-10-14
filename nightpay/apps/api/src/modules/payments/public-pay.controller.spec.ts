import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { ConflictException } from '@nestjs/common';
import { PublicPayController, walletClaimCookieName } from './public-pay.controller';
import type { PayReceiptView, PayRedirect, PayResultView } from './pay-redirect';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54';

function fakeReply(cookie?: string, query: Record<string, string> = {}) {
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
    request: { headers: cookie ? { cookie } : {}, query },
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return reply;
    },
    send(body?: string) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

function makeController(opts: {
  view?: PayResultView | null;
  page?: PayRedirect;
  checkout?: PayRedirect | Error;
  receipt?: PayReceiptView | null;
  checkoutForm?: PayRedirect | null;
  statementName?: string;
}) {
  const payments = {
    getResultView: vi.fn().mockResolvedValue(opts.view ?? null),
    getPayPage: vi.fn().mockResolvedValue(opts.page),
    startCheckout:
      opts.checkout instanceof Error
        ? vi.fn().mockRejectedValue(opts.checkout)
        : vi.fn().mockResolvedValue(opts.checkout),
    getReceipt: vi.fn().mockResolvedValue(opts.receipt ?? null),
    getCheckoutForm: vi.fn().mockResolvedValue(opts.checkoutForm ?? null),
  };
  const config = { get: vi.fn().mockReturnValue(opts.statementName) };
  const charges = { setPinByWalletToken: vi.fn().mockResolvedValue(undefined) };
  return { controller: new PublicPayController(payments as never, config as never, charges as never), payments, charges };
}

function view(overrides: Partial<PayResultView>): PayResultView {
  return {
    paymentId: PAYMENT_ID,
    status: 'AUTHORIZING',
    amountCents: 100,
    tipCents: 0,
    currency: 'EUR',
    authorizedAt: null,
    qrToken: 'qr-token-1',
    walletToken: null,
    walletClaimHash: null,
    walletCode: null,
    walletHasPin: false,
    attemptStatus: 'PENDING',
    ...overrides,
  };
}

const CHOOSE: PayRedirect = {
  kind: 'choose',
  amountCents: 10_000,
  currency: 'EUR',
  tipOptionsCents: [0, 500, 1000],
  tipCents: 0,
  qrExpiresAt: new Date(Date.now() + 4 * 60_000),
};

describe('GET /pay/result — el "Pagado" ya no se puede falsificar', () => {
  it('sin pedido conocido nunca dice "Pagado"', async () => {
    const { controller } = makeController({ view: null });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('inventado', 'es', undefined, reply);
    expect(sent.body).toContain('No encontramos este pago');
    expect(sent.body).not.toContain('<h1>Pagado</h1>');
  });

  it('pago aún sin aviso del banco → "Comprobando", aunque la URL diga status=ok', async () => {
    const { controller } = makeController({ view: view({ status: 'AUTHORIZING' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).toContain('http-equiv="refresh"');
    expect(sent.body).toContain('url=/pay/result?op=a1b2c3d4e5f6&amp;lang=es');
    expect(sent.body).not.toContain('<h1>Pagado</h1>');
  });

  it('pago confirmado → "Pagado" con total, código, hora y justificante', async () => {
    const { controller } = makeController({
      view: view({ status: 'AUTHORIZED', tipCents: 500, authorizedAt: new Date('2026-10-13T08:15:02Z') }),
    });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('<h1>Pagado</h1>');
    expect(sent.body).toContain('6,00');
    expect(sent.body).toContain('Incluye 5,00');
    expect(sent.body).toContain('A6B');
    expect(sent.body).toContain('10:15');
    expect(sent.body).toContain('href="/pay/qr-token-1/receipt?lang=es"');
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });

  it('recarga de saldo pagada → botón para abrir el saldo, solo en el móvil que pagó', async () => {
    const PAYER = 'a'.repeat(43);
    const paid = view({
      status: 'AUTHORIZED',
      walletToken: 'wal-tok',
      walletClaimHash: createHash('sha256').update(PAYER).digest('hex'),
    });
    const name = walletClaimCookieName('', 'qr-token-1');

    const payer = fakeReply(`otra=1; ${name}=${PAYER}`);
    await makeController({ view: paid }).controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, payer.reply);
    expect(payer.sent.body).toContain('href="/w/wal-tok?lang=es"');
    expect(payer.sent.body).toContain('Abrir mi saldo');

    // La chica abre el mismo QR en su móvil (hasta pulsó "Pagar" y tiene su
    // propia cookie): "Pagado", pero sin el enlace del saldo.
    const staff = fakeReply(`otra=1; ${name}=${'b'.repeat(43)}`);
    await makeController({ view: paid }).controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, staff.reply);
    expect(staff.sent.body).toContain('<h1>Pagado</h1>');
    expect(staff.sent.body).not.toContain('/w/wal-tok');
    // …y si es el cliente en otro navegador, sabe qué hacer.
    expect(staff.sent.body).toContain('pide en el local un enlace nuevo');
    expect(payer.sent.body).not.toContain('pide en el local un enlace nuevo');
  });

  it('vuelta del banco en inglés', async () => {
    const { controller } = makeController({ view: view({ status: 'AUTHORIZED' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'en', undefined, reply);
    expect(sent.body).toContain('<html lang="en">');
    expect(sent.body).toContain('<h1>Paid</h1>');
  });

  it('intento denegado → ofrece probar otra vez con el mismo QR', async () => {
    const { controller } = makeController({ view: view({ attemptStatus: 'DENIED' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('El banco no ha aceptado el pago');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es"');
  });

  it('pago sin confirmar (ORPHAN) → no dice "Pagado"', async () => {
    const { controller } = makeController({ view: view({ status: 'ORPHAN' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('Sin confirmación del banco');
  });
});

describe('GET /pay/:token — página de pago', () => {
  it('enseña el importe y las propinas, y no abre nada en el banco', async () => {
    const { controller, payments } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('100,00');
    expect(sent.body).toContain('Sin propina');
    expect(sent.body).toContain('value="500"');
    expect(sent.body).toContain('method="POST" action="/pay/qr-token-1"');
    expect(payments.startCheckout).not.toHaveBeenCalled();
  });

  it('iPhone → "Pagar con Apple Pay" y "Pagar con tarjeta"', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('Pagar con Apple Pay');
    expect(sent.body).toContain('value="wallet"');
    expect(sent.body).toContain('Pagar con tarjeta');
  });

  it('dentro de Instagram → aviso y solo tarjeta', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, INSTAGRAM, reply);
    expect(sent.body).toContain('navegador de Instagram');
    expect(sent.body).not.toContain('value="wallet"');
    expect(sent.body).toContain('value="card"');
  });

  it('móvil en alemán → inglés; con botón para cambiar a español', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', undefined, 'de-DE,de;q=0.9', IPHONE, reply);
    expect(sent.body).toContain('You are paying');
    expect(sent.body).toContain('Pay with Apple Pay');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es"');
  });

  it('enseña el nombre del extracto si está configurado', async () => {
    const { controller } = makeController({ page: CHOOSE, statementName: 'MAXX SERVICIOS' });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('En tu extracto aparecerá como «MAXX SERVICIOS»');
  });

  it('QR ya cobrado → "Pagado", nunca vuelve al banco', async () => {
    const { controller } = makeController({
      page: {
        kind: 'paid',
        paymentId: PAYMENT_ID,
        amountCents: 100,
        tipCents: 0,
        currency: 'EUR',
        authorizedAt: null,
        walletToken: null,
      },
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('<h1>Pagado</h1>');
    expect(sent.body).not.toContain('<form');
  });

  it('cobro en curso → "Comprobando", sin formulario al banco', async () => {
    const { controller } = makeController({ page: { kind: 'processing' } });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).not.toContain('<form');
  });

  it('QR caducado → mensaje claro y 409', async () => {
    const { controller } = makeController({ page: { kind: 'closed', reason: 'expired' } });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(409);
    expect(sent.body).toContain('Este cobro ha caducado');
  });

  it('textos de cliente sin "chica" ni "habitación"', async () => {
    for (const page of [CHOOSE, { kind: 'closed', reason: 'failed' } as PayRedirect]) {
      const { controller } = makeController({ page });
      const { reply, sent } = fakeReply();
      await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
      expect(sent.body?.toLowerCase()).not.toContain('chica');
      expect(sent.body?.toLowerCase()).not.toContain('habitación');
    }
  });
});

describe('POST /pay/:token — el cliente pulsa un botón', () => {
  const FORM: PayRedirect = {
    kind: 'form',
    action: 'https://sis.redsys.es/sis/realizarPago',
    method: 'POST',
    fields: { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'abc', Ds_Signature: 'sig' },
    status: 'AUTHORIZING',
  };

  it('pasa propina, botón e idioma y redirige (303) al formulario del pedido', async () => {
    const { controller, payments } = makeController({ checkout: { kind: 'checkout', order: 'ORD123' } });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '500', method: 'wallet', lang: 'en' }, undefined, reply);
    expect(payments.startCheckout).toHaveBeenCalledWith('qr-token-1', {
      tipCents: 500,
      method: 'wallet',
      language: 'en',
      claimHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe('/pay/qr-token-1/checkout?op=ORD123&lang=en');
    // Este navegador queda marcado con una cookie aleatoria propia; el intento
    // guarda su huella (para enseñarle luego su saldo solo a él).
    const cookie = sent.headers['Set-Cookie']!;
    const value = new RegExp(`${walletClaimCookieName('', 'qr-token-1')}=([A-Za-z0-9_-]{43}); Path=/pay;`).exec(cookie)?.[1];
    expect(value).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    const sentHash = (payments.startCheckout.mock.calls[0]![1] as { claimHash: string }).claimHash;
    expect(sentHash).toBe(createHash('sha256').update(value!).digest('hex'));
  });

  it('el mismo navegador conserva su cookie al volver a pulsar', async () => {
    const MINE = 'c'.repeat(43);
    const { controller, payments } = makeController({ checkout: { kind: 'checkout', order: 'ORD123' } });
    const { reply, sent } = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${MINE}`);
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect((payments.startCheckout.mock.calls[0]![1] as { claimHash: string }).claimHash).toBe(
      createHash('sha256').update(MINE).digest('hex'),
    );
    expect(sent.headers['Set-Cookie']).toContain(`=${MINE}; Path=/pay;`);
  });

  it('pasarela con formulario sin paso intermedio → lo pinta directamente', async () => {
    const { controller } = makeController({ checkout: FORM });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.body).toContain('action="https://sis.redsys.es/sis/realizarPago"');
  });

  it('botón sin preferencia (dispositivo desconocido) → sin método', async () => {
    const { controller, payments } = makeController({ checkout: FORM });
    const { reply } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: '', lang: 'es' }, undefined, reply);
    expect(payments.startCheckout).toHaveBeenCalledWith('qr-token-1', {
      tipCents: 0,
      method: null,
      language: 'es',
      claimHash: expect.any(String),
    });
  });

  it('formulario manipulado → error sin ir al banco', async () => {
    const { controller, payments } = makeController({ checkout: FORM });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '-5', method: 'bizum' }, undefined, reply);
    expect(sent.status).toBe(400);
    expect(payments.startCheckout).not.toHaveBeenCalled();
  });

  it('error del banco → mensaje para el cliente, sin detalles técnicos', async () => {
    const { controller } = makeController({ checkout: new ConflictException('Gateway error: SIS0042 firma') });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.status).toBe(409);
    expect(sent.body).toContain('El banco no responde ahora mismo');
    expect(sent.body).not.toContain('SIS0042');
  });
});

describe('GET /pay/:token/checkout — formulario hacia el banco', () => {
  const FORM: PayRedirect = {
    kind: 'form',
    action: 'https://sis.redsys.es/sis/realizarPago',
    method: 'POST',
    fields: { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'abc', Ds_Signature: 'sig' },
    status: 'AUTHORIZING',
  };

  it('pedido recién abierto → formulario que se envía solo', async () => {
    const { controller, payments } = makeController({ checkoutForm: FORM });
    const { reply, sent } = fakeReply();
    await controller.checkout('qr-token-1', 'ORD123', 'en', undefined, reply);
    expect(payments.getCheckoutForm).toHaveBeenCalledWith('qr-token-1', 'ORD123');
    expect(sent.body).toContain('action="https://sis.redsys.es/sis/realizarPago"');
    expect(sent.body).toContain('Continue to payment');
    // Si el navegador restaura la página al volver atrás, no se reenvía.
    expect(sent.body).toContain('location.replace("/pay/qr-token-1?lang=en")');
  });

  it('volver atrás desde el banco (pedido ya no reciente) → a la página del cobro, sin reenviar', async () => {
    const { controller } = makeController({ checkoutForm: null });
    const { reply, sent } = fakeReply();
    await controller.checkout('qr-token-1', 'ORD123', 'es', undefined, reply);
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe('/pay/qr-token-1?lang=es');
    expect(sent.body).toBeUndefined();
  });
});

describe('GET /pay/:token/receipt — justificante', () => {
  const RECEIPT: PayReceiptView = {
    paymentId: PAYMENT_ID,
    amountCents: 10_000,
    tipCents: 500,
    currency: 'EUR',
    authorizedAt: new Date('2026-10-13T21:41:00Z'),
    authCode: '047215',
    cardBrand: '1',
    payMethod: 'wallet',
    order: '1234ABCD5678',
  };

  it('pagado → importe, propina, total, método y código; sin datos personales', async () => {
    const { controller } = makeController({ receipt: RECEIPT });
    const { reply, sent } = fakeReply();
    await controller.receipt('qr-token-1', 'es', undefined, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('Justificante de pago');
    expect(sent.body).toContain('105,00');
    expect(sent.body).toContain('Apple Pay o Google Pay · Visa');
    expect(sent.body).toContain('047215');
    expect(sent.body).toContain('1234ABCD5678');
    expect(sent.body).toContain('A6B');
    expect(sent.body).toContain('23:41');
  });

  it('no pagado o inexistente → 404', async () => {
    const { controller } = makeController({ receipt: null });
    const { reply, sent } = fakeReply();
    await controller.receipt('qr-token-1', 'es', undefined, reply);
    expect(sent.status).toBe(404);
  });
});

describe('recarga de saldo: el cliente elige su PIN en su propio móvil', () => {
  const PAYER = 'p'.repeat(43);
  const claimCookie = `${walletClaimCookieName('', 'qr-token-1')}=${PAYER}`;
  const paidPage = (o: Partial<Extract<PayRedirect, { kind: 'paid' }>> = {}): PayRedirect => ({
    kind: 'paid',
    paymentId: PAYMENT_ID,
    amountCents: 5000,
    tipCents: 0,
    currency: 'EUR',
    authorizedAt: new Date('2026-10-14T22:00:00Z'),
    walletToken: 'wal-tok',
    walletClaimHash: createHash('sha256').update(PAYER).digest('hex'),
    walletCode: 'K7Q-4M2',
    walletHasPin: false,
    ...o,
  });

  it('"Pagado" en el móvil que pagó: su código y el formulario del PIN', async () => {
    const { controller } = makeController({ page: paidPage() });
    const { reply, sent } = fakeReply(claimCookie);
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('K7Q-4M2');
    expect(sent.body).toContain('action="/pay/qr-token-1/pin"');
    expect(sent.body).toContain('Solo lo sabrás tú');
  });

  it('en otro móvil (la chica con el mismo QR): ni código ni PIN', async () => {
    const { controller } = makeController({ page: paidPage() });
    const { reply, sent } = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${'q'.repeat(43)}`);
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).not.toContain('K7Q-4M2');
    expect(sent.body).not.toContain('/pin"');
  });

  it('guardar el PIN: solo el que pagó, los dos iguales → guardado y vuelve a "Pagado"', async () => {
    const { controller, charges } = makeController({ page: paidPage() });
    const { reply, sent } = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4827', lang: 'es' }, 'https://api.paytomaxx.com', 'api.paytomaxx.com', undefined, reply);
    expect(charges.setPinByWalletToken).toHaveBeenCalledWith('wal-tok', '4827');
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe('/pay/qr-token-1?lang=es&pin=ok');
  });

  it('distintos u obvio → no se guarda y se explica', async () => {
    const { controller, charges } = makeController({ page: paidPage() });
    const a = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4828' }, 'https://h', 'h', undefined, a.reply);
    expect(a.sent.headers.Location).toContain('pin=mismatch');
    const b = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '1111', pin2: '1111' }, 'https://h', 'h', undefined, b.reply);
    expect(b.sent.headers.Location).toContain('pin=obvious');
    expect(charges.setPinByWalletToken).not.toHaveBeenCalled();
    const c = fakeReply(claimCookie, { pin: 'mismatch' });
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, c.reply);
    expect(c.sent.body).toContain('Los dos PIN no son iguales');
  });

  it('otro navegador o un formulario de otra web → 403, no se toca nada', async () => {
    const { controller, charges } = makeController({ page: paidPage() });
    const other = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${'q'.repeat(43)}`);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4827' }, 'https://h', 'h', undefined, other.reply);
    expect(other.sent.status).toBe(403);
    const evil = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4827' }, 'https://evil.example', 'api.paytomaxx.com', undefined, evil.reply);
    expect(evil.sent.status).toBe(403);
    // Sin Origin: solo si el navegador dice que viene de nuestra página.
    const bare = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4827' }, undefined, 'h', undefined, bare.reply);
    expect(bare.sent.status).toBe(403);
    expect(charges.setPinByWalletToken).not.toHaveBeenCalled();
    const sameSite = fakeReply(claimCookie);
    await controller.choosePin('qr-token-1', { pin: '4827', pin2: '4827' }, undefined, 'h', undefined, sameSite.reply, 'same-origin');
    expect(charges.setPinByWalletToken).toHaveBeenCalledTimes(1);
  });

  it('con el PIN ya guardado: "PIN guardado", sin formulario', async () => {
    const { controller } = makeController({ page: paidPage({ walletHasPin: true }) });
    const { reply, sent } = fakeReply(claimCookie, { pin: 'ok' });
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('PIN guardado');
    expect(sent.body).not.toContain('/pin"');
  });
});

