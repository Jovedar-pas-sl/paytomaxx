import { describe, expect, it } from 'vitest';
import type { BusinessView, VenueDetail, VenueRules } from '@nightpay/contracts';
import {
  EMPTY_BUSINESS_FORM,
  EMPTY_VENUE_FORM,
  businessChanges,
  businessFormFrom,
  businessPayload,
  newVenuePayload,
  parseCentsAllowZero,
  profileFormFrom,
  profilePayload,
  rulesFormFrom,
  rulesPayload,
  slugFromName,
} from './forms';

const business: BusinessView = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Luna Ocio SL',
  taxId: 'B12345678',
  contactName: 'Marta',
  contactEmail: 'marta@luna.es',
  contactPhone: null,
  notes: null,
  status: 'ACTIVE',
  pausedAt: null,
  pausedReason: null,
  defaultPlatformCommissionBps: 1000,
  venueCount: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

const rules: VenueRules = {
  operatorMaxCobroCents: 200_00,
  platformCommissionBps: 1000,
  operatorCommissionDefaults: { CHICA_SERVICE: 9000, VENUE_BAR: 0, VENUE_ROOM: 0, VENUE_FOOD: 0, EXTRA: 0 },
  payoutHoldDays: 7,
  effectivePayoutHoldDays: 7,
  refundApprovalThresholdCents: 100_00,
  payoutRequiresApproval: true,
};

const venue: VenueDetail = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Luna Valencia',
  slug: 'luna-vlc',
  timezone: 'Europe/Madrid',
  walletGroup: null,
  business: null,
  paused: false,
  pausedBy: null,
  pausedAt: null,
  pausedReason: null,
  settlementIbanMasked: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  vatBps: 2100,
  vatRegime: 'GENERAL',
  settlementIban: null,
  settlementHolder: null,
  rules,
  counts: { users: 5, operators: 3, terminals: 2 },
};

describe('negocios', () => {
  it('alta: limpia NIF, vacíos a null y la comisión en puntos básicos', () => {
    const r = businessPayload({ ...EMPTY_BUSINESS_FORM, name: ' Sol SL ', taxId: 'b-12.345 678', commissionPct: '12,5' });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Sol SL',
        taxId: 'B12345678',
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        notes: null,
        defaultPlatformCommissionBps: 1250,
      },
    });
  });

  it('errores en llano', () => {
    expect(businessPayload({ ...EMPTY_BUSINESS_FORM, name: 'X' })).toMatchObject({ ok: false });
    expect(businessPayload({ ...EMPTY_BUSINESS_FORM, name: 'Sol', taxId: 'B1' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/NIF/),
    });
    expect(businessPayload({ ...EMPTY_BUSINESS_FORM, name: 'Sol', contactEmail: 'no-es-email' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/email/),
    });
    expect(businessPayload({ ...EMPTY_BUSINESS_FORM, name: 'Sol', commissionPct: '120' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/porcentaje/),
    });
  });

  it('editar: solo lo que cambia, y vaciar un campo lo pone a null', () => {
    const form = { ...businessFormFrom(business), contactName: '', contactPhone: '600 000 000' };
    const r = businessPayload(form);
    if (!r.ok) throw new Error(r.error);
    expect(businessChanges(business, r.value)).toEqual({ contactName: null, contactPhone: '600 000 000' });
  });

  it('sin tocar nada no hay cambios', () => {
    const r = businessPayload(businessFormFrom(business));
    if (!r.ok) throw new Error(r.error);
    expect(businessChanges(business, r.value)).toEqual({});
  });
});

describe('local nuevo', () => {
  it('nombre corto a partir del nombre (sin tildes)', () => {
    expect(slugFromName('Luna Valencia')).toBe('luna-valencia');
    expect(slugFromName('  Café   Ñandú!! ')).toBe('cafe-nandu');
  });

  it('sin nombre corto se saca del nombre; lo opcional no se manda', () => {
    expect(newVenuePayload({ ...EMPTY_VENUE_FORM, name: 'Sol Málaga' })).toEqual({
      ok: true,
      value: { name: 'Sol Málaga', slug: 'sol-malaga', timezone: 'Europe/Madrid' },
    });
  });

  it('negocio, grupo y comisión cuando se ponen', () => {
    const r = newVenuePayload({
      ...EMPTY_VENUE_FORM,
      name: 'Sol',
      slug: 'sol-2',
      businessId: 'b1',
      walletGroup: 'grupo-sol',
      commissionPct: '8',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Sol',
        slug: 'sol-2',
        timezone: 'Europe/Madrid',
        businessId: 'b1',
        walletGroup: 'grupo-sol',
        platformCommissionBps: 800,
      },
    });
  });

  it('nombre corto, zona y grupo que no valen', () => {
    expect(newVenuePayload({ ...EMPTY_VENUE_FORM, name: 'Sol', slug: 'Sol Grande' })).toMatchObject({ ok: false });
    expect(newVenuePayload({ ...EMPTY_VENUE_FORM, name: 'Sol', timezone: 'Marte/Base' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Zona horaria/),
    });
    expect(newVenuePayload({ ...EMPTY_VENUE_FORM, name: 'Sol', walletGroup: 'Grupo Sol' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/grupo del saldo/),
    });
  });
});

