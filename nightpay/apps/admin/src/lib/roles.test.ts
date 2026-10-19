import { describe, expect, it } from 'vitest';
import { canUsePanel, resolveTab, sectionOf, visibleSections, visibleTabs, type PanelViewer } from './roles';

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
    expect(visibleSections({ role: 'OWNER' }).map((s) => s.label)).toEqual(['Hoy', 'Chicas', 'Clientes', 'Informes', 'Ajustes']);
  });

  it('Hoy: cobros y una sola bandeja de avisos; Chicas: las chicas y sus pagos; Clientes: los saldos', () => {
    expect(sectionTabs({ role: 'OWNER' }, 'hoy')).toEqual(['payments', 'incidents']);
    expect(sectionTabs({ role: 'OWNER' }, 'chicas')).toEqual(['operators', 'treasury']);
    expect(sectionTabs({ role: 'OWNER' }, 'clientes')).toEqual(['wallets']);
    expect(sectionTabs({ role: 'OWNER' }, 'informes')).toEqual(['nights', 'reports', 'bank']);
  });

  it('Ajustes del dueño: carta, datáfonos, reglas, formas de cobro, permisos, Telegram y seguridad; Super admin solo si lo es', () => {
    expect(sectionTabs({ role: 'OWNER' }, 'ajustes')).toEqual([
      'carta',
      'terminals',
      'rules',
      'methods',
      'permissions',
      'alerts',
      'security',
    ]);
    expect(sectionTabs({ role: 'OWNER', isSuperAdmin: true }, 'ajustes')).toContain('superadmin');
  });

  it('el encargado no ve lo que no puede usar: ni Banco, ni las reglas, permisos o Telegram; los informes, solo con permiso', () => {
    const tabs = keys({ role: 'MANAGER' });
    for (const k of ['bank', 'reports', 'rules', 'methods', 'permissions', 'alerts', 'superadmin'] as const) {
      expect(tabs).not.toContain(k);
    }
    expect(sectionTabs({ role: 'MANAGER' }, 'ajustes')).toEqual(['carta', 'terminals', 'security']);
    expect(sectionTabs({ role: 'MANAGER' }, 'informes')).toEqual(['nights']);
    expect(sectionTabs({ role: 'MANAGER', canSeeReports: true }, 'informes')).toEqual(['nights', 'reports']);
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
