import { describe, expect, it, vi } from 'vitest';
import type { OperatorUser } from './api';
import { createOpenChargeStore, summarizeCharges, tabForOpenCharge } from './open-charges';
import { afterRelogin, isSamePerson, shellView, shouldCollapseSheet } from './session-resume';

const ANA: OperatorUser = { id: 'u-ana', email: 'ana@local.es', role: 'OPERATOR', tenantId: 't-1', venueSlug: 'club' };

describe('¿es la misma persona al volver a entrar?', () => {
  it('misma chica, mismo local: sigue donde estaba', () => {
    // El login trae el usuario otra vez (con su nombre puesto ahora): sigue siendo ella.
    const again: OperatorUser = { ...ANA, displayName: 'Ana' };
    expect(isSamePerson(ANA, again)).toBe(true);
    expect(afterRelogin(ANA, ANA)).toBe('resume');
  });

  it('otra persona: se empieza de cero (no ve el cobro de la anterior)', () => {
    expect(isSamePerson(ANA, { ...ANA, id: 'u-eva' })).toBe(false);
    expect(afterRelogin(ANA, { ...ANA, id: 'u-eva' })).toBe('reset');
  });

  it('la misma cuenta en otro local también es otra sesión', () => {
    expect(afterRelogin(ANA, { ...ANA, tenantId: 't-2' })).toBe('reset');
  });

  it('sin nadie antes: de cero', () => {
    expect(isSamePerson(null, ANA)).toBe(false);
    expect(afterRelogin(undefined, ANA)).toBe('reset');
  });
});

describe('qué se ve cuando se acaba la sesión', () => {
  it('cargando, sin sesión, con sesión', () => {
    expect(shellView({ user: undefined, expired: false, chargeOpen: false })).toBe('loading');
    expect(shellView({ user: null, expired: false, chargeOpen: true })).toBe('login');
    expect(shellView({ user: ANA, expired: false, chargeOpen: true })).toBe('app');
  });

  it('caducada con un cobro abierto: la app sigue debajo y se entra encima', () => {
    expect(shellView({ user: ANA, expired: true, chargeOpen: true })).toBe('relogin');
  });

  it('caducada sin cobro abierto: a la pantalla de entrar, como siempre', () => {
    expect(shellView({ user: ANA, expired: true, chargeOpen: false })).toBe('login');
  });

  it('la hoja se recoge sola cuando el cobro deja de esperar (que se vea el PAGADO)', () => {
    expect(shouldCollapseSheet(true, false)).toBe(true);
    expect(shouldCollapseSheet(true, true)).toBe(false);
    expect(shouldCollapseSheet(false, false)).toBe(false);
  });
});

describe('cobros abiertos', () => {
  it('se apuntan y se borran; avisa solo si algo cambia', () => {
    const store = createOpenChargeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toEqual({ open: false, pending: false, spots: [] });

    store.set('cobro', { pending: true });
    expect(store.getSnapshot()).toEqual({ open: true, pending: true, spots: ['cobro'] });
    store.set('cobro', { pending: true });
    expect(listener).toHaveBeenCalledTimes(1);

    // Pagado: sigue en pantalla (el PAGADO con su código) pero ya no espera.
    store.set('cobro', { pending: false });
    expect(store.getSnapshot()).toEqual({ open: true, pending: false, spots: ['cobro'] });

    store.set('cobro', null);
    store.set('cobro', null);
    expect(store.getSnapshot().open).toBe(false);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('esperando si alguno espera', () => {
    expect(summarizeCharges(new Map([['cobro', false], ['saldo', true]])).pending).toBe(true);
  });

  it('caducada: ir a la pestaña del cobro abierto si no se está en ella', () => {
    expect(tabForOpenCharge(['saldo'], 'earnings')).toBe('wallet');
    expect(tabForOpenCharge(['cobro', 'saldo'], 'wallet')).toBeNull();
    expect(tabForOpenCharge(['cobro'], 'payments')).toBe('home');
    // La ficha sale encima de cualquier pestaña.
    expect(tabForOpenCharge(['ficha'], 'payments')).toBeNull();
    expect(tabForOpenCharge([], 'home')).toBeNull();
  });
});
