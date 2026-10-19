import { describe, expect, it } from 'vitest';
import {
  ApiError,
  errorFromBody,
  humanizeTotpError,
  isDuplicateRefundError,
  isRefundOutcomeUnknown,
  isTotpUnreadable,
  loginErrorMessage,
  needsTotpCode,
  totpLockedUntil,
  totpRetryState,
} from './api-errors';

describe('errorFromBody', () => {
  it('ProblemDetails: detail antes que title', () => {
    expect(errorFromBody(JSON.stringify({ title: 'Conflict', detail: 'Ya existe' }), 409)).toEqual({
      message: 'Ya existe',
      code: null,
    });
  });

  it('lista de mensajes (validación) unida', () => {
    expect(errorFromBody(JSON.stringify({ message: ['a', 'b'] }), 400).message).toBe('a · b');
  });

  it('código de máquina si viene', () => {
    expect(errorFromBody(JSON.stringify({ detail: 'x', code: 'DUPLICATE_REFUND' }), 409).code).toBe(
      'DUPLICATE_REFUND',
    );
  });

  it('una página HTML de un proxy no se enseña', () => {
    expect(errorFromBody('<html><body>502 Bad Gateway</body></html>', 502).message).toMatch(/servidor/);
    expect(errorFromBody('', 404).message).toMatch(/404/);
  });
});

describe('loginErrorMessage', () => {
  it('credenciales, demasiados intentos y servidor caído se distinguen', () => {
    expect(loginErrorMessage(401, 'Invalid credentials')).toMatch(/incorrectos/);
    expect(loginErrorMessage(400, 'Validation failed')).toMatch(/incorrectos/);
    expect(loginErrorMessage(429, '')).toMatch(/Demasiados intentos/);
    expect(loginErrorMessage(401, 'Too many attempts; try again later')).toMatch(/Demasiados intentos/);
    expect(loginErrorMessage(503, '')).toMatch(/servidor/);
  });
});

describe('humanizeTotpError', () => {
  it('traduce los errores de 2FA del API', () => {
    expect(humanizeTotpError('TOTP required for refunds >= 100 EUR')).toMatch(/código/);
    expect(
      humanizeTotpError('TOTP not enrolled for this user — contact owner to enroll before high-value refunds'),
    ).toMatch(/Ajustes/);
    expect(humanizeTotpError('Invalid TOTP code')).toMatch(/incorrecto/);
    expect(humanizeTotpError('Otra cosa')).toBe('Otra cosa');
  });
});

describe('isDuplicateRefundError', () => {
  const dup = 'Ya hay una devolución de 20,00 € registrada en este cobro. Si es otra distinta, confírmalo.';

  it('409 con el aviso de devolución repetida', () => {
    expect(isDuplicateRefundError(new ApiError(dup, 409))).toBe(true);
  });

  it('el código de máquina basta aunque cambie el texto', () => {
    expect(isDuplicateRefundError(new ApiError('Otra redacción', 409, 'DUPLICATE_REFUND'))).toBe(true);
  });

  it('otros 409 o el mismo texto con otro código no son el aviso', () => {
    expect(isDuplicateRefundError(new ApiError('Solo se registran devoluciones de cobros pagados', 409))).toBe(false);
    expect(isDuplicateRefundError(new ApiError(dup, 500))).toBe(false);
    expect(isDuplicateRefundError('no es un error')).toBe(false);
  });
});

