import { describe, expect, it } from 'vitest';
import { canUsePanel, resolveTab, SECTION_HINTS, sectionOf, visibleSections, visibleTabs, type PanelViewer } from './roles';

const keys = (user: PanelViewer) => visibleTabs(user).map((t) => t.key);
const sections = (user: PanelViewer) => visibleSections(user).map((s) => s.key);
const sectionTabs = (user: PanelViewer, key: string) =>
  visibleSections(user)
    .find((s) => s.key === key)
    ?.tabs.map((t) => t.key);

describe('canUsePanel', () => {
  it('solo dueño y encargado', () => {
    expect(canUsePanel('OWNER')).toBe(true);
    expect(canUsePanel('MANAGER')).toBe(true);
    expect(canUsePanel('WAITER')).toBe(false);
    expect(canUsePanel('OPERATOR')).toBe(false);
    expect(canUsePanel(undefined)).toBe(false);
  });
});

describe('cinco secciones', () => {
  it('dueño y encargado ven Hoy, Chicas, Clientes, Informes y Ajustes, en ese orden', () => {
    expect(sections({ role: 'OWNER' })).toEqual(['hoy', 'chicas', 'clientes', 'informes', 'ajustes']);
    expect(sections({ role: 'MANAGER' })).toEqual(['hoy', 'chicas', 'clientes', 'informes', 'ajustes']);
    expect(visibleSections({ role: 'OWNER' }).map((s) => s.label)).toEqual(['Hoy', 'Compañeras', 'Clientes', 'Informes', 'Ajustes']);
  });

  it('Hoy: el Resumen primero, cobros, el mapa del dinero y una sola bandeja de avisos; Chicas: las chicas y sus pagos; Clientes: los saldos y las fichas', () => {
    expect(sectionTabs({ role: 'OWNER' }, 'hoy')).toEqual(['resumen', 'payments', 'money', 'incidents']);
    expect(visibleTabs({ role: 'OWNER' })[0]).toEqual({ key: 'resumen', label: 'Resumen', section: 'hoy', access: 'staff' });
    expect(sectionOf('resumen')).toBe('hoy');
    expect(sectionTabs({ role: 'OWNER' }, 'chicas')).toEqual(['operators', 'treasury']);
    expect(sectionTabs({ role: 'OWNER' }, 'clientes')).toEqual(['wallets', 'reservations', 'fichas']);
    expect(sectionTabs({ role: 'MANAGER' }, 'clientes')).toEqual(['wallets', 'reservations', 'fichas']);
    expect(sectionOf('fichas')).toBe('clientes');
    expect(sectionTabs({ role: 'OWNER' }, 'informes')).toEqual(['nights', 'reports', 'bank', 'oxiopay']);
  });

  it('Ajustes del dueño: carta, secciones, datáfonos, reglas, formas de cobro, la noche, permisos, Telegram y seguridad; Super admin solo si lo es', () => {
    expect(sectionTabs({ role: 'OWNER' }, 'ajustes')).toEqual([
      'carta',
      'sections',
      'terminals',
      'rules',
      'methods',
      'night',
      'permissions',
      'alerts',
      'security',
    ]);
    expect(sectionTabs({ role: 'OWNER', isSuperAdmin: true }, 'ajustes')).toContain('superadmin');
  });

  it('el encargado no ve lo que no puede usar: ni Banco, ni las reglas, permisos o Telegram; los informes, solo con permiso', () => {
    const tabs = keys({ role: 'MANAGER' });
    for (const k of ['bank', 'oxiopay', 'reports', 'rules', 'methods', 'night', 'permissions', 'alerts', 'superadmin', 'sections'] as const) {
      expect(tabs).not.toContain(k);
    }
    expect(sectionTabs({ role: 'MANAGER' }, 'ajustes')).toEqual(['carta', 'terminals', 'security']);
    expect(sectionTabs({ role: 'MANAGER' }, 'informes')).toEqual(['nights']);
    expect(sectionTabs({ role: 'MANAGER', canSeeReports: true }, 'informes')).toEqual(['nights', 'reports']);
  });

  it('«Liquidaciones OxioPay»: solo el dueño (ni el encargado con permiso de informes)', () => {
    expect(keys({ role: 'OWNER' })).toContain('oxiopay');
    expect(keys({ role: 'MANAGER', canSeeReports: true })).not.toContain('oxiopay');
    expect(sectionOf('oxiopay')).toBe('informes');
    expect(visibleTabs({ role: 'OWNER' }).find((t) => t.key === 'oxiopay')?.label).toBe('Liquidaciones OxioPay');
  });

  it('el mapa del dinero, como los informes: el encargado solo si el dueño le deja verlos', () => {
    expect(sectionTabs({ role: 'MANAGER' }, 'hoy')).toEqual(['resumen', 'payments', 'incidents']);
    expect(sectionTabs({ role: 'MANAGER', canSeeReports: true }, 'hoy')).toEqual(['resumen', 'payments', 'money', 'incidents']);
    expect(sectionOf('money')).toBe('hoy');
  });

  it('camareros y chicas: nada', () => {
    expect(keys({ role: 'WAITER' })).toEqual([]);
    expect(visibleSections({ role: 'OPERATOR', isSuperAdmin: true })).toEqual([]);
  });
});

