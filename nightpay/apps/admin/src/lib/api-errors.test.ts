import { describe, expect, it } from 'vitest';
import {
  ApiError,
  errorFromBody,
  humanizeTotpError,
  isDuplicateRefundError,
  isRefundOutcomeUnknown,
  loginErrorMessage,
  needsTotpCode,
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
