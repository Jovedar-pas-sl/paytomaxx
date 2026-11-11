import { describe, expect, it } from 'vitest';
import { avisosCount, badgeText, bottomNavItems, inboxHiddenKinds, navBadge } from './bottom-nav';
import { visibleSections } from './roles';

describe('bottomNavItems', () => {
  it('las cinco secciones, sin «Más»', () => {
    const items = bottomNavItems(visibleSections({ role: 'OWNER', isSuperAdmin: true }));
    expect(items.map((i) => i.label)).toEqual(['Hoy', 'Compañeras', 'Clientes', 'Informes', 'Ajustes']);
    expect(items.map((i) => i.key as string)).not.toContain('more');
  });

  it('el encargado también ve las cinco (con menos pestañas dentro)', () => {
    expect(bottomNavItems(visibleSections({ role: 'MANAGER' }))).toHaveLength(5);
  });

  it('sin panel (camarero, chica): nada', () => {
    expect(bottomNavItems(visibleSections({ role: 'WAITER' }))).toEqual([]);
  });
});

describe('avisosCount', () => {
  const incidents = [{ kind: 'stuck_payment' }, { kind: 'approval_pending' }, { kind: 'bank_mismatch' }];

  it('dueño: incidencias + lo que puede aprobar, sin contar dos veces la solicitud', () => {
    expect(avisosCount({ incidents, approvals: 2, isOwner: true })).toBe(4);
  });

  it('encargado: solo las incidencias (aprobar es del dueño)', () => {
    expect(avisosCount({ incidents, approvals: 5, isOwner: false })).toBe(3);
  });

  it('sin datos aún: null; con una de las dos, cuenta lo que hay', () => {
    expect(avisosCount({ incidents: null, approvals: null, isOwner: true })).toBeNull();
    expect(avisosCount({ incidents: null, approvals: 3, isOwner: false })).toBeNull();
    expect(avisosCount({ incidents: null, approvals: 3, isOwner: true })).toBe(3);
    expect(avisosCount({ incidents: [], approvals: null, isOwner: true })).toBe(0);
  });

  it('la bandeja del dueño no repite la incidencia de una solicitud por aprobar', () => {
    expect(inboxHiddenKinds(true).has('approval_pending')).toBe(true);
    expect(inboxHiddenKinds(false).size).toBe(0);
  });
});

describe('navBadge', () => {
  it('solo en «Hoy», con el número de avisos', () => {
    expect(navBadge('hoy', 3)).toEqual({ text: '3', spoken: '3 avisos' });
    expect(navBadge('hoy', 1)).toEqual({ text: '1', spoken: '1 aviso' });
    expect(navBadge('chicas', 3)).toBeNull();
    expect(navBadge('hoy', 0)).toBeNull();
    expect(navBadge('hoy', null)).toBeNull();
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