describe('sectionOf / resolveTab', () => {
  it('cada pestaña sabe su sección', () => {
    expect(sectionOf('treasury')).toBe('chicas');
    expect(sectionOf('superadmin')).toBe('ajustes');
    expect(sectionOf('bank')).toBe('informes');
  });

  it('los nombres de antes llevan a su sitio nuevo; uno desconocido, a ninguno', () => {
    expect(resolveTab('approvals')).toBe('incidents');
    expect(resolveTab('requests')).toBe('incidents');
    expect(resolveTab('settings')).toBe('security');
    expect(resolveTab('wallets')).toBe('wallets');
    expect(resolveTab('nada')).toBeNull();
  });
});

describe('datáfono apagado en Formas de cobro', () => {
  it('sin la pestaña Datáfonos (ni para el dueño ni para el encargado); sin saberlo, como antes', () => {
    expect(sectionTabs({ role: 'OWNER', posOn: false }, 'ajustes')).toEqual([
      'carta',
      'sections',
      'rules',
      'methods',
      'night',
      'permissions',
      'alerts',
      'security',
    ]);
    expect(sectionTabs({ role: 'MANAGER', posOn: false }, 'ajustes')).toEqual(['carta', 'security']);
    expect(keys({ role: 'OWNER', posOn: true })).toContain('terminals');
    expect(keys({ role: 'OWNER' })).toContain('terminals');
    // Un enlace guardado a Datáfonos sigue resolviendo (el panel vuelve a Cobros si no se ve).
    expect(resolveTab('terminals')).toBe('terminals');
  });
});

describe('encontrar los reservados y los RRPP a la primera', () => {
  it('Clientes: «Reservados y RRPP» justo después de Saldos (con su nombre, también para el encargado)', () => {
    for (const role of ['OWNER', 'MANAGER']) {
      const clientes = visibleSections({ role }).find((s) => s.key === 'clientes');
      expect(clientes?.tabs.map((t) => t.label)).toEqual(['Saldos', 'Reservados y RRPP', 'Fichas']);
    }
  });

  it('cada sección lleva una línea corta con lo que hay dentro; la de Clientes nombra los RRPP', () => {
    for (const s of visibleSections({ role: 'OWNER' })) {
      const hint = SECTION_HINTS[s.key];
      expect(hint.length, s.key).toBeLessThanOrEqual(80);
      expect(hint, s.key).toMatch(/^[A-ZÁÉÍÓÚ].*\.$/);
      expect(hint, s.key).not.toMatch(/chica/i);
    }
    expect(SECTION_HINTS.clientes).toContain('RRPP');
  });

  it('la línea no nombra pestañas que el encargado no ve (Mapa del dinero, Banco, Formas de cobro, Permisos…)', () => {
    // «Noche» y «Secciones» (del dueño) son también palabras de todos los días: fuera de la cuenta.
    const ownerOnly = visibleTabs({ role: 'OWNER' }).filter((t) => !keys({ role: 'MANAGER' }).includes(t.key) && !['night', 'sections'].includes(t.key));
    expect(ownerOnly.map((t) => t.key)).toContain('money');
    for (const s of visibleSections({ role: 'MANAGER' })) {
      for (const t of ownerOnly) expect(SECTION_HINTS[s.key].toLowerCase(), `${s.key}: ${t.label}`).not.toContain(t.label.toLowerCase());
    }
  });
});
