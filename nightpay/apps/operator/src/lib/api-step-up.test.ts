import { describe, expect, it } from 'vitest';
import { StepUpApiError, stepUpErrorText } from './api-step-up';

describe('la llave de acceso en la app del personal', () => {
  it('cada error, en llano; cancelar en el móvil no dice nada', () => {
    expect(stepUpErrorText(new StepUpApiError(403, 'x', 'PASSKEY_NOT_SET'))).toMatch(/«Llave de acceso»/);
    expect(stepUpErrorText(new StepUpApiError(403, 'x', 'PASSWORD_INVALID'))).toBe('La contraseña no es correcta.');
    expect(stepUpErrorText(new StepUpApiError(409, 'x', 'PASSKEY_TIMEOUT'))).toBe('Ha tardado demasiado. Vuelve a intentarlo.');
    expect(stepUpErrorText(Object.assign(new Error('cancelado'), { name: 'NotAllowedError' }))).toBeNull();
    expect(stepUpErrorText(new StepUpApiError(429, 'Demasiadas contraseñas incorrectas. Espera 15 min', 'PASSWORD_LOCKED'))).toBe(
      'Demasiadas contraseñas incorrectas. Espera 15 min',
    );
  });
});