describe('perfil del local', () => {
  it('cambiar el nombre no pide 2FA', () => {
    const r = profilePayload(venue, { ...profileFormFrom(venue), name: 'Luna VLC' });
    expect(r).toMatchObject({ ok: true, value: { dto: { name: 'Luna VLC' }, needsTotp: false } });
  });

  it('IVA o grupo del saldo: 2FA y la frase del cambio', () => {
    const r = profilePayload(venue, { ...profileFormFrom(venue), vatPct: '10', walletGroup: 'grupo-luna' });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.dto).toEqual({ vatBps: 1000, walletGroup: 'grupo-luna' });
    expect(r.value.needsTotp).toBe(true);
    expect(r.value.changes).toEqual(['IVA: 21 % → 10 %', 'grupo del saldo: ninguno → grupo-luna']);
  });

  it('quitar el grupo manda null', () => {
    const grouped = { ...venue, walletGroup: 'grupo-luna' };
    const r = profilePayload(grouped, { ...profileFormFrom(grouped), walletGroup: ' ' });
    expect(r).toMatchObject({ ok: true, value: { dto: { walletGroup: null }, needsTotp: true } });
  });

  it('sin cambios, error', () => {
    expect(profilePayload(venue, profileFormFrom(venue))).toEqual({ ok: false, error: 'No has cambiado nada.' });
  });
});

describe('reglas del local', () => {
  it('solo lo que cambia, con las categorías parciales', () => {
    const form = rulesFormFrom(rules);
    const r = rulesPayload(
      rules,
      { ...form, platformPct: '8', categories: { ...form.categories, VENUE_BAR: '5' }, holdDays: '0' },
      7,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value.dto).toEqual({
      platformCommissionBps: 800,
      operatorCommissionDefaults: { VENUE_BAR: 500 },
      payoutHoldDays: 0,
    });
    expect(r.value.changes).toEqual([
      'comisión de la plataforma: 10 % → 8 %',
      'bar / bebida: 0 % → 5 %',
      'días de espera: 7 días → se les paga al cerrar la noche',
    ]);
  });

  it('chica + plataforma no pasan del 100 %', () => {
    const form = rulesFormFrom(rules);
    const r = rulesPayload(rules, { ...form, platformPct: '15' }, 7);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Servicio de chica.*100 %/) });
  });

  it('días de espera: vacío = lo general; fuera de 0-60, error', () => {
    const form = rulesFormFrom(rules);
    const general = rulesPayload(rules, { ...form, holdDays: '' }, 3);
    expect(general).toMatchObject({
      ok: true,
      value: { dto: { payoutHoldDays: null }, changes: ['días de espera: 7 días → lo general (3 días)'] },
    });
    expect(rulesPayload(rules, { ...form, holdDays: '61' }, 3)).toMatchObject({ ok: false });
    expect(rulesPayload(rules, { ...form, holdDays: '2,5' }, 3)).toMatchObject({ ok: false });
  });

  it('umbral de devolución admite 0; aprobación de pagos sí/no', () => {
    const form = rulesFormFrom(rules);
    const r = rulesPayload(rules, { ...form, refundThresholdEur: '0', payoutRequiresApproval: false }, 7);
    expect(r).toMatchObject({
      ok: true,
      value: { dto: { refundApprovalThresholdCents: 0, payoutRequiresApproval: false } },
    });
  });

  it('tope por cobro: hasta 10.000 €', () => {
    const form = rulesFormFrom(rules);
    expect(rulesPayload(rules, { ...form, maxCobroEur: '10.000,01' }, 7)).toMatchObject({ ok: false });
    expect(rulesPayload(rules, { ...form, maxCobroEur: '300' }, 7)).toMatchObject({
      ok: true,
      value: { dto: { operatorMaxCobroCents: 300_00 } },
    });
  });

  it('sin cambios, error', () => {
    expect(rulesPayload(rules, rulesFormFrom(rules), 7)).toEqual({ ok: false, error: 'No has cambiado nada.' });
  });
});

describe('parseCentsAllowZero', () => {
  it('0 vale; lo demás como parseEuroCents', () => {
    expect(parseCentsAllowZero('0', 100)).toBe(0);
    expect(parseCentsAllowZero('0,00 €', 100)).toBe(0);
    expect(parseCentsAllowZero('1', 1000)).toBe(100);
    expect(parseCentsAllowZero('abc', 1000)).toBeNull();
  });
});
