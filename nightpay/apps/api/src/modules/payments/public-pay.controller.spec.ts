import { afterEach, describe, it, expect, vi } from 'vitest';
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

function fakeReply(cookie?: string) {
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
    request: { headers: cookie ? { cookie } : {} },
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
  directWallet?: string;
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
  const settings: Record<string, string | undefined> = {
    PAY_STATEMENT_NAME: opts.statementName,
    PAY_DIRECT_WALLET: opts.directWallet,
  };
  const config = { get: vi.fn((key: string) => settings[key]) };
  return { controller: new PublicPayController(payments as never, config as never, {} as never, {} as never), payments };
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
    attemptStatus: 'PENDING',
    ...overrides,
  };
}

const CHOOSE: PayRedirect = {
  kind: 'choose',
  amountCents: 10_000,
  currency: 'EUR',
  tipOptionsCents: [0, 1_000, 1_500],
  tipMaxCents: 10_000,
  tipCents: 0,
  qrExpiresAt: new Date(Date.now() + 4 * 60_000),
};

/** El «Pagado» lima (recién pagado) o gris (enlace ya pagado). */
const PAID_FRESH = 'class="paid" id="paid"';
const PAID_STALE = 'class="paid stale" id="paid"';
const scripts = (html: string): string[] =>
  html.split('<script>').slice(1).map((part) => part.slice(0, part.indexOf('</script>')));

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /pay/result — el "Pagado" ya no se puede falsificar', () => {
  it('sin pedido conocido nunca dice "Pagado"', async () => {
    const { controller } = makeController({ view: null });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('inventado', 'es', undefined, reply);
    expect(sent.body).toContain('No encontramos este pago');
    expect(sent.body).not.toContain('class="paid');
    // No se sabe si se cobró: no se dice «No se te ha cobrado nada».
    expect(sent.body).not.toContain('No se te ha cobrado nada');
  });

  it('pago aún sin aviso del banco → "Comprobando", aunque la URL diga status=ok', async () => {
    const { controller } = makeController({ view: view({ status: 'AUTHORIZING' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).toContain('http-equiv="refresh"');
    expect(sent.body).toContain('url=/pay/result?op=a1b2c3d4e5f6&amp;lang=es');
    expect(sent.body).not.toContain('class="paid');
  });

  it('pago confirmado → «Pagado» a pantalla completa: total, «hace 0:12», reloj, código y justificante', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T08:15:14Z'));
    const MINE = 'p'.repeat(43);
    const { controller } = makeController({
      view: view({
        status: 'AUTHORIZED',
        tipCents: 500,
        authorizedAt: new Date('2026-10-13T08:15:02Z'),
        approvedClaimHash: createHash('sha256').update(MINE).digest('hex'),
      }),
    });
    // El navegador que pagó (su cookie del intento aprobado).
    const { reply, sent } = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${MINE}`);
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    const html = sent.body!;
    expect(html).toContain(PAID_FRESH);
    expect(html).toContain('aria-live="polite">Pagado</h1>');
    expect(html).toContain('6,00');
    expect(html).toContain('Incluye 5,00');
    expect(html).toContain('A6B');
    expect(html).toContain('hace 0:12');
    // Hora del banco y reloj con segundos (hora de Madrid).
    expect(html).toContain('10:15');
    expect(html).toContain('10:15:14');
    expect(html).toContain(`data-at="${Date.parse('2026-10-13T08:15:02Z')}"`);
    expect(html).toContain('href="/pay/qr-token-1/receipt?lang=es"');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    // La pantalla no se apaga y una captura vieja no se mueve.
    const js = scripts(html).join('\n');
    expect(js).toContain("navigator.wakeLock.request('screen')");
    expect(js).toContain('visibilitychange');
    expect(html).toContain('class="band"');
    expect(html).toContain('prefers-reduced-motion');
    for (const s of scripts(html)) expect(() => new Function(s)).not.toThrow();
  });

  it('recién pagado pero en OTRO navegador (enlace reenviado, sin la cookie del pago) → «Ya pagado» en gris', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T08:15:14Z'));
    const approvedClaimHash = createHash('sha256').update('p'.repeat(43)).digest('hex');
    const paid = { status: 'AUTHORIZED' as const, authorizedAt: new Date('2026-10-13T08:15:02Z'), approvedClaimHash };
    const result = makeController({ view: view(paid) });
    const other = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${'o'.repeat(43)}`);
    await result.controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, other.reply);
    expect(other.sent.body).toContain(PAID_STALE);
    expect(other.sent.body).toContain('aria-live="polite">Ya pagado</h1>');
    // Lo mismo al abrir /pay/:token pagado.
    const page = makeController({
      page: {
        kind: 'paid',
        paymentId: PAYMENT_ID,
        amountCents: 100,
        tipCents: 0,
        currency: 'EUR',
        authorizedAt: paid.authorizedAt,
        walletToken: null,
        walletClaimHash: null,
        walletCode: null,
        walletHasFaceId: false,
        walletHasPin: false,
        approvedClaimHash,
      },
    });
    const fresh = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${'p'.repeat(43)}`);
    await page.controller.payPage('qr-token-1', 'es', undefined, IPHONE, fresh.reply);
    expect(fresh.sent.body).toContain(PAID_FRESH);
    const forwarded = fakeReply();
    await page.controller.payPage('qr-token-1', 'es', undefined, IPHONE, forwarded.reply);
    expect(forwarded.sent.body).toContain(PAID_STALE);
  });

  it('«Ya pagado»: abrir otra vez un enlace pagado hace rato → gris, «hace 23 min» y «No es un pago nuevo»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T08:38:02Z'));
    const { controller } = makeController({
      view: view({ status: 'AUTHORIZED', authorizedAt: new Date('2026-10-13T08:15:02Z') }),
    });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain(PAID_STALE);
    expect(sent.body).toContain('aria-live="polite">Ya pagado</h1>');
    expect(sent.body).toContain('hace 23 min');
    expect(sent.body).toContain('No es un pago nuevo');
    expect(sent.body).not.toContain(PAID_FRESH);
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
    expect(payer.sent.body).toContain('Ver mi saldo');

    // La chica abre el mismo QR en su móvil (hasta pulsó "Pagar" y tiene su
    // propia cookie): "Pagado", pero sin el enlace del saldo.
    const staff = fakeReply(`otra=1; ${name}=${'b'.repeat(43)}`);
    await makeController({ view: paid }).controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, staff.reply);
    expect(staff.sent.body).toContain('class="paid');
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
    // Sin hora de autorización no se puede decir que sea de ahora: «Already paid».
    expect(sent.body).toContain('aria-live="polite">Already paid</h1>');
  });

  it('intento denegado → qué pasó, «No se te ha cobrado nada» y UNA acción: otro método', async () => {
    const { controller } = makeController({ view: view({ attemptStatus: 'DENIED' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('El banco no ha aceptado el pago');
    expect(sent.body).toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es"');
    expect(sent.body).toContain('Probar con otro método');
    expect(sent.body).not.toContain('class="hint"');
  });

  it('pago sin confirmar (ORPHAN) → no dice "Pagado" ni que no se cobró', async () => {
    const { controller } = makeController({ view: view({ status: 'ORPHAN' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain('Sin confirmación del banco');
    expect(sent.body).not.toContain('class="paid');
    expect(sent.body).not.toContain('No se te ha cobrado nada');
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
    expect(sent.body).toContain('value="1000"');
    expect(sent.body).toContain('method="POST" action="/pay/qr-token-1"');
    expect(payments.startCheckout).not.toHaveBeenCalled();
    for (const s of scripts(sent.body!)) expect(() => new Function(s)).not.toThrow();
  });

  it('cobro único: «Pagar con mi saldo OxioCard» lleva al mismo cobro en /s (Face ID); sin saldo enlazado, no sale', async () => {
    const { controller } = makeController({ page: { ...CHOOSE, saldoPayToken: 'pay-tok_123' } as PayRedirect });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('href="/s/pay-tok_123?lang=es"');
    expect(sent.body).toContain('Pagar con mi saldo OxioCard');
    const plain = fakeReply();
    await makeController({ page: CHOOSE }).controller.payPage('qr-token-1', 'en', undefined, IPHONE, plain.reply);
    expect(plain.sent.body).not.toContain('/s/');
    const en = fakeReply();
    await makeController({ page: { ...CHOOSE, saldoPayToken: 'pay-tok_123' } as PayRedirect }).controller.payPage(
      'qr-token-1',
      'en',
      undefined,
      IPHONE,
      en.reply,
    );
    expect(en.sent.body).toContain('Pay with my OxioCard balance');
  });

  it('cobro único ya pagado con el saldo: «Ya está pagado con tu saldo», sin «No se te ha cobrado nada»', async () => {
    const { controller } = makeController({ page: { kind: 'closed', reason: 'paid-with-saldo' } });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('Ya está pagado con tu saldo');
    expect(sent.body).not.toContain('No se te ha cobrado nada');
  });

  it('iPhone: un solo «Pagar 100 €» que abre Apple Pay (Redsys solo cartera), sin botón de Apple hecho a mano, y «Pagar con tarjeta»', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const html = sent.body!;
    expect(html).not.toContain('Pagar con Apple Pay');
    expect(html).not.toContain('Pagar con Google Pay');
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toMatch(/<button class="btn" id="payBtn" type="submit">Pagar 100\s€<\/button>/);
    expect(html).toContain('<input type="hidden" name="method" value="wallet">');
    expect(html).toContain('Se abre Apple Pay');
    expect(html).toContain('<button class="link" id="cardBtn" type="button">Pagar con tarjeta</button>');
    // El botón dice lo que hace mientras envía (no solo se apaga).
    expect(html).toContain('Enviando…');
  });

  it('PAY_DIRECT_WALLET=false (BBVA sin xpay): en el iPhone un solo botón hacia el banco, sin «Pagar con tarjeta»', async () => {
    const { controller } = makeController({ page: CHOOSE, directWallet: 'false' });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const html = sent.body!;
    expect(html).toContain('<input type="hidden" name="method" value="">');
    expect(html).toContain('Apple Pay · Google Pay · tarjeta');
    expect(html).not.toContain('id="cardBtn"');
    expect(html).not.toContain('Se abre Apple Pay');
  });

  it('ordenador: el botón deja elegir en Redsys (sin método) y no hay «Pagar con tarjeta»', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', reply);
    const html = sent.body!;
    expect(html).toContain('<input type="hidden" name="method" value="">');
    expect(html).toContain('Apple Pay · Google Pay · tarjeta');
    expect(html).not.toContain('id="cardBtn"');
  });

  it('«Sin propina» marcada por defecto, aunque el cobro traiga una propina del local', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, tipOptionsCents: [0, 300, 1_000, 1_500], tipCents: 300 } as PayRedirect,
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const checked = sent.body!.match(/<input type="radio" name="tip" value="(\d+)" checked>/g) ?? [];
    expect(checked).toEqual(['<input type="radio" name="tip" value="0" checked>']);
    expect(sent.body).toContain('value="300"');
  });

  it('propinas según el importe: hasta 40 € +2 € y +5 €; por encima 10 % y 15 %; y «Otra» hasta el máximo', async () => {
    const small = makeController({
      page: { ...CHOOSE, amountCents: 2_000, tipOptionsCents: [0, 200, 500], tipMaxCents: 2_000 } as PayRedirect,
    });
    const s = fakeReply();
    await small.controller.payPage('qr-token-1', 'es', undefined, IPHONE, s.reply);
    expect(s.sent.body).toMatch(/value="200"><span><b class="num">\+2\s€<\/b>/);
    expect(s.sent.body).toMatch(/value="500"><span><b class="num">\+5\s€<\/b>/);
    expect(s.sent.body).toMatch(/Como mucho 20\s€/);

    const big = makeController({
      page: { ...CHOOSE, amountCents: 6_500, tipOptionsCents: [0, 700, 1_000], tipMaxCents: 6_500 } as PayRedirect,
    });
    const b = fakeReply();
    await big.controller.payPage('qr-token-1', 'es', undefined, IPHONE, b.reply);
    expect(b.sent.body).toMatch(/value="700"><span><b>10\s%<\/b><small class="num">\+7\s€<\/small>/);
    expect(b.sent.body).toMatch(/value="1000"><span><b>15\s%<\/b><small class="num">\+10\s€<\/small>/);
    // «Otra» necesita JS: empieza oculta.
    expect(b.sent.body).toContain('<label id="otherOpt" hidden><input type="radio" name="tip" value="0" id="otherRadio">');
    expect(b.sent.body).toContain('id="otherIn" type="text" inputmode="numeric"');
    expect(b.sent.body).toMatch(/Como mucho 65\s€/);
  });

  it('«Va entera para el personal» solo si la propina va a una persona', async () => {
    const toStaff = makeController({ page: { ...CHOOSE, tipToStaff: true } as PayRedirect });
    const a = fakeReply();
    await toStaff.controller.payPage('qr-token-1', 'es', undefined, IPHONE, a.reply);
    expect(a.sent.body).toContain('Va entera para el personal');

    const toVenue = makeController({ page: { ...CHOOSE, tipToStaff: false } as PayRedirect });
    const b = fakeReply();
    await toVenue.controller.payPage('qr-token-1', 'es', undefined, IPHONE, b.reply);
    expect(b.sent.body).not.toContain('Va entera para el personal');
  });

  it('sin propina posible (recarga, otra pasarela) → ni propinas ni «Otra»', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, tipOptionsCents: [0], tipMaxCents: 0 } as PayRedirect,
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('<input type="hidden" name="tip" value="0">');
    expect(sent.body).not.toContain('Sin propina');
    expect(sent.body).not.toContain('id="otherRadio"');
  });

  it('cabecera de confianza, de arriba abajo: local, importe, concepto y extracto', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, venueName: 'Luna', concept: 'Copa' } as PayRedirect,
      statementName: 'MAXX SERVICIOS',
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const html = sent.body!;
    const at = (s: string): number => html.indexOf(s);
    expect(at('class="venue">Luna<')).toBeGreaterThan(-1);
    expect(at('class="venue">Luna<')).toBeLessThan(at('class="amount num"'));
    expect(at('class="amount num"')).toBeLessThan(at('class="concept">Copa<'));
    expect(at('class="concept">Copa<')).toBeLessThan(at('En tu extracto'));
    expect(at('En tu extracto')).toBeLessThan(at('<form'));
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
    expect(sent.body).toContain('Pay €100');
    expect(sent.body).toContain('Opens Apple Pay');
    expect(sent.body).toContain('Pay by card');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es"');
  });

  it('enseña el nombre del extracto si está configurado', async () => {
    const { controller } = makeController({ page: CHOOSE, statementName: 'MAXX SERVICIOS' });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('En tu extracto: «MAXX SERVICIOS»');
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
    expect(sent.body).toContain('class="paid');
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
    expect(sent.body).toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('Pide uno nuevo al personal');
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

  it('PAY_DIRECT_WALLET=false y una página vieja que aún pide Apple Pay → al banco sin preferencia', async () => {
    const wallet = makeController({ checkout: FORM, directWallet: 'false' });
    await wallet.controller.startCheckout('qr-token-1', { tip: '0', method: 'wallet', lang: 'es' }, undefined, fakeReply().reply);
    expect(wallet.payments.startCheckout).toHaveBeenCalledWith('qr-token-1', expect.objectContaining({ method: null }));
    const card = makeController({ checkout: FORM, directWallet: 'false' });
    await card.controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, fakeReply().reply);
    expect(card.payments.startCheckout).toHaveBeenCalledWith('qr-token-1', expect.objectContaining({ method: 'card' }));
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
    // Plantilla de error: qué pasó, que no se cobró nada y UNA acción (volver a intentarlo).
    expect(sent.body).toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es">Intentar otra vez</a>');
    expect(sent.body).not.toContain('class="hint"');
  });

  it('cobro en curso → no dice que no se cobró; una acción: comprobar otra vez', async () => {
    const { controller } = makeController({ checkout: new ConflictException('Payment already in progress') });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.body).toContain('Este cobro ya se está procesando');
    expect(sent.body).not.toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('Comprobar otra vez');
  });

  it('formulario manipulado → aviso con una sola indicación (sin botón de vuelta)', async () => {
    const { controller } = makeController({ checkout: { kind: 'checkout', order: 'X' } });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: 'abc' }, undefined, reply);
    expect(sent.status).toBe(400);
    expect(sent.body).toContain('class="hint"');
    expect(sent.body).not.toContain('class="btn"');
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

describe('«Recargar» desde /w: tras pagar, de vuelta al saldo (solo el navegador que la empezó)', () => {
  const RETURN = 'r'.repeat(43);
  const returnHash = createHash('sha256').update(RETURN).digest('hex');
  const name = walletClaimCookieName('', 'qr-token-1');

  it('vuelta del banco pagada → 303 a /w con el «Pagado» de esa recarga', async () => {
    const paid = view({ status: 'AUTHORIZED', walletReturnToken: 'wal tok', walletClaimHash: returnHash });
    const { reply, sent } = fakeReply(`${name}=${RETURN}`);
    await makeController({ view: paid }).controller.paymentResult('ORD-1', 'en', undefined, reply);
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe('/w/wal%20tok?lang=en&pagado=qr-token-1');
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });

  it('otro navegador (alguien a quien pasaron el enlace de pago) → «Pagado» sin el saldo', async () => {
    const paid = view({ status: 'AUTHORIZED', walletReturnToken: 'wal-tok', walletClaimHash: returnHash });
    for (const cookie of [undefined, `${name}=${'x'.repeat(43)}`]) {
      const { reply, sent } = fakeReply(cookie);
      await makeController({ view: paid }).controller.paymentResult('ORD-1', 'es', undefined, reply);
      expect(sent.status).toBe(200);
      expect(sent.body).toContain('class="paid');
      expect(sent.body).not.toContain('wal-tok');
    }
  });

  it('aún sin aviso del banco → «Comprobando» (no vuelve todavía); denegado → reintentar en /pay', async () => {
    const pending = view({ status: 'AUTHORIZING', walletReturnToken: 'wal-tok', walletClaimHash: returnHash });
    const a = fakeReply(`${name}=${RETURN}`);
    await makeController({ view: pending }).controller.paymentResult('ORD-1', 'es', undefined, a.reply);
    expect(a.sent.status).toBe(200);
    expect(a.sent.body).not.toContain('wal-tok');
    const denied = view({ status: 'AUTHORIZING', attemptStatus: 'DENIED', walletReturnToken: 'wal-tok', walletClaimHash: returnHash });
    const b = fakeReply(`${name}=${RETURN}`);
    await makeController({ view: denied }).controller.paymentResult('ORD-1', 'es', undefined, b.reply);
    expect(b.sent.body).toContain('href="/pay/qr-token-1?lang=es"');
  });

  it('abrir el enlace de pago ya pagado: el navegador que la empezó vuelve a /w; otro ve solo «Pagado»', async () => {
    const page: PayRedirect = {
      kind: 'paid',
      paymentId: PAYMENT_ID,
      amountCents: 5_000,
      tipCents: 0,
      currency: 'EUR',
      authorizedAt: new Date(),
      walletToken: null,
      walletClaimHash: returnHash,
      walletCode: null,
      walletHasFaceId: false,
      walletHasPin: false,
      walletReturnToken: 'wal-tok',
    };
    const mine = fakeReply(`${name}=${RETURN}`);
    await makeController({ page }).controller.payPage('qr-token-1', 'es', undefined, IPHONE, mine.reply);
    expect(mine.sent.status).toBe(303);
    expect(mine.sent.headers.Location).toBe('/w/wal-tok?lang=es&pagado=qr-token-1');
    const other = fakeReply();
    await makeController({ page }).controller.payPage('qr-token-1', 'es', undefined, IPHONE, other.reply);
    expect(other.sent.status).toBe(200);
    expect(other.sent.body).toContain('class="paid');
    expect(other.sent.body).not.toContain('wal-tok');
    // Ni el aviso de «tu saldo se abre en el móvil con el que pagaste»: no es su saldo.
    expect(other.sent.body).not.toContain('pide en el local un enlace nuevo');
  });

  it('pagar el enlace usa la cookie de vuelta que dejó /w (el intento lleva su huella)', async () => {
    const { controller, payments } = makeController({ checkout: { kind: 'checkout', order: 'ORD-9' } });
    const { reply } = fakeReply(`${name}=${RETURN}`);
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'wallet', lang: 'es' }, undefined, reply);
    expect(payments.startCheckout).toHaveBeenCalledWith('qr-token-1', expect.objectContaining({ claimHash: returnHash }));
  });
});
