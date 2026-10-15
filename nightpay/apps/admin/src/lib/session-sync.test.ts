import { describe, expect, it } from 'vitest';
import { classifySessionChange } from './session-sync';

const keys = { token: 'np_admin_token', user: 'np_admin_user' };
const user = (id: string, tenantId: string) => JSON.stringify({ id, tenantId, venueSlug: 'x' });

describe('classifySessionChange', () => {
  it('otra pestaña sale: se borra el token o el usuario, o todo', () => {
    expect(classifySessionChange(keys.token, 'a', null, keys)).toBe('signed-out');
    expect(classifySessionChange(keys.user, user('u', 't'), null, keys)).toBe('signed-out');
    expect(classifySessionChange(null, null, null, keys)).toBe('signed-out');
  });

  it('otra pestaña entra', () => {
    expect(classifySessionChange(keys.token, null, 'a', keys)).toBe('signed-in');
    expect(classifySessionChange(keys.user, null, user('u', 't'), keys)).toBe('signed-in');
  });

  it('otra pestaña renueva el token: nada que hacer', () => {
    expect(classifySessionChange(keys.token, 'a', 'b', keys)).toBeNull();
  });

  it('otra pestaña cambia de local o entra otra persona', () => {
    expect(classifySessionChange(keys.user, user('u', 't1'), user('u', 't2'), keys)).toBe('venue-changed');
    expect(classifySessionChange(keys.user, user('u1', 't'), user('u2', 't'), keys)).toBe('venue-changed');
    expect(classifySessionChange(keys.user, user('u', 't'), user('u', 't'), keys)).toBeNull();
  });

  it('claves ajenas (tema, etc.) no cuentan', () => {
    expect(classifySessionChange('np-theme', 'dark', 'light', keys)).toBeNull();
  });
});
