import { describe, expect, it } from 'vitest';
import { AUTH_BODY_REFRESH_DEFAULT_UNTIL, authBodyRefreshUntil } from './auth-body-refresh';
import { cutoffOpen } from './date-cutoff';

describe('authBodyRefreshUntil (AUTH_BODY_REFRESH_UNTIL)', () => {
  it('sin definir o vacía → martes 2026-12-01 12:00 de Madrid (fuera de la noche y del fin de semana)', () => {
    expect(AUTH_BODY_REFRESH_DEFAULT_UNTIL).toBe('2026-12-01T12:00:00+01:00');
    expect(authBodyRefreshUntil(undefined)?.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    expect(authBodyRefreshUntil('  ')?.toISOString()).toBe('2026-12-01T11:00:00.000Z');
    expect(new Date(AUTH_BODY_REFRESH_DEFAULT_UNTIL).getUTCDay()).toBe(2);
  });

  it('"off" (como sea escrito) → cerrada ya', () => {
    expect(authBodyRefreshUntil('off')).toBeNull();
    expect(authBodyRefreshUntil(' OFF ')).toBeNull();
  });

  it('otra fecha con zona → esa', () => {
    expect(authBodyRefreshUntil('2026-12-15T00:00:00+01:00')?.toISOString()).toBe('2026-12-14T23:00:00.000Z');
  });

  it('valor que no vale → error que nombra la variable', () => {
    expect(() => authBodyRefreshUntil('2026-11-30')).toThrow(/AUTH_BODY_REFRESH_UNTIL/);
  });
});

describe('cutoffOpen', () => {
  const until = new Date('2026-11-30T00:00:00+01:00');

  it('abierta hasta el instante de corte (sin incluirlo)', () => {
    expect(cutoffOpen(until, until.getTime() - 1)).toBe(true);
    expect(cutoffOpen(until, until.getTime())).toBe(false);
    expect(cutoffOpen(until, Date.parse('2026-12-01T10:00:00+01:00'))).toBe(false);
  });

  it('"off" (null) → cerrada siempre', () => {
    expect(cutoffOpen(null, 0)).toBe(false);
  });
});
