import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PublicPayController, walletClaimCookieName } from './public-pay.controller';
import type { PayReceiptView, PayRedirect, PayResultView } from './pay-redirect';
import type { PayStatusContext } from './pay-status.service';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';

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
  /** El nombre del comercio en la página de Redsys (REDSYS_MERCHANT_NAME). */
  merchantName?: string;
  directWallet?: string;
  /** «Comprobando el pago»: lo que da PayStatusService (sin él, la página de antes). */
  statusCtx?: PayStatusContext | null;
  /** Reservados: el enlace de la reserva del pago. */
  manageToken?: string | null;
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
    reservationManageToken: vi.fn().mockResolvedValue(opts.manageToken ?? null),
  };
  const settings: Record<string, string | undefined> = {
    PAY_STATEMENT_NAME: opts.statementName,
    REDSYS_MERCHANT_NAME: opts.merchantName,
    PAY_DIRECT_WALLET: opts.directWallet,
  };
  const config = { get: vi.fn((key: string) => settings[key]) };
  const redsysReturn = { process: vi.fn().mockResolvedValue('enviado') };
  const status = {
    byToken: vi.fn().mockResolvedValue(opts.statusCtx ?? null),
    byOrder: vi.fn().mockResolvedValue(opts.statusCtx ?? null),
  };
  return {
    controller: new PublicPayController(payments as never, config as never, {} as never, {} as never, redsysReturn as never, status as never),
    payments,
    redsysReturn,
    status,
  };
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
  it('envía los parámetros de vuelta al verificador antes de leer el estado', async () => {
    const { controller, payments, redsysReturn } = makeController({ view: view({ status: 'AUTHORIZING' }) });
    const { reply } = fakeReply();
    const query = { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'abc', Ds_Signature: 'xyz' };
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply, query);
    expect(redsysReturn.process).toHaveBeenCalledWith('a1b2c3d4e5f6', query);
    expect(redsysReturn.process.mock.invocationCallOrder[0]).toBeLessThan(payments.getResultView.mock.invocationCallOrder[0]!);
  });

  it('si falla el guardado conserva la firma para reintentar sin consultar la base', async () => {
    const { controller, payments, redsysReturn } = makeController({ view: view({ status: 'AUTHORIZING' }) });
    redsysReturn.process.mockResolvedValueOnce('error');
    const { reply, sent } = fakeReply();
    const query = { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'a+b/c=', Ds_Signature: 'x+y/z=', extra: 'no-incluir' };
    await controller.paymentResult('2610170002CD', 'es', undefined, reply, query);
    expect(payments.getResultView).not.toHaveBeenCalled();
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).toContain('Ds_MerchantParameters=a%2Bb%2Fc%3D');
    expect(sent.body).toContain('Ds_Signature=x%2By%2Fz%3D');
    expect(sent.body).not.toContain('no-incluir');
    expect(sent.headers['Referrer-Policy']).toBe('no-referrer');
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });

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
    // Sin «,00» (como en el móvil del personal: decisión D4).
    expect(html).toMatch(/data-amount>6\s€</);
    // Su desglose: lo pedido y la propina (con las gracias).
    expect(html).toMatch(/<dt>Propina<\/dt><dd class="num">5\s€<\/dd>/);
    expect(html).toContain('¡Gracias por la propina!');
    // El código, enorme, en su placa, y qué hacer con él.
    expect(html).toContain('<div class="pcode" data-code><span class="plabel">Código de confirmación</span><b class="num">A6B</b><span class="phint">Enséñaselo al personal</span></div>');
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

  it('«Ya pagado»: abrir otra vez un enlace pagado hace 4 min → gris, «hace 4:00» y «No es un pago nuevo»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T08:38:02Z'));
    const { controller } = makeController({
      view: view({ status: 'AUTHORIZED', authorizedAt: new Date('2026-10-13T08:34:02Z') }),
    });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', 'es', undefined, reply);
    expect(sent.body).toContain(PAID_STALE);
    expect(sent.body).toContain('aria-live="polite">Ya pagado</h1>');
    expect(sent.body).toContain('hace 4:00');
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
    // Lo que se cobra va con céntimos, como en una página de pago (las propinas, sin ellos).
    expect(sent.body).toMatch(/<span id="big">100,00\s€<\/span>/);
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
    expect(sent.body).toContain('>Pagar con mi saldo</a>');
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
    expect(en.sent.body).toContain('>Pay with my balance</a>');
  });

  it('cobro único con la propina que pidió al personal: sale ya marcada', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, tipOptionsCents: [0, 500, 1_000, 1_500], tipCents: 500, presetTipCents: 500 } as PayRedirect,
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const checked = sent.body!.match(/<input type="radio" name="tip" value="(\d+)" checked>/g) ?? [];
    expect(checked).toEqual(['<input type="radio" name="tip" value="500" checked>']);
  });

  it('cobro único ya pagado con el saldo: «Ya está pagado con tu saldo», sin «No se te ha cobrado nada»', async () => {
    const { controller } = makeController({ page: { kind: 'closed', reason: 'paid-with-saldo' } });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('Ya está pagado con tu saldo');
    expect(sent.body).not.toContain('No se te ha cobrado nada');
    // Salida (pantalla sin salida): «Ver mi saldo» con Face ID, enseñado al cargar.
    expect(sent.body).toContain('id="npMine"');
    expect(sent.body).toMatch(/^npMineShow[(]true[)];$/m);
    expect(sent.body).toContain('function pkPrepare(');
  });

  it('cobro caducado: sin «Ver mi saldo» (no se pagó con saldo: lo que toca es pedir otro QR)', async () => {
    const { controller } = makeController({ page: { kind: 'closed', reason: 'expired' } });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).not.toContain('id="npMine"');
  });

  it('iPhone: «Pagar 100 €» que abre Apple Pay (Redsys solo cartera) como botón principal, sin botón de Apple hecho a mano, y «Pagar con tarjeta» de segunda opción', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const html = sent.body!;
    expect(html).not.toContain('Pagar con Apple Pay');
    expect(html).not.toContain('Pagar con Google Pay');
    // Dos botones del mismo formulario (funcionan sin JS): el principal y la tarjeta.
    expect(html.match(/type="submit"/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn" id="payBtn" type="submit" name="method" value="wallet"><svg class="ic"[^>]*>.*?<\/svg><span class="lbl">Pagar 100,00\s€<\/span><\/button>/);
    expect(html).toContain('Se abre Apple Pay');
    expect(html).toMatch(/<button class="btn alt" id="cardBtn" type="submit" name="method" value="card"><svg class="ic"[^>]*>.*?<\/svg><span>Pagar con tarjeta<\/span><\/button>/);
    // El de Apple Pay lo pinta Safari, y solo si el móvil puede pagar con Apple Pay.
    expect(html).toContain('-webkit-appearance:-apple-pay-button');
    expect(html).toContain("ApplePaySession.canMakePayments()&&window.CSS&&CSS.supports('-webkit-appearance','-apple-pay-button')");
    // «o» entre la cartera y la tarjeta y, antes de pagar, dónde se escribe la tarjeta (idea 63): el candado, la frase y, debajo, Visa y Mastercard.
    expect(html).toContain('<p class="or" aria-hidden="true">o</p>');
    expect(html).toMatch(
      /<p class="trust"><svg class="ic"[^>]*>.*?<\/svg>La tarjeta la escribes en la página segura del banco, no en OxioPay\.<span class="marks" role="img" aria-label="Visa, Mastercard">/,
    );
    expect(html).not.toContain('<p class="trust">Pago seguro');
    expect(html.indexOf('id="payBtn"')).toBeLessThan(html.indexOf('id="cardBtn"'));
    // El botón dice lo que hace mientras abre el pago (no solo se apaga).
    expect(html).toContain('Abriendo Apple Pay…');
  });

  it('PAY_DIRECT_WALLET=false (BBVA sin xpay): en el iPhone un solo botón hacia el banco, sin «Pagar con tarjeta»', async () => {
    const { controller } = makeController({ page: CHOOSE, directWallet: 'false' });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    const html = sent.body!;
    expect(html).toContain('id="payBtn" type="submit" name="method" value="">');
    expect(html).toContain('Apple Pay · Google Pay · tarjeta');
    expect(html).not.toContain('id="cardBtn"');
    expect(html).not.toContain('Se abre Apple Pay');
  });

  it('ordenador: el botón deja elegir en Redsys (sin método) y no hay «Pagar con tarjeta»', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', reply);
    const html = sent.body!;
    expect(html).toContain('id="payBtn" type="submit" name="method" value="">');
    expect(html).toContain('Apple Pay · Google Pay · tarjeta');
    expect(html).not.toContain('id="cardBtn"');
  });

  it('sin nada marcado (B1: la propina la elige el cliente), aunque el cobro traiga una propina del local', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, tipOptionsCents: [0, 300, 1_000, 1_500], tipCents: 300 } as PayRedirect,
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body!.match(/<input type="radio" name="tip"[^>]* checked>/g) ?? []).toEqual([]);
    expect(sent.body).toContain('value="300"');
    expect(sent.body).toContain('<input type="radio" name="tip" value="0"><span class="word"><span class="sr">Sin propina. ');
  });

  it('«Pagar con mi saldo» lleva la propina que ya eligió aquí (?tip=), solo si eligió una', async () => {
    const { controller } = makeController({
      page: { ...CHOOSE, saldoPayToken: 'saldo-token-123456789' } as PayRedirect,
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain("if(!s.error&&chosen()){try{var u=new URL(sb.getAttribute('href'),location.href);u.searchParams.set('tip',String(s.tip));");
  });

  it('propinas según el importe: hasta 40 € +2 € y +5 €; por encima el 10 % y el 15 %, dichos en euros con su total (idea 66); y «Otra» hasta el máximo', async () => {
    const small = makeController({
      page: { ...CHOOSE, amountCents: 2_000, tipOptionsCents: [0, 200, 500], tipMaxCents: 2_000 } as PayRedirect,
    });
    const s = fakeReply();
    await small.controller.payPage('qr-token-1', 'es', undefined, IPHONE, s.reply);
    expect(s.sent.body).toMatch(/value="200"><span class="num"><span class="sr">Propina de 2\s€\. Total 22,00\s€<\/span><b aria-hidden="true">\+2\s€<\/b><small aria-hidden="true">22,00\s€<\/small><\/span>/);
    expect(s.sent.body).toMatch(/value="500"><span class="num"><span class="sr">Propina de 5\s€\. Total 25,00\s€<\/span><b aria-hidden="true">\+5\s€<\/b>/);
    expect(s.sent.body).toMatch(/Como mucho 20\s€/);

    const big = makeController({
      page: { ...CHOOSE, amountCents: 6_500, tipOptionsCents: [0, 700, 1_000], tipMaxCents: 6_500 } as PayRedirect,
    });
    const b = fakeReply();
    await big.controller.payPage('qr-token-1', 'es', undefined, IPHONE, b.reply);
    expect(b.sent.body).toMatch(/value="700"><span class="num"><span class="sr">Propina de 7\s€\. Total 72,00\s€<\/span><b aria-hidden="true">\+7\s€<\/b><small aria-hidden="true">72,00\s€<\/small>/);
    expect(b.sent.body).toMatch(/value="1000"><span class="num"><span class="sr">Propina de 10\s€\. Total 75,00\s€<\/span><b aria-hidden="true">\+10\s€<\/b>/);
    expect(b.sent.body).not.toMatch(/1[05]\s%/);
    // «Otra» necesita JS: empieza oculta.
    expect(b.sent.body).toContain('<label id="otherOpt" hidden><input type="radio" name="tip" value="0" id="otherRadio">');
    expect(b.sent.body).toContain('id="otherIn" type="text" inputmode="numeric"');
    expect(b.sent.body).toMatch(/Como mucho 65\s€/);
  });

  it('a quién va la propina se dice siempre (idea 66): «Va entera para el personal» si va a una persona; si no, «Es para el local»', async () => {
    const toStaff = makeController({ page: { ...CHOOSE, tipToStaff: true } as PayRedirect });
    const a = fakeReply();
    await toStaff.controller.payPage('qr-token-1', 'es', undefined, IPHONE, a.reply);
    expect(a.sent.body).toContain('<p class="tipnote">Va entera para el personal</p>');
    expect(a.sent.body).not.toContain('Es para el local');

    const toVenue = makeController({ page: { ...CHOOSE, tipToStaff: false } as PayRedirect });
    const b = fakeReply();
    await toVenue.controller.payPage('qr-token-1', 'es', undefined, IPHONE, b.reply);
    expect(b.sent.body).not.toContain('Va entera para el personal');
    expect(b.sent.body).toContain('<p class="tipnote">Es para el local</p>');
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

  it('sin elegir idioma: español siempre (nunca el del móvil), con el selector de los cuatro idiomas arriba', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', undefined, undefined, IPHONE, reply);
    expect(sent.body).toContain('<html lang="es">');
    expect(sent.body).toContain('Pagar 100');
    expect(sent.body).toContain('<details class="lang" id="langMenu"><summary aria-label="Idioma: Español">');
    for (const [l, name] of [['es', 'Español'], ['en', 'English'], ['fr', 'Français'], ['pt', 'Português']]) {
      expect(sent.body).toContain(`<a href="?lang=${l}" lang="${l}" hreflang="${l}" data-lang="${l}"`);
      expect(sent.body).toContain(`>${name}</a>`);
    }
    expect(sent.body).toContain('aria-current="true">Español</a>');
    expect(sent.headers['Set-Cookie']).toBeUndefined();
  });

  it('idea 71: móvil en inglés sin haber elegido idioma → la página en español con la franja «English? · Switch»; conserva ?tip=', async () => {
    const STRIP = '<nav class="sug"';
    const open = async (opts: { accept?: string; lang?: string; cookie?: string; tip?: string; page?: PayRedirect }): Promise<string> => {
      const { controller } = makeController({ page: opts.page ?? { ...CHOOSE, tipOptionsCents: [0, 500, 1_000] } });
      const { reply, sent } = fakeReply();
      await controller.payPage('qr-token-1', opts.lang, opts.cookie, IPHONE, reply, opts.tip, opts.accept);
      return sent.body!;
    };
    const en = await open({ accept: 'en-GB,en;q=0.9' });
    expect(en).toContain('<html lang="es">');
    expect(en).toContain('<a href="?lang=en" lang="en" hreflang="en">English? · Switch</a>');
    expect(en).toContain('<a class="x" href="?lang=es" aria-label="Seguir en español">✕</a>');
    expect(en.indexOf(STRIP)).toBeLessThan(en.indexOf('<header class="top">'));
    // La propina que eligió en la pantalla de la barra no se pierde al cambiar de idioma.
    const tip = await open({ accept: 'en-GB', tip: '500' });
    expect(tip).toContain('<a href="/pay/qr-token-1?tip=500&amp;lang=en" lang="en" hreflang="en">');
    expect(tip).toContain('<a class="x" href="/pay/qr-token-1?tip=500&amp;lang=es"');
    expect(await open({ accept: 'en-GB', tip: '"><script>' })).toContain('<a href="?lang=en" lang="en"');
    // No sale: móvil en español, en un idioma que no tenemos, ya elegido (?lang= o cookie) ni en el «Pagado».
    expect(await open({ accept: 'es-ES,en' })).not.toContain(STRIP);
    expect(await open({ accept: 'de' })).not.toContain(STRIP);
    expect(await open({})).not.toContain(STRIP);
    expect(await open({ accept: 'en-GB', lang: 'es' })).not.toContain(STRIP);
    expect(await open({ accept: 'en-GB', lang: 'en' })).not.toContain(STRIP);
    expect(await open({ accept: 'en-GB', cookie: 'np_lang=es' })).not.toContain(STRIP);
    const paid = await open({
      accept: 'en-GB',
      page: { kind: 'paid', paymentId: PAYMENT_ID, amountCents: 100, tipCents: 0, currency: 'EUR', authorizedAt: new Date(), walletToken: null, walletClaimHash: null, walletCode: null, walletHasFaceId: false, walletHasPin: false },
    });
    expect(paid).toContain('id="paid"');
    expect(paid).not.toContain(STRIP);
    const closed = await open({ accept: 'en-GB', page: { kind: 'closed', reason: 'expired' } });
    expect(closed).not.toContain(STRIP);
  });

  it('el idioma elegido se recuerda en la cookie y vale sin ?lang (también un QR nuevo)', async () => {
    const { controller } = makeController({ page: CHOOSE });
    const chosen = fakeReply();
    await controller.payPage('qr-token-1', 'fr', undefined, IPHONE, chosen.reply);
    expect(chosen.sent.body).toContain('<html lang="fr">');
    expect(chosen.sent.body).toMatch(/Payer 100,00\s€/);
    expect(chosen.sent.body).toContain('Apple Pay va s’ouvrir');
    expect(chosen.sent.body).toContain('Payer par carte');
    expect(chosen.sent.headers['Set-Cookie']).toMatch(/^np_lang=fr; Path=\/; Max-Age=43200; SameSite=Lax/);
    const later = fakeReply();
    await controller.payPage('qr-token-2', undefined, 'np_lang=pt', IPHONE, later.reply);
    expect(later.sent.body).toContain('<html lang="pt">');
    expect(later.sent.body).toContain('Pagar com cartão');
    expect(later.sent.headers['Set-Cookie']).toBeUndefined();
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

  it('fallo pasajero de la pasarela (GATEWAY_RETRY) → «el banco no responde» y «Intentar otra vez»', async () => {
    const { controller } = makeController({
      checkout: new ConflictException({ message: 'No se pudo abrir el pago en la pasarela.', code: 'GATEWAY_RETRY' }),
    });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.status).toBe(409);
    expect(sent.body).toContain('El banco no responde ahora mismo');
    expect(sent.body).toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('href="/pay/qr-token-1?lang=es">Intentar otra vez</a>');
  });

  it('fallo definitivo (GATEWAY_FAILED, el cobro quedó FAILED) → no ofrece reintentar: pedir uno nuevo al personal', async () => {
    for (const lang of ['es', 'en'] as const) {
      const { controller } = makeController({
        checkout: new ConflictException({ message: 'No se pudo abrir el pago. Pide un cobro nuevo al personal.', code: 'GATEWAY_FAILED' }),
      });
      const { reply, sent } = fakeReply();
      await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang }, undefined, reply);
      expect(sent.status).toBe(409);
      expect(sent.body).not.toContain('class="btn"');
      expect(sent.body).not.toContain('Intentar otra vez');
      expect(sent.body).not.toContain('Try again');
      expect(sent.body).not.toContain('El banco no responde');
      expect(sent.body).toContain('class="hint"');
      expect(sent.body).toContain(lang === 'es' ? 'Pide uno nuevo al personal.' : 'Ask the staff for a new one.');
      // Nunca llegó al banco: aquí sí es verdad que no se cobró nada.
      expect(sent.body).toContain(lang === 'es' ? 'No se te ha cobrado nada' : 'You have not been charged');
    }
  });

  it('fallo definitivo al abrir OTRO intento (GATEWAY_FAILED_AFTER_ATTEMPT) → sin reintentar y sin decir que no se cobró', async () => {
    const { controller } = makeController({
      checkout: new ConflictException({ message: 'x', code: 'GATEWAY_FAILED_AFTER_ATTEMPT' }),
    });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.body).not.toContain('class="btn"');
    expect(sent.body).not.toContain('No se te ha cobrado nada');
    expect(sent.body).toContain('Pide un cobro nuevo al personal.');
    expect(sent.body).toContain('enséñaselo al personal');
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

describe('la base sin conexión libre (P2028/P2024): «Hay mucha gente pagando a la vez», no un error (carga del 19-11-2026)', () => {
  const busy = (code = 'P2028') =>
    new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', { code, clientVersion: 'x' });

  it('GET /pay/:token → 503 que se vuelve a cargar sola, en su idioma', async () => {
    for (const [lang, text] of [['es', 'Hay mucha gente pagando a la vez'], ['en', 'Lots of people are paying at once']] as const) {
      const { controller, payments } = makeController({ page: CHOOSE });
      payments.getPayPage.mockRejectedValueOnce(busy());
      const { reply, sent } = fakeReply();
      await controller.payPage('qr-token-1', lang, undefined, IPHONE, reply);
      expect(sent.status).toBe(503);
      expect(sent.headers['Retry-After']).toBe('5');
      expect(sent.body).toContain(text);
      expect(sent.body).toContain(`content="5;url=/pay/qr-token-1?lang=${lang}"`);
      expect(sent.body).not.toContain('Unable to start');
    }
  });

  it('POST /pay/:token → la misma espera; al recargarse vuelve a la página de pago (nunca repite el POST)', async () => {
    const { controller } = makeController({ checkout: busy('P2024') });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.status).toBe(503);
    expect(sent.body).toContain('Hay mucha gente pagando a la vez');
    expect(sent.body).toContain('content="5;url=/pay/qr-token-1?lang=es"');
    // No dice «no se te ha cobrado nada»: no lo sabemos.
    expect(sent.body).not.toContain('No se te ha cobrado nada');
  });

  it('otros errores de la base siguen siendo la página de error de siempre', async () => {
    const { controller } = makeController({
      checkout: new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
    });
    const { reply, sent } = fakeReply();
    await controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, reply);
    expect(sent.status).toBe(409);
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

  it('avisa del salto al banco (idea 63): «Te llevamos a la página segura del banco», cómo saldrá el cargo, y se envía cuando ya está pintado', async () => {
    const { controller } = makeController({ checkoutForm: FORM, statementName: 'SALA AURORA MADRID' });
    const { reply, sent } = fakeReply();
    await controller.checkout('qr-token-1', 'ORD123', 'es', undefined, reply);
    const html = sent.body!;
    expect(html).toContain('<h1 role="status">Te llevamos a la página segura del banco</h1>');
    expect(html).toContain('<p>El cargo saldrá como «SALA AURORA MADRID».</p>');
    // La pestaña y el botón, como antes.
    expect(html).toContain('<title>Abriendo el pago…</title>');
    expect(html).toContain('<button class="btn" type="submit">Continuar al pago</button>');
    // Sin tiempo fijo: dos fotogramas después de pintar el aviso (un requestAnimationFrame dentro de otro).
    expect(html).not.toContain('setTimeout');
    expect(html).toContain("requestAnimationFrame(function(){requestAnimationFrame(function(){document.getElementById('f').submit();});});");
    for (const s of scripts(html)) expect(() => new Function(s)).not.toThrow();
    // En los cuatro idiomas, con el nombre tal cual.
    for (const [lang, title] of [['en', 'Taking you to the bank’s secure page'], ['fr', 'Nous vous emmenons sur la page sécurisée de la banque'], ['pt', 'Vai para a página segura do banco']] as const) {
      const other = fakeReply();
      await makeController({ checkoutForm: FORM, statementName: 'SALA AURORA MADRID' }).controller.checkout('qr-token-1', 'ORD123', lang, undefined, other.reply);
      expect(other.sent.body).toContain(`<h1 role="status">${title}</h1>`);
      expect(other.sent.body).toContain('SALA AURORA MADRID');
    }
  });

  it('el nombre del cargo: el del extracto o, sin él, el del comercio en Redsys; sin ninguno, el aviso sin esa línea (y se escapa)', async () => {
    const merchant = fakeReply();
    await makeController({ checkoutForm: FORM, merchantName: 'AURORA <b>SL</b>' }).controller.checkout('qr-token-1', 'ORD123', 'es', undefined, merchant.reply);
    expect(merchant.sent.body).toContain('<p>El cargo saldrá como «AURORA &lt;b&gt;SL&lt;/b&gt;».</p>');
    const none = fakeReply();
    await makeController({ checkoutForm: FORM }).controller.checkout('qr-token-1', 'ORD123', 'es', undefined, none.reply);
    expect(none.sent.body).toContain('<h1 role="status">Te llevamos a la página segura del banco</h1>');
    expect(none.sent.body).not.toContain('El cargo saldrá como');
    // La pasarela que da el formulario sin paso intermedio (POST): el mismo aviso.
    const direct = fakeReply();
    await makeController({ checkout: FORM, statementName: 'SALA AURORA MADRID' }).controller.startCheckout('qr-token-1', { tip: '0', method: 'card', lang: 'es' }, undefined, direct.reply);
    expect(direct.sent.body).toContain('<p>El cargo saldrá como «SALA AURORA MADRID».</p>');
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

  it('el justificante conserva su formato de siempre: con céntimos y sin el punto de los miles en 4 cifras', async () => {
    const { controller } = makeController({ receipt: { ...RECEIPT, amountCents: 110_900, tipCents: 0 } });
    const { reply, sent } = fakeReply();
    await controller.receipt('qr-token-1', 'es', undefined, reply);
    const body = String(sent.body).split(String.fromCharCode(160)).join(' ');
    expect(body).toContain('1109,00 €');
    expect(body).not.toContain('1.109,00');
    const big = makeController({ receipt: { ...RECEIPT, amountCents: 1_234_560, tipCents: 0 } });
    const out = fakeReply();
    await big.controller.receipt('qr-token-1', 'es', undefined, out.reply);
    expect(String(out.sent.body).split(String.fromCharCode(160)).join(' ')).toContain('12.345,60 €');
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

describe('Reservados: tras pagar (con tarjeta o con bitcoin), el navegador que pagó vuelve a la página del reservado', () => {
  const CLAIM = 'c'.repeat(43);
  const claimHash = createHash('sha256').update(CLAIM).digest('hex');
  const name = walletClaimCookieName('', 'qr-token-1');
  /** El pago ya hecho, como lo da /pay/:token (p. ej. al volver de la página del QR de bitcoin). */
  const paid = (over: Partial<Extract<PayRedirect, { kind: 'paid' }>> = {}): PayRedirect => ({
    kind: 'paid',
    paymentId: PAYMENT_ID,
    amountCents: 12_000,
    tipCents: 0,
    currency: 'EUR',
    authorizedAt: new Date(),
    walletToken: null,
    walletClaimHash: null,
    walletCode: null,
    walletHasFaceId: false,
    walletHasPin: false,
    approvedClaimHash: claimHash,
    reservation: true,
    ...over,
  });

  it('/pay/:token pagado (bitcoin: su QR vuelve aquí) → 303 a /reservas/<enlace>?pagado=1', async () => {
    const { controller, payments } = makeController({ page: paid(), manageToken: 'M'.repeat(32) });
    const { reply, sent } = fakeReply(`${name}=${CLAIM}`);
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe(`/reservas/${'M'.repeat(32)}?pagado=1`);
    expect(payments.reservationManageToken).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it('otro navegador (sin la cookie del pago) o un pago que no es de un reservado: el «Pagado» de siempre', async () => {
    for (const [page, cookie] of [
      [paid(), undefined],
      [paid(), `${name}=${'x'.repeat(43)}`],
      [paid({ reservation: undefined }), `${name}=${CLAIM}`],
    ] as const) {
      const { controller, payments } = makeController({ page, manageToken: 'M'.repeat(32) });
      const { reply, sent } = fakeReply(cookie);
      await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
      expect(sent.status).toBe(200);
      expect(sent.body).toContain('class="paid');
      expect(payments.reservationManageToken).not.toHaveBeenCalled();
    }
  });

  it('/pay/result (con tarjeta, al volver del banco), igual', async () => {
    const back = view({ status: 'AUTHORIZED', reservation: true, approvedClaimHash: claimHash });
    const { reply, sent } = fakeReply(`${name}=${CLAIM}`);
    await makeController({ view: back, manageToken: 'M'.repeat(32) }).controller.paymentResult('ORD-1', 'es', undefined, reply);
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe(`/reservas/${'M'.repeat(32)}?pagado=1`);
  });
});

describe('«Comprobando el pago»: el estado en JSON y la página que se pone al día sola', () => {
  const NOW = Date.now();
  const ctx = (o: Partial<PayStatusContext['view']> = {}): PayStatusContext => ({
    view: {
      state: 'processing',
      attemptStartedAt: new Date(NOW - 5_000).toISOString(),
      retryAt: new Date(NOW + 145_000).toISOString(),
      qrExpiresAt: new Date(NOW + 600_000).toISOString(),
      amountCents: 3_830,
      venueName: 'Sala Aurora',
      otherPayer: false,
      now: new Date(NOW).toISOString(),
      ...o,
    },
    qrToken: 'qr-token-1',
    currency: 'EUR',
    concept: 'Gin tonic',
    ref: 'C-0012',
    saldoPayToken: null,
  });

  it('GET /pay/:token/status: el estado, en JSON y sin caché; con la cookie de este navegador para «otro está pagando»', async () => {
    const { controller, status } = makeController({ statusCtx: ctx({ otherPayer: true }) });
    const mine = 'm'.repeat(43);
    const { reply, sent } = fakeReply(`${walletClaimCookieName('', 'qr-token-1')}=${mine}`);
    await controller.tokenStatus('qr-token-1', reply);
    expect(sent.status).toBe(200);
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.headers['Content-Type']).toContain('application/json');
    expect(JSON.parse(sent.body!)).toMatchObject({ state: 'processing', otherPayer: true, amountCents: 3_830, venueName: 'Sala Aurora' });
    expect(status.byToken).toHaveBeenCalledWith('qr-token-1', createHash('sha256').update(mine).digest('hex'));
    // Sin cookie: null (puede ser otra persona).
    const anon = fakeReply();
    await controller.tokenStatus('qr-token-1', anon.reply);
    expect(status.byToken).toHaveBeenLastCalledWith('qr-token-1', null);
  });

  it('GET /pay/:token/status con un token raro: 404 sin leer cookies ni buscar el cobro', async () => {
    const { controller, status } = makeController({ statusCtx: ctx() });
    for (const token of ['x', 'con espacio', 'a'.repeat(200)]) {
      const { reply, sent } = fakeReply(`${walletClaimCookieName('', token)}=${'m'.repeat(43)}`);
      await controller.tokenStatus(token, reply);
      expect(sent.status).toBe(404);
      expect(sent.headers['Cache-Control']).toBe('no-store');
    }
    expect(status.byToken).not.toHaveBeenCalled();
  });

  it('GET /pay/result/status?op=: por el pedido del banco; sin él o desconocido, 404 (la página va a la del servidor)', async () => {
    const { controller, status } = makeController({ statusCtx: ctx() });
    const ok = fakeReply();
    await controller.resultStatus('000123ABC', ok.reply);
    expect(status.byOrder).toHaveBeenCalledWith('000123ABC');
    expect(ok.sent.status).toBe(200);
    expect(ok.sent.headers['Cache-Control']).toBe('no-store');
    const none = makeController({ statusCtx: null });
    const missing = fakeReply();
    await none.controller.resultStatus('inventado', missing.reply);
    expect(missing.sent.status).toBe(404);
    const empty = fakeReply();
    await none.controller.resultStatus(undefined, empty.reply);
    expect(empty.sent.status).toBe(404);
    expect(none.status.byOrder).toHaveBeenCalledTimes(1);
  });

  it('con su propio límite por IP y por cobro (el token o el pedido), que deja pasar si Redis no contesta', () => {
    const byToken = Reflect.getMetadata(IP_RATE_LIMIT_META, PublicPayController.prototype.tokenStatus);
    const byOrder = Reflect.getMetadata(IP_RATE_LIMIT_META, PublicPayController.prototype.resultStatus);
    expect(byToken).toMatchObject({ scope: 'pay-status', failOpen: true, perKey: { param: 'token' } });
    expect(byOrder).toMatchObject({ scope: 'pay-status', failOpen: true, perKey: { query: 'op' } });
    // Más alto que el de las páginas (600/min por IP): 50 clientes tras el wifi del local caben.
    expect(byToken.max).toBeGreaterThanOrEqual(50 * 20);
    expect(byToken.perKey.max).toBeGreaterThanOrEqual(20);
  });

  it('la vuelta del banco esperando su aviso: la página nueva, que consulta /pay/result/status y vuelve a la del servidor', async () => {
    const { controller } = makeController({ view: view({ status: 'AUTHORIZING' }), statusCtx: ctx() });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('000123ABC', 'es', undefined, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('id="ckCfg"');
    expect(sent.body).toContain('"statusUrl":"/pay/result/status?op=000123ABC"');
    expect(sent.body).toContain('"finalUrl":"/pay/result?op=000123ABC&lang=es"');
    expect(sent.body).toContain('Sala Aurora');
    expect(sent.body).not.toContain('class="paid');
  });

  it('el QR escaneado otra vez con el pago en el banco: la página nueva por el QR', async () => {
    const { controller } = makeController({ page: { kind: 'processing' }, statusCtx: ctx() });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('"statusUrl":"/pay/qr-token-1/status"');
    expect(sent.body).toContain('"finalUrl":"/pay/qr-token-1?lang=es"');
  });

  it('«Sin confirmación del banco»: la misma plantilla, que se sigue comprobando (y pasa a «Pagado» si llega)', async () => {
    const { controller } = makeController({ page: { kind: 'closed', reason: 'unconfirmed' }, statusCtx: ctx({ state: 'unconfirmed', retryAt: null }) });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('data-mode="unconfirmed"');
    expect(sent.body).toContain('Tu banco aún no lo ha confirmado');
    // Los demás cierres, como siempre (409 con su aviso).
    const expired = makeController({ page: { kind: 'closed', reason: 'expired' }, statusCtx: ctx() });
    const e = fakeReply();
    await expired.controller.payPage('qr-token-1', 'es', undefined, IPHONE, e.reply);
    expect(e.sent.status).toBe(409);
    expect(e.sent.body).toContain('Este cobro ha caducado');
  });

  it('el nombre del extracto para «¿Ves el cargo en tu app del banco?»: PAY_STATEMENT_NAME', async () => {
    const { controller } = makeController({
      page: { kind: 'processing' },
      statementName: 'SALA AURORA MADRID',
      statusCtx: ctx({ attemptStartedAt: new Date(NOW - 70_000).toISOString() }),
    });
    const { reply, sent } = fakeReply();
    await controller.payPage('qr-token-1', 'es', undefined, IPHONE, reply);
    expect(sent.body).toContain('Busca «SALA AURORA MADRID»');
  });
});
