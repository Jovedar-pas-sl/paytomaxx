import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { PublicPayController, walletClaimCookieName } from '../payments/public-pay.controller';
import { payerWalletFields } from '../payments/payments.service';
import { settledPayView, type PayRedirect, type PayResultView, type PayablePayment } from '../payments/pay-redirect';
import { homeTopUpKey } from './home-topup-rules';

/**
 * Tras pagar la carga que creó el saldo desde el enlace del local, el
 * navegador que la pagó va a su saldo nuevo con la bienvenida (y no al
 * «Pagado» de siempre); otro navegador que abra el enlace del pago, no.
 */

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const CLAIM = 'a'.repeat(43);
const CLAIM_HASH = createHash('sha256').update(CLAIM).digest('hex');
const HOME_KEY = homeTopUpKey('secreto', 'venue', 'k1234567890abcdef');
const walletRow = { qrToken: 'walletTok', shortCode: 'K7Q4M2', pinHash: null, _count: { passkeys: 0 } };

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

function controller(o: { view?: PayResultView | null; page?: PayRedirect }) {
  const payments = { getResultView: vi.fn().mockResolvedValue(o.view ?? null), getPayPage: vi.fn().mockResolvedValue(o.page) };
  const config = { get: vi.fn(() => undefined) };
  const redsysReturn = { process: vi.fn().mockResolvedValue('enviado') };
  const status = { byToken: vi.fn().mockResolvedValue(null), byOrder: vi.fn().mockResolvedValue(null) };
  return new PublicPayController(payments as never, config as never, {} as never, {} as never, redsysReturn as never, status as never);
}

const claimCookie = (payToken: string) => `${walletClaimCookieName('', payToken)}=${CLAIM}`;

function resultView(over: Partial<PayResultView>): PayResultView {
  return {
    paymentId: PAYMENT_ID,
    status: 'AUTHORIZED',
    amountCents: 5000,
    tipCents: 0,
    currency: 'EUR',
    authorizedAt: new Date(),
    qrToken: 'payTok',
    walletToken: 'walletTok',
    walletClaimHash: CLAIM_HASH,
    walletCode: 'K7Q-4M2',
    walletHasFaceId: false,
    walletHasPin: false,
    walletFromHome: true,
    attemptStatus: 'APPROVED',
    approvedClaimHash: CLAIM_HASH,
    ...over,
  };
}

describe('payerWalletFields: la carga desde casa que creó el saldo', () => {
  it('el navegador que la pagó se lleva el saldo (como cualquier saldo nuevo) y va a su página', () => {
    const f = payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: HOME_KEY, approvedClaimHash: CLAIM_HASH });
    expect(f).toMatchObject({ walletToken: 'walletTok', walletClaimHash: CLAIM_HASH, walletCode: 'K7Q-4M2', walletFromHome: true });
    expect(f.walletReturnToken).toBeUndefined();
  });

  it('una recarga del personal, una de /w o una que no creó el saldo: sin bienvenida', () => {
    expect(payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: 'k-personal-123', approvedClaimHash: CLAIM_HASH }).walletFromHome).toBeUndefined();
    expect(
      payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: `wtopup:${'b'.repeat(64)}`, approvedClaimHash: CLAIM_HASH }).walletFromHome,
    ).toBeUndefined();
    expect(payerWalletFields({ wallet: walletRow, firstTopUp: false, idempotencyKey: HOME_KEY, approvedClaimHash: CLAIM_HASH }).walletFromHome).toBeUndefined();
  });

  it('el «Pagado» de /pay lo lleva', () => {
    const p = {
      id: PAYMENT_ID,
      status: 'AUTHORIZED',
      amountCents: 5000,
      tipCents: 0,
      currency: 'EUR',
      qrExpiresAt: new Date(),
      authorizedAt: new Date(),
      allowTip: false,
      ...payerWalletFields({ wallet: walletRow, firstTopUp: true, idempotencyKey: HOME_KEY, approvedClaimHash: CLAIM_HASH }),
    } as PayablePayment;
    expect(settledPayView(p)).toMatchObject({ kind: 'paid', walletToken: 'walletTok', walletFromHome: true });
  });
});

describe('vuelta del banco y /pay pagado: al saldo nuevo con la bienvenida', () => {
  it('el navegador que pagó: 303 a /w/<saldo>?nuevo=<cobro>', async () => {
    const { reply, sent } = fakeReply(claimCookie('payTok'));
    await controller({ view: resultView({}) }).paymentResult('ORDER1', 'fr', undefined, reply, {});
    expect(sent.status).toBe(303);
    expect(sent.headers.Location).toBe('/w/walletTok?lang=fr&nuevo=payTok');
  });

  it('otro navegador (el enlace del pago reenviado): el «Pagado» de siempre, sin el saldo', async () => {
    const { reply, sent } = fakeReply();
    await controller({ view: resultView({}) }).paymentResult('ORDER1', 'es', undefined, reply, {});
    expect(sent.status).toBe(200);
    expect(sent.body).not.toContain('walletTok');
  });

  it('GET /pay/<cobro> ya pagado, en el navegador que pagó: lo mismo', async () => {
    const page: PayRedirect = {
      kind: 'paid',
      paymentId: PAYMENT_ID,
      amountCents: 5000,
      tipCents: 0,
      currency: 'EUR',
      authorizedAt: new Date(),
      walletToken: 'walletTok',
      walletClaimHash: CLAIM_HASH,
      walletCode: 'K7Q-4M2',
      walletHasFaceId: false,
      walletHasPin: false,
      walletFromHome: true,
      approvedClaimHash: CLAIM_HASH,
    };
    const mine = fakeReply(claimCookie('payTok'));
    await controller({ page }).payPage('payTok', 'pt', undefined, undefined, mine.reply);
    expect(mine.sent.status).toBe(303);
    expect(mine.sent.headers.Location).toBe('/w/walletTok?lang=pt&nuevo=payTok');
    const other = fakeReply();
    await controller({ page }).payPage('payTok', 'es', undefined, undefined, other.reply);
    expect(other.sent.status).toBe(200);
  });

  it('sin pagar aún no se va a ningún sitio (sigue «Comprobando»)', async () => {
    const { reply, sent } = fakeReply(claimCookie('payTok'));
    await controller({ view: resultView({ status: 'AUTHORIZING', attemptStatus: 'PENDING' }) }).paymentResult('ORDER1', 'es', undefined, reply, {});
    expect(sent.headers.Location).toBeUndefined();
  });
});
