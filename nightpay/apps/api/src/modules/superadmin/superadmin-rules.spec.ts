import { describe, it, expect } from 'vitest';
import {
  businessUpdateNeedsStepUp,
  commissionMapOf,
  generateTemporaryPassword,
  planVenueRulesChange,
  profileNeedsStepUp,
  superAdminRemovalProblem,
  venueCreateNeedsStepUp,
} from './superadmin-rules';

const current = {
  operatorMaxCobroCents: 20_000,
  platformCommissionBps: 1000,
  operatorCommissionDefaults: { CHICA_SERVICE: 9000, VENUE_BAR: 0 },
  payoutHoldDays: null,
  refundApprovalThresholdCents: 10_000,
  payoutRequiresApproval: true,
};

describe('planVenueRulesChange — reglas del local', () => {
  it('las comisiones parciales se mezclan con las guardadas (las que faltan, por defecto)', () => {
    const plan = planVenueRulesChange(current, { operatorCommissionDefaults: { VENUE_BAR: 500 } }, null);
    expect(plan).toEqual({
      ok: true,
      change: {
        operatorCommissionDefaults: { CHICA_SERVICE: 9000, VENUE_BAR: 500, VENUE_ROOM: 0, VENUE_FOOD: 0, EXTRA: 0 },
      },
    });
  });

  it('días de espera 0 (al cierre de la noche) o null (los del entorno); umbral y aprobación se guardan', () => {
    const plan = planVenueRulesChange(
      current,
      { payoutHoldDays: 0, refundApprovalThresholdCents: 5000, payoutRequiresApproval: false },
      null,
    );
    expect(plan).toEqual({ ok: true, change: { payoutHoldDays: 0, refundApprovalThresholdCents: 5000, payoutRequiresApproval: false } });
    expect(planVenueRulesChange({ ...current, payoutHoldDays: 3 }, { payoutHoldDays: null }, null)).toEqual({
      ok: true,
      change: { payoutHoldDays: null },
    });
  });

  it('chica + plataforma > 100 % en una categoría → no', () => {
    const plan = planVenueRulesChange(current, { platformCommissionBps: 1500 }, null);
    expect(plan).toMatchObject({ ok: false });
    expect(!plan.ok && plan.problem).toMatch(/CHICA_SERVICE.*pasa del 100 %/);
    expect(planVenueRulesChange(current, { operatorCommissionDefaults: { CHICA_SERVICE: 9500 } }, null)).toMatchObject({ ok: false });
  });

  it('justo 100 % vale; el % propio más alto de una chica del local también cuenta', () => {
    expect(planVenueRulesChange(current, { operatorCommissionDefaults: { CHICA_SERVICE: 9000 } }, 9000)).toMatchObject({ ok: true });
    const plan = planVenueRulesChange(current, { platformCommissionBps: 800 }, 9500);
    expect(plan).toMatchObject({ ok: false });
    expect(!plan.ok && plan.problem).toMatch(/chica con 95 % propio/);
  });

  it('commissionMapOf: JSON guardado raro → valores por defecto', () => {
    expect(commissionMapOf(null)).toEqual({ CHICA_SERVICE: 9000, VENUE_BAR: 0, VENUE_ROOM: 0, VENUE_FOOD: 0, EXTRA: 0 });
    expect(commissionMapOf({ CHICA_SERVICE: '80' as unknown as number, EXTRA: 100 }).EXTRA).toBe(100);
    expect(commissionMapOf({ CHICA_SERVICE: '80' as unknown as number }).CHICA_SERVICE).toBe(9000);
  });
});

describe('profileNeedsStepUp', () => {
  it('grupo del saldo o IVA → 2FA; nombre o zona horaria → no', () => {
    expect(profileNeedsStepUp({ name: 'Luna' })).toBe(false);
    expect(profileNeedsStepUp({ timezone: 'Europe/Madrid' })).toBe(false);
    expect(profileNeedsStepUp({ walletGroup: null })).toBe(true);
    expect(profileNeedsStepUp({ vatBps: 1000 })).toBe(true);
    expect(profileNeedsStepUp({ vatRegime: 'EXENTO' })).toBe(true);
  });
});

describe('altas y negocios que piden 2FA', () => {
  it('alta de local: con grupo del saldo o comisión propia → 2FA; sin ellos (o grupo null) → no', () => {
    expect(venueCreateNeedsStepUp({ name: 'Luna', slug: 'luna' })).toBe(false);
    expect(venueCreateNeedsStepUp({ name: 'Luna', slug: 'luna', walletGroup: null })).toBe(false);
    expect(venueCreateNeedsStepUp({ name: 'Luna', slug: 'luna', walletGroup: 'g1' })).toBe(true);
    expect(venueCreateNeedsStepUp({ name: 'Luna', slug: 'luna', platformCommissionBps: 0 })).toBe(true);
  });

  it('negocio: cambiar la comisión por defecto → 2FA; reenviar la misma o tocar otros datos → no', () => {
    const current = { defaultPlatformCommissionBps: 800 };
    expect(businessUpdateNeedsStepUp({ name: 'Luna Ocio' }, current)).toBe(false);
    expect(businessUpdateNeedsStepUp({ defaultPlatformCommissionBps: 800 }, current)).toBe(false);
    expect(businessUpdateNeedsStepUp({ defaultPlatformCommissionBps: 500 }, current)).toBe(true);
    expect(businessUpdateNeedsStepUp({ defaultPlatformCommissionBps: null }, current)).toBe(true);
  });
});

describe('superAdminRemovalProblem — nunca sin super-admins', () => {
  it('el último no se puede quitar (ni quitarte tú si eres el último)', () => {
    expect(superAdminRemovalProblem({ activeSuperAdminIds: ['a'], targetId: 'a', actorId: 'a' })).toMatch(/Eres el último/);
    expect(superAdminRemovalProblem({ activeSuperAdminIds: ['a'], targetId: 'a', actorId: 'b' })).toMatch(/Es el último/);
  });

  it('con otro activo, sí (también a ti mismo); a quien no es super-admin, nada que comprobar', () => {
    expect(superAdminRemovalProblem({ activeSuperAdminIds: ['a', 'b'], targetId: 'a', actorId: 'a' })).toBeNull();
    expect(superAdminRemovalProblem({ activeSuperAdminIds: ['a', 'b'], targetId: 'b', actorId: 'a' })).toBeNull();
    expect(superAdminRemovalProblem({ activeSuperAdminIds: ['a'], targetId: 'c', actorId: 'a' })).toBeNull();
  });
});

describe('generateTemporaryPassword', () => {
  it('12 caracteres legibles (sin 0/O/l/I/1), distintos cada vez', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
});
