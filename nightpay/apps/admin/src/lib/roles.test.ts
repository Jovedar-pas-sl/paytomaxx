import { describe, expect, it } from 'vitest';
import { canUsePanel, visibleTabs } from './roles';

const keys = (user: { role: string; isSuperAdmin?: boolean }) => visibleTabs(user).map((t) => t.key);

describe('canUsePanel', () => {
  it('solo dueño y encargado', () => {
    expect(canUsePanel('OWNER')).toBe(true);
    expect(canUsePanel('MANAGER')).toBe(true);
    expect(canUsePanel('WAITER')).toBe(false);
    expect(canUsePanel('OPERATOR')).toBe(false);
    expect(canUsePanel(undefined)).toBe(false);
  });
});

describe('visibleTabs', () => {
  it('el encargado no ve Banco ni Informes (sus endpoints son solo del dueño)', () => {
    const tabs = keys({ role: 'MANAGER' });
    expect(tabs).not.toContain('bank');
    expect(tabs).not.toContain('reports');
    expect(tabs).toContain('payments');
    expect(tabs).toContain('settings');
  });

  it('el dueño ve Banco e Informes; Locales solo si es super-admin', () => {
    expect(keys({ role: 'OWNER' })).toContain('bank');
    expect(keys({ role: 'OWNER' })).toContain('reports');
    expect(keys({ role: 'OWNER' })).not.toContain('venues');
    expect(keys({ role: 'OWNER', isSuperAdmin: true })).toContain('venues');
  });

  it('«Por aprobar» solo el dueño; «Mis solicitudes» solo el encargado', () => {
    expect(keys({ role: 'OWNER' })).toContain('approvals');
    expect(keys({ role: 'OWNER' })).not.toContain('requests');
    expect(keys({ role: 'MANAGER' })).toContain('requests');
    expect(keys({ role: 'MANAGER' })).not.toContain('approvals');
  });

  it('camareros y chicas: ninguna pestaña', () => {
    expect(keys({ role: 'WAITER' })).toEqual([]);
    expect(keys({ role: 'OPERATOR', isSuperAdmin: true })).toEqual([]);
  });
});
