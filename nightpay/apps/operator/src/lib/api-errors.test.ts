import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginErrorMessage, newIdempotencyKey, operatorErrorMessage, tokenExpiresSoon } from './api';

describe('mensajes de error del API para la chica', () => {
  it('403 de negocio: se enseña lo que dice el servidor', () => {
    expect(operatorErrorMessage(403, 'El máximo que puedes cobrar de una vez es 300 €', 'Cobro')).toBe(
      'El máximo que puedes cobrar de una vez es 300 €',
    );
    expect(operatorErrorMessage(403, 'Este PIN lo pusiste tú: el cobro lo tiene que hacer otra persona', 'PIN')).toBe(
      'Este PIN lo pusiste tú: el cobro lo tiene que hacer otra persona',
    );
    expect(operatorErrorMessage(403, 'Tu saldo se paga con Face ID: escanea el QR del cobro', 'PIN')).toBe(
      'Tu saldo se paga con Face ID: escanea el QR del cobro',
    );
  });

  it('403 técnico (guardas de rol, título HTTP) o sin texto: mensaje genérico', () => {
    const generic = 'No tienes permiso para esta acción.';
    expect(
      operatorErrorMessage(403, 'Role WAITER not allowed; requires one of OWNER, MANAGER, OPERATOR', 'Cancelación'),
    ).toBe(generic);
    expect(operatorErrorMessage(403, 'Authentication required', 'Cobro')).toBe(generic);
    expect(operatorErrorMessage(403, 'Forbidden', 'Cobro')).toBe(generic);
    expect(operatorErrorMessage(403, undefined, 'Cobro')).toBe(generic);
    expect(operatorErrorMessage(403, 'x'.repeat(250), 'Cobro')).toBe(generic);
  });

  it('409 y 422 siguen enseñando el detalle corto', () => {
    expect(operatorErrorMessage(409, 'Ese cobro ya está pagado', 'Cobro')).toBe('Ese cobro ya está pagado');
    expect(operatorErrorMessage(409, 'Conflict', 'Cobro')).toBe('Esta operación ya está en curso o no se puede repetir.');
    expect(operatorErrorMessage(422, 'La ficha se da justo al recargar (o con el encargado)', 'Ficha')).toBe(
      'La ficha se da justo al recargar (o con el encargado)',
    );
  });

  it('sesión, límites y servidor caído', () => {
    expect(operatorErrorMessage(401, 'Unauthorized', 'Cobro')).toMatch(/sesión ha caducado/);
    expect(operatorErrorMessage(429, undefined, 'Cobro')).toMatch(/Demasiados intentos/);
    expect(operatorErrorMessage(503, 'Service Unavailable', 'Cobro')).toMatch(/servidor/);
    expect(operatorErrorMessage(404, undefined, 'Código de saldo')).toBe('Código de saldo no encontrado.');
  });
});

describe('errores al entrar', () => {
  it('401 → email o contraseña incorrectos', () => {
    expect(loginErrorMessage(401, 'Invalid credentials')).toBe('Email o contraseña incorrectos.');
    expect(loginErrorMessage(400)).toBe('Email o contraseña incorrectos.');
  });

  it('demasiados intentos: 429 o el bloqueo por fallos', () => {
    expect(loginErrorMessage(429)).toMatch(/Demasiados intentos/);
    expect(loginErrorMessage(401, 'Too many attempts; try again later')).toMatch(/Demasiados intentos/);
  });

  it('sin red o servidor caído → no se pudo conectar', () => {
    expect(loginErrorMessage(null)).toMatch(/No se pudo conectar/);
    expect(loginErrorMessage(502)).toMatch(/No se pudo conectar/);
  });
});

describe('caducidad del access token (para el socket en tiempo real)', () => {
  const jwt = (payload: object) =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.firma`;
  const now = Date.UTC(2026, 9, 15, 22, 0, 0);

  it('le queda menos de un minuto → hay que renovarlo', () => {
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 30 }), now)).toBe(true);
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 - 5 }), now)).toBe(true);
  });

  it('le queda tiempo, o no se puede leer → se usa tal cual', () => {
    expect(tokenExpiresSoon(jwt({ exp: now / 1000 + 3600 }), now)).toBe(false);
    expect(tokenExpiresSoon('no-es-un-jwt', now)).toBe(false);
    expect(tokenExpiresSoon(jwt({ sub: 'u1' }), now)).toBe(false);
  });
});

describe('clave de idempotencia de cada cobro', () => {
  const UUID_KEY = /^op-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  afterEach(() => vi.unstubAllGlobals());

  it('UUID v4 que el API acepta, distinta cada vez', () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(UUID_KEY);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it('sin crypto.randomUUID (sin HTTPS) también', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    expect(newIdempotencyKey()).toMatch(UUID_KEY);
  });
});
