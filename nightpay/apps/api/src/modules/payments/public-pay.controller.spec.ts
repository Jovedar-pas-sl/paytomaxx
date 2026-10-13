import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { PublicPayController } from './public-pay.controller';
import type { PayRedirect, PayResultView } from './pay-redirect';

const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

function fakeReply() {
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
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

function makeController(opts: { view?: PayResultView | null; redirect?: PayRedirect }) {
  const payments = {
    getResultView: vi.fn().mockResolvedValue(opts.view ?? null),
    resolveRedirect: vi.fn().mockResolvedValue(opts.redirect),
  };
  return { controller: new PublicPayController(payments as any), payments };
}

function view(overrides: Partial<PayResultView>): PayResultView {
  return {
    paymentId: PAYMENT_ID,
    status: 'AUTHORIZING',
    amountCents: 100,
    currency: 'EUR',
    authorizedAt: null,
    qrToken: 'qr-token-1',
    attemptStatus: 'PENDING',
    ...overrides,
  };
}

describe('GET /pay/result — el "Pagado" ya no se puede falsificar', () => {
  it('sin pedido conocido nunca dice "Pagado"', async () => {
    const { controller } = makeController({ view: null });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('inventado', reply);
    expect(sent.body).toContain('No encontramos este pago');
    expect(sent.body).not.toContain('<h1>Pagado</h1>');
  });

  it('pago aún sin aviso del banco → "Comprobando", aunque la URL diga status=ok', async () => {
    const { controller } = makeController({ view: view({ status: 'AUTHORIZING' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', reply);
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).toContain('http-equiv="refresh"');
    expect(sent.body).not.toContain('<h1>Pagado</h1>');
  });

  it('pago confirmado → "Pagado" con importe y código de confirmación', async () => {
    const { controller } = makeController({
      view: view({ status: 'AUTHORIZED', authorizedAt: new Date('2026-10-13T08:15:02Z') }),
    });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', reply);
    expect(sent.body).toContain('<h1>Pagado</h1>');
    expect(sent.body).toContain('1,00');
    expect(sent.body).toContain('A6B');
    expect(sent.body).toContain('10:15');
    expect(sent.headers['Cache-Control']).toBe('no-store');
  });

  it('intento denegado → ofrece probar otra tarjeta con el mismo QR', async () => {
    const { controller } = makeController({ view: view({ attemptStatus: 'DENIED' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', reply);
    expect(sent.body).toContain('El banco no ha aceptado el pago');
    expect(sent.body).toContain('href="/pay/qr-token-1"');
  });

  it('pago sin confirmar (ORPHAN) → no dice "Pagado"', async () => {
    const { controller } = makeController({ view: view({ status: 'ORPHAN' }) });
    const { reply, sent } = fakeReply();
    await controller.paymentResult('a1b2c3d4e5f6', reply);
    expect(sent.body).toContain('Sin confirmación del banco');
  });
});

describe('GET /pay/:token — volver a escanear el QR', () => {
  it('QR ya cobrado → "Pagado", nunca vuelve al banco', async () => {
    const { controller } = makeController({
      redirect: { kind: 'paid', paymentId: PAYMENT_ID, amountCents: 100, currency: 'EUR', authorizedAt: null },
    });
    const { reply, sent } = fakeReply();
    await controller.redirect('qr-token-1', reply);
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('<h1>Pagado</h1>');
    expect(sent.body).not.toContain('<form');
  });

  it('cobro en curso → "Comprobando", sin formulario al banco', async () => {
    const { controller } = makeController({ redirect: { kind: 'processing' } });
    const { reply, sent } = fakeReply();
    await controller.redirect('qr-token-1', reply);
    expect(sent.body).toContain('Comprobando el pago');
    expect(sent.body).not.toContain('<form');
  });

  it('QR caducado → mensaje claro y 409', async () => {
    const { controller } = makeController({ redirect: { kind: 'closed', reason: 'expired' } });
    const { reply, sent } = fakeReply();
    await controller.redirect('qr-token-1', reply);
    expect(sent.status).toBe(409);
    expect(sent.body).toContain('Este cobro ha caducado');
  });

  it('textos de cliente sin "chica"', async () => {
    const { controller } = makeController({ redirect: { kind: 'closed', reason: 'failed' } });
    const { reply, sent } = fakeReply();
    await controller.redirect('qr-token-1', reply);
    expect(sent.body?.toLowerCase()).not.toContain('chica');
  });
});
