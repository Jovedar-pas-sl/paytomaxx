import { describe, expect, it } from 'vitest';
import { navBadge } from './bottom-nav';
import { PANEL_EDITION, isPartyEdition } from './edition';
import { DEFAULT_TAB, defaultTabOf, navSearch, parseNav, resolveNav } from './nav-url';
import { PANEL_TABS, PARTY_TABS, resolveTab, sectionHint, sectionOf, visibleSections, visibleTabs } from './roles';

/**
 * OxioParty en el panel: seis secciones (En directo, Casetas, Pulseras,
 * Devoluciones, Cierre y Ajustes) con el patrón ?s= de siempre, empieza en En
 * directo y sin nada de lo que es solo de OxioPay. Con 'club', todo igual.
 */

const sections = (role: string, extra: Record<string, unknown> = {}) =>
  visibleSections({ role, ...extra }, 'party').map((s) => [s.key, s.tabs.map((t) => t.key)]);

describe('las secciones de OxioParty', () => {
  it('el dueño: En directo, Casetas, Pulseras, Devoluciones, Cierre y Ajustes, en ese orden', () => {
    expect(sections('OWNER')).toEqual([
      ['directo', ['live', 'payments', 'incidents']],
      ['casetas', ['stalls']],
      ['pulseras', ['wristbands']],
      ['devoluciones', ['partyRefunds']],
      ['cierre', ['settlement']],
      ['ajustes', ['party', 'methods', 'night', 'terminals', 'security']],
    ]);
    expect(visibleSections({ role: 'OWNER' }, 'party').map((s) => s.label)).toEqual([
      'En directo',
      'Casetas',
      'Pulseras',
      'Devoluciones',
      'Cierre',
      'Ajustes',
    ]);
  });

  it('cada sección lleva su línea corta, cierta también para el encargado (Ajustes sin la carta)', () => {
    for (const s of visibleSections({ role: 'OWNER' }, 'party')) {
      const hint = sectionHint(s.key, 'party');
      expect(hint.length, s.key).toBeLessThanOrEqual(80);
      expect(hint, s.key).toMatch(/^[A-ZÁÉÍÓÚ].*.$/);
      expect(hint, s.key).not.toMatch(/chica|carta|formas de cobro/i);
    }
    expect(sectionHint('ajustes', 'club')).toContain('carta');
  });

  it('el encargado: lo mismo menos las formas de cobro y la noche (son del dueño); la fiesta la ve', () => {
    expect(sections('MANAGER').at(-1)).toEqual(['ajustes', ['party', 'terminals', 'security']]);
    expect(sections('MANAGER', { posOn: false }).at(-1)).toEqual(['ajustes', ['party', 'security']]);
    expect(sections('OWNER', { isSuperAdmin: true }).at(-1)?.[1]).toContain('superadmin');
    expect(visibleTabs({ role: 'WAITER' }, 'party')).toEqual([]);
  });

  it('nada de lo que es solo de OxioPay: compañeras y sus pagos, saldos y fichas, informes, reglas, secciones, permisos, Telegram, liquidaciones', () => {
    const keys = PARTY_TABS.map((t) => t.key);
    for (const k of ['resumen', 'operators', 'treasury', 'wallets', 'fichas', 'money', 'nights', 'reports', 'bank', 'oxiopay', 'carta', 'sections', 'rules', 'permissions', 'alerts'] as const) {
      expect(keys).not.toContain(k);
      expect(resolveTab(k, 'party')).toBeNull();
    }
    expect(PARTY_TABS.map((t) => t.label).join(' ')).not.toMatch(/chica|compañera/i);
  });

  it('cada pestaña sabe su sección en cada edición; los nombres de antes, solo si existen', () => {
    expect(sectionOf('live', 'party')).toBe('directo');
    expect(sectionOf('payments', 'party')).toBe('directo');
    expect(sectionOf('payments', 'club')).toBe('hoy');
    expect(sectionOf('settlement', 'party')).toBe('cierre');
    expect(sectionOf('party', 'party')).toBe('ajustes');
    expect(resolveTab('approvals', 'party')).toBe('incidents');
    expect(resolveTab('settings', 'party')).toBe('security');
    expect(resolveTab('stalls', 'party')).toBe('stalls');
  });
});

describe('la URL en OxioParty (?s=&t=)', () => {
  const all = visibleSections({ role: 'OWNER', isSuperAdmin: true, posOn: true }, 'party');

  it('empieza en En directo, con la URL limpia', () => {
    expect(defaultTabOf('party')).toBe('live');
    expect(navSearch('?s=cierre&t=cierre', 'live', 'party')).toBe('');
    expect(resolveNav(parseNav(''), all, 'party')).toBe('live');
    // Una pestaña de OxioPay en un enlace viejo: a En directo.
    expect(resolveNav(parseNav('?s=chicas&t=chicas'), all, 'party')).toBe('live');
  });

  it('cada sección con su nombre en castellano; ida y vuelta, cada pestaña se lee como se escribe', () => {
    expect(navSearch('', 'stalls', 'party')).toBe('?s=casetas&t=casetas');
    expect(navSearch('', 'settlement', 'party')).toBe('?s=cierre&t=cierre');
    expect(navSearch('', 'party', 'party')).toBe('?s=ajustes&t=fiesta');
    expect(navSearch('', 'payments', 'party')).toBe('?s=directo&t=cobros');
    for (const tab of PARTY_TABS) {
      expect(resolveNav(parseNav(navSearch('', tab.key, 'party')), all, 'party')).toBe(tab.key);
    }
    // Solo la sección: su primera pestaña.
    expect(resolveNav(parseNav('?s=cierre'), all, 'party')).toBe('settlement');
  });

  it('el globo de Avisos va en En directo', () => {
    expect(navBadge('directo', 3)).toEqual({ text: '3', spoken: '3 avisos' });
    expect(navBadge('casetas', 3)).toBeNull();
  });
});

describe('con OxioPay (club) nada cambia', () => {
  it('la edición de serie es club y las pestañas, las de siempre', () => {
    expect(PANEL_EDITION).toBe('club');
    expect(isPartyEdition()).toBe(false);
    expect(isPartyEdition('party')).toBe(true);
    expect(DEFAULT_TAB).toBe('resumen');
    expect(defaultTabOf()).toBe('resumen');
    expect(visibleSections({ role: 'OWNER' }).map((s) => s.key)).toEqual(['hoy', 'chicas', 'clientes', 'informes', 'ajustes']);
    expect(PANEL_TABS.some((t) => ['live', 'stalls', 'wristbands', 'partyRefunds', 'settlement', 'party'].includes(t.key))).toBe(false);
    expect(resolveTab('live')).toBeNull();
    expect(navSearch('?s=ajustes&t=formas', 'resumen')).toBe('');
    // «Resumen», la primera de OxioPay; OxioParty no la tiene.
    expect(PANEL_TABS[0]!.key).toBe('resumen');
  });
});
