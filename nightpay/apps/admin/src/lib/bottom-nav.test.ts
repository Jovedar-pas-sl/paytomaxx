import { describe, expect, it } from 'vitest';
import { badgeText, bottomNavItems, isMoreActive, navBadge } from './bottom-nav';
import { visibleTabs } from './roles';

const nav = (user: { role: string; isSuperAdmin?: boolean }) => bottomNavItems(visibleTabs(user));
const keys = (items: ReadonlyArray<{ key: string }>) => items.map((i) => i.key);

describe('bottomNavItems', () => {
  it('abajo siempre Pagos, Noche, Incidencias y Chicas, con nombres cortos; el dueño, también «Aprobar»', () => {
    const { primary } = nav({ role: 'OWNER' });
    expect(keys(primary)).toEqual(['payments', 'approvals', 'nights', 'incidents', 'operators']);
    expect(primary.map((p) => p.label)).toEqual(['Pagos', 'Aprobar', 'Noche', 'Incidencias', 'Chicas']);
    expect(keys(nav({ role: 'MANAGER' }).primary)).toEqual(['payments', 'nights', 'incidents', 'operators']);
  });

  it('«Mis solicitudes» del encargado va en «Más»', () => {
    expect(keys(nav({ role: 'MANAGER' }).more)).toContain('requests');
  });

  it('el dueño ve Banco e Informes en «Más»', () => {
    const { more } = nav({ role: 'OWNER' });
    expect(keys(more)).toContain('bank');
    expect(keys(more)).toContain('reports');
    expect(keys(more)).not.toContain('payments');
    expect(keys(more)).not.toContain('venues');
  });

  it('el encargado no ve Banco ni Informes, tampoco en «Más»', () => {
    const { primary, more } = nav({ role: 'MANAGER' });
    expect(keys(primary)).toHaveLength(4);
    expect(keys(more)).not.toContain('bank');
    expect(keys(more)).not.toContain('reports');
    expect(keys(more)).toContain('settings');
  });

  it('Locales solo en «Más» del super-admin', () => {
    expect(keys(nav({ role: 'OWNER', isSuperAdmin: true }).more)).toContain('venues');
    expect(keys(nav({ role: 'MANAGER' }).more)).not.toContain('venues');
  });

  it('cada pestaña visible sale una sola vez (abajo o en «Más»)', () => {
    const tabs = visibleTabs({ role: 'OWNER', isSuperAdmin: true });
    const { primary, more } = bottomNavItems(tabs);
    expect([...keys(primary), ...keys(more)].sort()).toEqual(keys(tabs).sort());
  });

  it('sin panel (camarero, chica): nada', () => {
    expect(nav({ role: 'WAITER' })).toEqual({ primary: [], more: [] });
  });
});

describe('isMoreActive', () => {
  it('«Más» se marca cuando la pestaña abierta está dentro', () => {
    const model = nav({ role: 'OWNER' });
    expect(isMoreActive(model, 'settings')).toBe(true);
    expect(isMoreActive(model, 'payments')).toBe(false);
  });
});

describe('navBadge', () => {
  it('incidencias abiertas y pendientes de aprobar; nada en las demás ni sin datos', () => {
    const counts = { incidents: 2, approvals: 3 };
    expect(navBadge('incidents', counts)).toEqual({ text: '2', spoken: '2 abiertas' });
    expect(navBadge('approvals', counts)).toEqual({ text: '3', spoken: '3 por aprobar' });
    expect(navBadge('payments', counts)).toBeNull();
    expect(navBadge('approvals', { incidents: 0, approvals: 0 })).toBeNull();
    expect(navBadge('approvals', { incidents: 0, approvals: null })).toBeNull();
  });
});

describe('badgeText', () => {
  it('nada con 0; el número; 99+ desde 100', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(140)).toBe('99+');
  });
});
