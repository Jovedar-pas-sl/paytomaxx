import { describe, expect, it } from 'vitest';
import {
  NOT_ACCEPTED_TEXT,
  UNSENT_NOTE,
  deliverFailure,
  readerFailure,
  recoverOutcome,
  resendDelayMs,
  shiftSummaryText,
  voidedMessage,
} from './pax-flow';

describe('el lector contesta «ok» pero sin resultado (A2-09)', () => {
  it('al cobrar: no se sabe si se cobró, se ofrece recuperar (nunca «Volver a intentar» sin más)', () => {
    const step = readerFailure({ ok: true });
    expect(step.canRecover).toBe(true);
    expect(step.message).toMatch(/No sabemos si se cobró/);
  });

  it('al recuperar el resultado (a mano o solo): lo mismo, con la salvaguarda de «He mirado el datáfono»', () => {
    for (const manual of [true, false]) {
      const out = recoverOutcome({ ok: true }, 'REF', manual);
      expect(out).toEqual({ kind: 'step', message: expect.stringMatching(/No sabemos si se cobró/), canRecover: true });
    }
  });

  it('lo de antes sigue igual: su operación se envía; otra referencia, «no sabemos»; cancelado, sin recuperar', () => {
    const result = { approved: true, transactionReference: 'REF' };
    expect(recoverOutcome({ ok: true, result }, 'REF', true)).toEqual({ kind: 'deliver', result });
    expect(recoverOutcome({ ok: true, result: { approved: true, transactionReference: 'OTRA' } }, 'REF', true)).toMatchObject({
      kind: 'step',
      canRecover: true,
    });
    expect(recoverOutcome({ ok: false, error: 'timeout' }, 'REF', false)).toMatchObject({ kind: 'step', canRecover: true });
    expect(readerFailure({ ok: false, error: 'cancelled' })).toEqual({ message: 'Cobro cancelado.', canRecover: false });
    expect(readerFailure({ ok: false, error: 'deviceIsBusy' }).canRecover).toBe(true);
  });
});

describe('el resultado del lector no llegó a OxioPay', () => {
  it('venta aprobada y rechazo definitivo (4xx): «ya ha pagado», nunca repetir la venta (A2-03)', () => {
    expect(deliverFailure({ approved: true, final: true })).toBe('notAccepted');
    expect(NOT_ACCEPTED_TEXT).toMatch(/ya ha pagado en el datáfono/);
    expect(NOT_ACCEPTED_TEXT).toMatch(/No cobres otra vez/);
  });

  it('venta aprobada sin respuesta (red, 5xx): se reenvía, nunca se vuelve a cobrar', () => {
    expect(deliverFailure({ approved: true, final: false })).toBe('unsent');
  });

  it('venta denegada: el cliente no pagó, se puede probar otra vez', () => {
    expect(deliverFailure({ approved: false, final: true })).toBe('readerError');
    expect(deliverFailure({ approved: false, final: false })).toBe('readerError');
  });

  it('«se reenvía solo» es verdad: la pantalla reintenta sola, cada vez más espaciado y con tope (A2-05)', () => {
    expect(UNSENT_NOTE).toMatch(/se reenvía solo/i);
    const delays = [0, 1, 2, 3, 4, 5, 10].map(resendDelayMs);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  });
});

describe('anular en el datáfono y avisar a OxioPay (A2-07)', () => {
  it('anulada y avisada', () => {
    expect(voidedMessage(true, 'sent')).toBe('Operación anulada en el datáfono: al cliente no se le cobra dos veces.');
  });

  it('anulada pero OxioPay sin avisar: se dice, y que se reenvía', () => {
    expect(voidedMessage(true, 'queued')).toMatch(/falta avisar a OxioPay/);
    expect(voidedMessage(true, 'queued')).toMatch(/se reenvía sol/);
  });

  it('anulada y OxioPay no la tiene en el cobro: al encargado', () => {
    expect(voidedMessage(true, 'refused')).toMatch(/OxioPay no la tiene/);
    expect(voidedMessage(true, 'refused')).toMatch(/encargado/);
  });

  it('el lector no la anuló', () => {
    for (const report of ['sent', 'queued', 'refused'] as const) {
      expect(voidedMessage(false, report)).toMatch(/^No se pudo anular/);
    }
  });
});

describe('«Cuadrar con el datáfono» (A2-08)', () => {
  it('el datáfono no dio ninguna venta: no se ha podido cuadrar (no «Todo cuadra: 0 ventas»)', () => {
    const text = shiftSummaryText({ total: 0, matched: 0, unmatched: [] });
    expect(text).toBe('El datáfono no ha dado ninguna venta: no se ha podido cuadrar.');
    expect(text).not.toMatch(/cuadra:/);
  });

  it('todas en OxioPay: cuadra; si faltan, cuántas', () => {
    expect(shiftSummaryText({ total: 3, matched: 3, unmatched: [] })).toBe('Todo cuadra: 3 ventas del datáfono, todas en OxioPay.');
    expect(shiftSummaryText({ total: 1, matched: 1, unmatched: [] })).toBe('Todo cuadra: 1 venta del datáfono, en OxioPay.');
    expect(
      shiftSummaryText({ total: 3, matched: 2, unmatched: [{ operationNumber: '1', amountCents: 100, occurredAt: null }] }),
    ).toBe('1 de 3 ventas del datáfono no están en OxioPay. Salen en Incidencias del panel.');
  });
});
