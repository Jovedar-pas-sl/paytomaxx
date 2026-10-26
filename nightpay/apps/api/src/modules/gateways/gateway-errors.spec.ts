import { describe, it, expect } from 'vitest';
import { GatewayTransientError, gatewayHttpError, isTransientGatewayError } from './gateway-errors';

/** opossum (circuit breaker) marca sus errores con `code`. */
function breakerError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isTransientGatewayError — ¿se puede volver a abrir el pago sin riesgo?', () => {
  it('la pasarela no respondió o respondió con un fallo pasajero → sí', () => {
    expect(isTransientGatewayError(new GatewayTransientError('Paytef /save sin respuesta: fetch failed'))).toBe(true);
  });

  it('el circuit breaker no dejó llamar, se agotó el tiempo o había demasiadas a la vez → sí', () => {
    expect(isTransientGatewayError(breakerError('Breaker is open', 'EOPENBREAKER'))).toBe(true);
    expect(isTransientGatewayError(breakerError('Timed out after 5000ms', 'ETIMEDOUT'))).toBe(true);
    expect(isTransientGatewayError(breakerError('Semaphore locked', 'ESEMLOCKED'))).toBe(true);
  });

  it('cualquier otro error (configuración, 4xx, respuesta rara, base de datos) → no', () => {
    expect(isTransientGatewayError(new Error('REDSYS_SECRET_KEY no configurado'))).toBe(false);
    expect(isTransientGatewayError(new Error('Paytef /save failed: 422 userEmail'))).toBe(false);
    expect(isTransientGatewayError(Object.assign(new Error("Can't reach database server"), { code: 'P1001' }))).toBe(false);
    expect(isTransientGatewayError('texto suelto')).toBe(false);
    expect(isTransientGatewayError(null)).toBe(false);
  });
});

describe('gatewayHttpError — la respuesta HTTP de la pasarela que no fue bien', () => {
  it('5xx, 429 y 408: pasajero (con el mismo mensaje para el log)', () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      const err = gatewayHttpError(status, `Paytef /save failed: ${status}`);
      expect(isTransientGatewayError(err)).toBe(true);
      expect(err.message).toBe(`Paytef /save failed: ${status}`);
    }
  });

  it('el resto de 4xx: definitivo (repetir daría lo mismo)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientGatewayError(gatewayHttpError(status, `Paytef /save failed: ${status}`))).toBe(false);
    }
  });
});
