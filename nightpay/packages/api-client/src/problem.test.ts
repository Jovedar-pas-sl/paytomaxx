import { describe, expect, it } from 'vitest';
import { ApiError, TotpError, isTransientStatus } from './errors';
import { tokenExpiresSoon } from './jwt';
import { parseProblemDetails, readApiError } from './problem';
import { jwt, json } from './test-harness';
import { parseTabMessage } from './tab-channel';

describe('parseProblemDetails', () => {
  it('detail antes que title; userMessage antes que todo', () => {
    expect(parseProblemDetails(JSON.stringify({ title: 'Conflict', detail: 'Ya existe' }))).toEqual({
      message: 'Ya existe',
      code: null,
    });
    expect(parseProblemDetails(JSON.stringify({ detail: 'x', userMessage: 'Para la chica' })).message).toBe('Para la chica');
  });

  it('lista de mensajes (validación) unida, y el código si viene', () => {
    expect(parseProblemDetails(JSON.stringify({ message: ['a', 'b'] })).message).toBe('a · b');
    expect(parseProblemDetails(JSON.stringify({ detail: 'x', code: 'DUPLICATE_REFUND' })).code).toBe('DUPLICATE_REFUND');
  });

  it('una página HTML de un proxy, un texto enorme o un JSON sin mensaje no se enseñan', () => {
    expect(parseProblemDetails('<html>502 Bad Gateway</html>').message).toBeNull();
    expect(parseProblemDetails('x'.repeat(301)).message).toBeNull();
    expect(parseProblemDetails('{"title":""}').message).toBeNull();
    expect(parseProblemDetails('').message).toBeNull();
    expect(parseProblemDetails('Servicio en mantenimiento').message).toBe('Servicio en mantenimiento');
  });
});

describe('readApiError', () => {
  it('ApiError con estado, texto y código; sin texto, el de reserva', async () => {
    const err = await readApiError(json(409, { detail: 'Ya hay una devolución', code: 'DUPLICATE_REFUND' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'Ya hay una devolución', code: 'DUPLICATE_REFUND' });
    const empty = await readApiError(new Response('', { status: 502 }), (s) => `fallo ${s}`);
    expect(empty.message).toBe('fallo 502');
  });

  it('códigos TOTP_* → TotpError (que también es ApiError)', async () => {
    const err = await readApiError(json(403, { detail: 'Código 2FA incorrecto', code: 'TOTP_INVALID' }));
    expect(err).toBeInstanceOf(TotpError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TOTP_INVALID');
  });
});

describe('utilidades', () => {
  it('429 y 5xx son pasajeros; 4xx no', () => {
    expect([429, 500, 503].map(isTransientStatus)).toEqual([true, true, true]);
    expect([400, 401, 403, 404].map(isTransientStatus)).toEqual([false, false, false, false]);
  });

  it('tokenExpiresSoon: con exp cercano o pasado sí; sin exp o ilegible, no', () => {
    const now = 1_700_000_000_000;
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 30 }), now)).toBe(true);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 - 5 }), now)).toBe(true);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 3600 }), now)).toBe(false);
    expect(tokenExpiresSoon('no-es-un-jwt', now)).toBe(false);
    expect(tokenExpiresSoon(jwt({ sub: 'u1' }), now)).toBe(false);
  });

  it('un mensaje de otra pestaña con forma rara se ignora', () => {
    expect(parseTabMessage({ type: 'logout' })).toEqual({ type: 'logout' });
    expect(parseTabMessage({ type: 'expired' })).toBeNull();
    expect(parseTabMessage({ type: 'session', id: 1 })).toBeNull();
    expect(parseTabMessage('logout')).toBeNull();
  });
});
