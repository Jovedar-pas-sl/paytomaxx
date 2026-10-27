import { describe, expect, it } from 'vitest';
import { ApiError } from '../api-errors';
import {
  NOT_ENROLLED_MESSAGE,
  SA_ACTION_RULES,
  describeSaFailure,
  isTotpFailure,
  needsTotp,
  profileNeedsTotp,
  reasonProblem,
  type SaAction,
} from './step-up';

describe('qué acciones piden 2FA (como el API)', () => {
  it('lo que mueve dinero o identidades, sí', () => {
    const withTotp: SaAction[] = [
      'business.createMoney',
      'business.updateMoney',
      'business.pause',
      'business.resume',
      'business.assignVenues',
      'business.unassignVenue',
      'venue.createMoney',
      'venue.rules',
      'venue.setIban',
      'venue.clearIban',
      'venue.pause',
      'venue.resume',
      'venue.profileMoney',
      'user.create',
      'user.resetPassword',
      'user.disable',
      'user.enable',
      'user.resetTotp',
      'user.superAdmin',
      'payout.reveal',
      'payout.update',
      'wallet.unblock',
      'wallet.unlockPin',
      'wallet.relink',
    ];
    for (const action of withTotp) expect(needsTotp(action), action).toBe(true);
  });

  it('lo que protege o solo ordena, no', () => {
    const withoutTotp: SaAction[] = [
      'business.create',
      'business.update',
      'venue.create',
      'venue.profile',
      'user.revokeSessions',
      'wallet.block',
    ];
    for (const action of withoutTotp) expect(needsTotp(action), action).toBe(false);
  });

  it('motivo: obligatorio al pausar, opcional al quitar la pausa, nada en reglas', () => {
    expect(SA_ACTION_RULES['venue.pause'].reason).toBe('required');
    expect(SA_ACTION_RULES['business.resume'].reason).toBe('optional');
    expect(SA_ACTION_RULES['venue.rules'].reason).toBe('none');
    expect(SA_ACTION_RULES['wallet.block'].reason).toBe('required');
    // Liquidaciones OxioPay: todo con 2FA; anular, con motivo.
    expect(SA_ACTION_RULES['settlement.pay']).toEqual({ totp: true, reason: 'none' });
    expect(SA_ACTION_RULES['settlement.void']).toEqual({ totp: true, reason: 'required' });
    expect(SA_ACTION_RULES['settlement.generate']).toEqual({ totp: true, reason: 'optional' });
    expect(SA_ACTION_RULES['settlement.payee']).toEqual({ totp: true, reason: 'none' });
    expect(SA_ACTION_RULES['settlement.startWeek']).toEqual({ totp: true, reason: 'required' });
    expect(SA_ACTION_RULES['user.revokeSessions'].reason).toBe('required');
  });

  it('el perfil del local solo pide 2FA con el grupo del saldo o el IVA', () => {
    expect(profileNeedsTotp({ name: 'Luna' })).toBe(false);
    expect(profileNeedsTotp({ timezone: 'Europe/Madrid' })).toBe(false);
    expect(profileNeedsTotp({ walletGroup: null })).toBe(true);
    expect(profileNeedsTotp({ vatBps: 2100 })).toBe(true);
    expect(profileNeedsTotp({ vatRegime: 'EXENTO' })).toBe(true);
  });
});

describe('reasonProblem', () => {
  it('obligatorio: vacío o corto no vale', () => {
    expect(reasonProblem('', 'required')).toMatch(/motivo/);
    expect(reasonProblem('  ', 'required')).toMatch(/motivo/);
    expect(reasonProblem('ab', 'required')).toMatch(/3 letras/);
    expect(reasonProblem('Impago', 'required')).toBeNull();
  });

  it('opcional: vacío vale, corto no', () => {
    expect(reasonProblem('', 'optional')).toBeNull();
    expect(reasonProblem('ok', 'optional')).toMatch(/3 letras/);
  });

  it('demasiado largo', () => {
    expect(reasonProblem('x'.repeat(501), 'required')).toMatch(/500/);
  });

  it('sin motivo: siempre vale', () => {
    expect(reasonProblem('', 'none')).toBeNull();
  });
});

describe('describeSaFailure', () => {
  const now = Date.parse('2026-10-16T20:00:00Z');

  it('sin 2FA activada: a Ajustes', () => {
    const f = describeSaFailure(new ApiError('Activa antes la 2FA en tu perfil.', 403, 'TOTP_NOT_ENROLLED'), now);
    expect(f.notEnrolled).toBe(true);
    expect(f.message).toBe(NOT_ENROLLED_MESSAGE);
    expect(f.message).toMatch(/Ajustes/);
  });

  it('código malo: guarda la pista de los 30 s y borra el código', () => {
    const f = describeSaFailure(new ApiError('Código 2FA incorrecto o caducado', 403, 'TOTP_INVALID'), now);
    expect(f.message).toMatch(/cambia cada 30 s/);
    expect(f.clearCode).toBe(true);
    const reused = describeSaFailure(
      new ApiError('Ese código 2FA ya se ha usado. Espera al siguiente (cambia cada 30 s).', 403, 'TOTP_INVALID'),
      now,
    );
    expect(reused.message.match(/30 s/g)).toHaveLength(1);
  });

  it('falta el código', () => {
    const f = describeSaFailure(new ApiError('Pon el código', 403, 'TOTP_REQUIRED'), now);
    expect(f.message).toMatch(/6 cifras/);
  });

  it('bloqueado (429): hasta cuándo, con los minutos del API', () => {
    const f = describeSaFailure(
      new ApiError('Demasiados códigos 2FA incorrectos. Espera 12 min y vuelve a probar.', 429, 'TOTP_LOCKED'),
      now,
    );
    expect(f.lockedUntil).toBe(now + 12 * 60_000);
    expect(f.notEnrolled).toBe(false);
  });

  it('423 local en pausa y 409: el texto del API tal cual', () => {
    const paused = describeSaFailure(
      new ApiError('Este local está en pausa: ahora no se pueden hacer cobros…', 423, 'VENUE_PAUSED'),
      now,
    );
    expect(paused.message).toMatch(/en pausa/);
    const last = describeSaFailure(new ApiError('Es el último super-admin: nombra antes a otro', 409), now);
    expect(last.message).toBe('Es el último super-admin: nombra antes a otro');
    expect(last.lockedUntil).toBeNull();
  });

  it('errores sin forma de API', () => {
    expect(describeSaFailure(new Error('Sin red'), now).message).toBe('Sin red');
    expect(describeSaFailure('raro', now).message).toMatch(/Vuelve a probar/);
  });

  it('isTotpFailure distingue los fallos de 2FA', () => {
    expect(isTotpFailure(new ApiError('x', 403, 'TOTP_INVALID'))).toBe(true);
    expect(isTotpFailure(new ApiError('x', 409))).toBe(false);
    expect(isTotpFailure(new Error('x'))).toBe(false);
  });
});
