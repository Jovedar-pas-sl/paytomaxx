import { describe, expect, it } from 'vitest';
import { ALREADY_PAID_CODE } from '@nightpay/contracts';
import { ServerUnavailableError, SessionExpiredError } from '@nightpay/api-client';
import { CobroApiError, cobroBody, payFailureKind } from './api-cobro';

// APP-02: pagar con el NFC o con el PIN y no saber la respuesta no es «No se
// ha cobrado»: el servidor pudo cobrarlo. Solo un rechazo del API lo es.
describe('¿se cobró? tras un fallo al pagar con el NFC o el PIN', () => {
  it('sin red, plazo agotado o el servidor caído (5xx): no se sabe (se comprueba el cobro)', () => {
    expect(payFailureKind(new ServerUnavailableError('sin red', 0, 'network'))).toBe('ambiguous');
    expect(payFailureKind(new ServerUnavailableError('tarda', 0, 'timeout'))).toBe('ambiguous');
    expect(payFailureKind(new CobroApiError(500, 'El servidor está teniendo problemas.', null))).toBe('ambiguous');
    expect(payFailureKind(new CobroApiError(502, 'El servidor está teniendo problemas.', null))).toBe('ambiguous');
    expect(payFailureKind(new CobroApiError(503, 'El servidor está teniendo problemas.', null))).toBe('ambiguous');
    expect(payFailureKind(new CobroApiError(408, 'Tarda', null))).toBe('ambiguous');
    // Un 200 con el cuerpo cortado (JSON roto) o un fallo raro del navegador: tampoco se sabe.
    expect(payFailureKind(new SyntaxError('Unexpected end of JSON input'))).toBe('ambiguous');
    expect(payFailureKind(new TypeError('Failed to fetch'))).toBe('ambiguous');
  });

  it('el API dijo que no (4xx con su razón): no se ha cobrado', () => {
    expect(payFailureKind(new CobroApiError(422, 'Saldo insuficiente', 'WALLET_INSUFFICIENT'))).toBe('definitive');
    expect(payFailureKind(new CobroApiError(409, 'Este saldo está bloqueado', 'WALLET_BLOCKED'))).toBe('definitive');
    expect(payFailureKind(new CobroApiError(404, 'Cobro no encontrado.', null))).toBe('definitive');
    expect(payFailureKind(new CobroApiError(429, 'Demasiados intentos. Espera un momento.', null))).toBe('definitive');
    expect(payFailureKind(new SessionExpiredError('Tu sesión ha caducado.'))).toBe('definitive');
  });

  it('ya lo pagó la tarjeta: ni «No se ha cobrado» ni comprobar', () => {
    expect(payFailureKind(new CobroApiError(409, 'Ya está pagado', ALREADY_PAID_CODE))).toBe('already_paid');
  });
});

// Cobro por el encargado: el «Mi QR» de la compañera va en el cuerpo del cobro.
describe('el cuerpo de POST /v1/payments', () => {
  const lines = [{ serviceItemId: '00000000-0000-4000-8000-000000000001', qty: 1 }];

  it('con datáfono y la compañera: POS_EXTERNAL y su QR, sin el cobro del saldo', () => {
    const body = cobroBody({ lines, pos: true, terminalExternalId: 'T1', serviceStaffToken: 'tok-de-nerea-0123456789' });
    expect(body).toMatchObject({ currency: 'EUR', lines, captureMethod: 'POS_EXTERNAL', terminalExternalId: 'T1', serviceStaffToken: 'tok-de-nerea-0123456789' });
    expect(body).not.toHaveProperty('withSaldo');
  });

  it('sin datáfono: con el cobro del saldo y sin compañera si no se ha escaneado', () => {
    const body = cobroBody({ lines });
    expect(body.withSaldo).toBe(true);
    expect(body).not.toHaveProperty('captureMethod');
    expect(body).not.toHaveProperty('serviceStaffToken');
  });
});