describe('2FA y devoluciones del API nuevo', () => {
  it('TOTP_REQUIRED por código (también por lo acumulado) o por el texto antiguo', () => {
    expect(needsTotpCode(new ApiError('Hace falta el código 2FA: 120,00 € devueltos', 403, 'TOTP_REQUIRED'))).toBe(true);
    expect(needsTotpCode(new ApiError('Este importe pide el código de tu app de verificación (2FA).', 403))).toBe(true);
    expect(needsTotpCode(new ApiError('Código 2FA incorrecto o caducado', 403, 'TOTP_INVALID'))).toBe(false);
  });

  it('código incorrecto: avisa de que no se puede repetir en 30 s', () => {
    expect(humanizeTotpError('Código 2FA incorrecto o caducado', 'TOTP_INVALID')).toMatch(/30 s/);
  });

  it('devolución sin confirmar por la pasarela', () => {
    expect(isRefundOutcomeUnknown(new ApiError('No sabemos…', 502, 'REFUND_OUTCOME_UNKNOWN'))).toBe(true);
    expect(isRefundOutcomeUnknown(new ApiError('Bad gateway', 502))).toBe(false);
  });
});

describe('totpRetryState (devolver el saldo en efectivo)', () => {
  const NOW = 1_700_000_000_000;
  it('lo pide (TOTP_REQUIRED) o se bloqueó (429): campo del código; otro error, no', () => {
    expect(totpRetryState(new ApiError('Devolver 120,00 € en efectivo: desde 100,00 € pon el código', 403, 'TOTP_REQUIRED'), NOW)).toEqual({
      askCode: true,
      lockedUntil: null,
    });
    expect(totpRetryState(new ApiError('Espera 4 min', 429, 'TOTP_LOCKED'), NOW)).toEqual({
      askCode: true,
      lockedUntil: NOW + 4 * 60_000,
    });
    expect(totpRetryState(new ApiError('Este saldo no tiene nada que devolver', 409), NOW)).toEqual({
      askCode: false,
      lockedUntil: null,
    });
  });
});

describe('2FA: errores del API unificado', () => {
  const NOW = Date.UTC(2026, 9, 15, 2, 0, 0);

  it('pago a una chica sin código: 403 TOTP_REQUIRED pide el código', () => {
    expect(needsTotpCode(new ApiError('Hace falta el código 2FA.', 403, 'TOTP_REQUIRED'))).toBe(true);
  });

  it('bloqueo (429 TOTP_LOCKED): hasta los minutos que dice el mensaje', () => {
    const err = new ApiError('Demasiados códigos 2FA incorrectos. Espera 12 min y vuelve a probar.', 429, 'TOTP_LOCKED');
    expect(totpLockedUntil(err, NOW)).toBe(NOW + 12 * 60_000);
  });

  it('bloqueo sin minutos en el mensaje: 15 min (la política del API)', () => {
    expect(totpLockedUntil(new ApiError('Bloqueado', 429, 'TOTP_LOCKED'), NOW)).toBe(NOW + 15 * 60_000);
  });

  it('429 de 2FA del API de antes (sin código) también bloquea', () => {
    const err = new ApiError('Demasiados códigos 2FA incorrectos. Espera 3 min y vuelve a probar.', 429);
    expect(totpLockedUntil(err, NOW)).toBe(NOW + 3 * 60_000);
  });

  it('un código reusado o malo no bloquea; otro 429 cualquiera tampoco', () => {
    expect(totpLockedUntil(new ApiError('Código usado', 403, 'TOTP_INVALID'), NOW)).toBeNull();
    expect(totpLockedUntil(new ApiError('Demasiadas peticiones', 429), NOW)).toBeNull();
    expect(totpLockedUntil(new Error('x'), NOW)).toBeNull();
  });

  it('secreto ilegible (TOTP_UNREADABLE): mensaje del API y volver a darla de alta', () => {
    const err = new ApiError('No se pudo leer tu verificación en dos pasos.', 403, 'TOTP_UNREADABLE');
    expect(isTotpUnreadable(err)).toBe(true);
    const text = humanizeTotpError(err.message, err.code);
    expect(text).toContain('No se pudo leer tu verificación en dos pasos');
    expect(text).toContain('Ajustes → Verificación en dos pasos');
  });

  it('código reusado: se mantiene el aviso de los 30 s', () => {
    expect(humanizeTotpError('Ese código ya se usó.', 'TOTP_INVALID')).toContain('30 s');
  });
});
