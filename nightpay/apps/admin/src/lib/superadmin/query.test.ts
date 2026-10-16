import { describe, expect, it } from 'vitest';
import {
  EMPTY_AUDIT_FILTERS,
  EMPTY_PAYOUT_FILTERS,
  EMPTY_STAFF_FILTERS,
  addDays,
  auditQuery,
  auditRangeProblem,
  businessesQuery,
  payoutAccountsQuery,
  staffQuery,
  toQueryString,
  venuesQuery,
  zonedDayStartIso,
} from './query';

describe('toQueryString', () => {
  it('omite lo vacío y recorta los textos', () => {
    expect(toQueryString({ a: ' x ', b: '', c: null, d: undefined, e: '   ' })).toBe('?a=x');
  });

  it('booleanos y números como texto', () => {
    expect(toQueryString({ active: false, limit: 50 })).toBe('?active=false&limit=50');
  });

  it('sin nada: cadena vacía (sin "?")', () => {
    expect(toQueryString({})).toBe('');
  });

  it('codifica lo que no va tal cual en una URL', () => {
    expect(toQueryString({ q: 'ana & co' })).toBe('?q=ana+%26+co');
  });
});

describe('negocios y locales', () => {
  it('negocios: búsqueda y estado', () => {
    expect(businessesQuery({ q: 'luna', status: 'PAUSED' })).toBe('?q=luna&status=PAUSED');
    expect(businessesQuery({ q: '', status: '' })).toBe('');
  });

  it('locales: «en pausa» y «cobrando» son paused=true / false', () => {
    expect(venuesQuery({ q: '', businessId: '', state: 'paused' })).toBe('?paused=true');
    expect(venuesQuery({ q: '', businessId: 'b1', state: 'active' })).toBe('?businessId=b1&paused=false');
    expect(venuesQuery({ q: '', businessId: '', state: '' })).toBe('');
  });
});

describe('staffQuery', () => {
  it('sin filtros: solo el tamaño de página', () => {
    expect(staffQuery(EMPTY_STAFF_FILTERS)).toBe('?limit=50');
  });

  it('todos los filtros y el cursor', () => {
    const q = staffQuery(
      { venueId: 'v1', role: 'OPERATOR', q: 'ana', state: 'inactive', onlySuperAdmins: true },
      'c9',
      20,
    );
    expect(q).toBe('?venueId=v1&role=OPERATOR&q=ana&active=false&superAdmin=true&cursor=c9&limit=20');
  });

  it('«de alta» = active=true; «super-admins» sin marcar no se manda', () => {
    expect(staffQuery({ ...EMPTY_STAFF_FILTERS, state: 'active' })).toBe('?active=true&limit=50');
  });
});

describe('payoutAccountsQuery', () => {
  it('solo las casillas marcadas', () => {
    expect(payoutAccountsQuery(EMPTY_PAYOUT_FILTERS)).toBe('');
    expect(payoutAccountsQuery({ ...EMPTY_PAYOUT_FILTERS, onlyMissing: true, includeInactive: true })).toBe(
      '?missing=true&includeInactive=true',
    );
    expect(payoutAccountsQuery({ ...EMPTY_PAYOUT_FILTERS, venueId: 'v1', method: 'SEPA_IBAN', q: 'ana' })).toBe(
      '?venueId=v1&method=SEPA_IBAN&q=ana',
    );
  });
});

describe('fechas del registro (hora de Madrid)', () => {
  it('las 00:00 de Madrid en verano (UTC+2) y en invierno (UTC+1)', () => {
    expect(zonedDayStartIso('2026-10-16')).toBe('2026-10-15T22:00:00.000Z');
    expect(zonedDayStartIso('2026-12-01')).toBe('2026-11-30T23:00:00.000Z');
  });

  it('el día del cambio de hora empieza aún en horario de verano', () => {
    expect(zonedDayStartIso('2026-10-25')).toBe('2026-10-24T22:00:00.000Z');
    expect(zonedDayStartIso('2026-03-29')).toBe('2026-03-28T23:00:00.000Z');
  });

  it('otra zona y días que no son días', () => {
    expect(zonedDayStartIso('2026-01-10', 'UTC')).toBe('2026-01-10T00:00:00.000Z');
    expect(zonedDayStartIso('16/10/2026')).toBeNull();
  });

  it('addDays cruza meses y años', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('nada', 1)).toBeNull();
  });

  it('«hasta» incluye el día entero: se manda el día siguiente', () => {
    const q = auditQuery({ ...EMPTY_AUDIT_FILTERS, from: '2026-10-01', to: '2026-10-16', action: 'superadmin.' });
    const params = new URLSearchParams(q.slice(1));
    expect(params.get('from')).toBe('2026-09-30T22:00:00.000Z');
    expect(params.get('to')).toBe('2026-10-16T22:00:00.000Z');
    expect(params.get('action')).toBe('superadmin.');
    expect(params.get('limit')).toBe('50');
  });

  it('cursor y filtros de local y persona', () => {
    const q = auditQuery({ ...EMPTY_AUDIT_FILTERS, venueId: 'v1', actorId: 'u1' }, '1234');
    expect(q).toBe('?venueId=v1&actorId=u1&cursor=1234&limit=50');
  });

  it('avisa si «hasta» va antes que «desde»', () => {
    expect(auditRangeProblem({ from: '2026-10-10', to: '2026-10-01' })).toMatch(/anterior/);
    expect(auditRangeProblem({ from: '2026-10-01', to: '2026-10-01' })).toBeNull();
    expect(auditRangeProblem({ from: '', to: '2026-10-01' })).toBeNull();
  });
});
