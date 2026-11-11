import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_FILTERS, auditActionLabel, auditReason, isSuperAdminAction } from './audit-actions';

describe('auditActionLabel', () => {
  it('las acciones de la consola, sin el prefijo superadmin.', () => {
    expect(auditActionLabel('superadmin.venue.paused')).toBe('Local en pausa');
    expect(auditActionLabel('superadmin.business.resumed')).toBe('Negocio sin pausa');
    expect(auditActionLabel('superadmin.user.super_admin_granted')).toBe('Permiso de super-admin dado');
    expect(auditActionLabel('superadmin.payout_account.revealed')).toBe('Cuenta de cobro vista entera');
    expect(auditActionLabel('superadmin.wallet.relinked')).toBe('Enlace nuevo del saldo');
    expect(auditActionLabel('superadmin.step_up.failed')).toBe('Código 2FA fallido');
  });

  it('las liquidaciones OxioPay (superadmin.settlement.*)', () => {
    expect(auditActionLabel('superadmin.settlement.generated')).toBe('Liquidación OxioPay emitida');
    expect(auditActionLabel('superadmin.settlement.paid_partially')).toBe('Liquidación OxioPay pagada en parte');
    expect(auditActionLabel('superadmin.settlement.voided')).toBe('Liquidación OxioPay anulada');
    expect(auditActionLabel('superadmin.settlement.payee_updated')).toBe('Cuenta de OxioPay cambiada');
    expect(auditActionLabel('superadmin.settlement.start_week_updated')).toBe('Semana de inicio de las liquidaciones cambiada');
    expect(auditActionLabel('superadmin.settlement.otra')).toBe('Liquidación OxioPay: otra');
    expect(AUDIT_ACTION_FILTERS.some((f) => f.value === 'superadmin.settlement.')).toBe(true);
  });

  it('las acciones de siempre del panel y las apps', () => {
    expect(auditActionLabel('auth.login.ok')).toBe('Entró');
    expect(auditActionLabel('auth.login.failed')).toBe('Intento de entrada fallido');
    expect(auditActionLabel('refund.created')).toBe('Devolución hecha');
    expect(auditActionLabel('operator.payout.created')).toBe('Pago a compañera apuntado');
    expect(auditActionLabel('night.closed')).toBe('Noche cerrada');
  });

  it('lo que no está en la lista se lee igual (área + qué)', () => {
    expect(auditActionLabel('wallet.algo_nuevo')).toBe('Saldo: algo nuevo');
    expect(auditActionLabel('superadmin.venue.otra_cosa')).toBe('Local: otra cosa');
    expect(auditActionLabel('raro.cosa_rara')).toBe('raro cosa rara');
    expect(auditActionLabel('venue')).toBe('Local');
  });

  it('sabe qué viene de la consola', () => {
    expect(isSuperAdminAction('superadmin.user.created')).toBe(true);
    expect(isSuperAdminAction('user.created')).toBe(false);
  });
});

describe('AUDIT_ACTION_FILTERS', () => {
  it('prefijos válidos para el API (letras, números, punto y guion bajo)', () => {
    for (const f of AUDIT_ACTION_FILTERS) {
      expect(f.value === '' || /^[a-z0-9_.]+$/i.test(f.value)).toBe(true);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it('sin repetidos', () => {
    const values = AUDIT_ACTION_FILTERS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('auditReason', () => {
  it('saca el motivo del payload si lo hay', () => {
    expect(auditReason({ reason: ' Impago ', before: {} })).toBe('Impago');
    expect(auditReason({ before: {} })).toBeNull();
    expect(auditReason(null)).toBeNull();
    expect(auditReason({ reason: 42 })).toBeNull();
  });
});
