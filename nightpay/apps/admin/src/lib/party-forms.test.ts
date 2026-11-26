import { describe, expect, it } from 'vitest';
import type { PartySettings } from '@nightpay/contracts';
import { IBAN, sampleSettlement, sampleStall } from './party-fixtures';
import { hasPartySettingsChange, isoToZonedInput, partySettingsChange, partySettingsFormFrom, zonedInputToIso } from './party-settings';
import { leftoverView, rangeProblem, sepaReadiness, settlementRowView, transfersText } from './party-settlement';
import {
  EMPTY_STALL_FORM,
  assignableStalls,
  createStallDto,
  hasStallChange,
  organizerText,
  stallFormFrom,
  stallIbanText,
  staffName,
  staffRoleLabel,
  updateStallDto,
} from './party-stalls';

/** Los formularios de OxioParty: casetas (% e IBAN), la fiesta (horas del local) y el cierre. */

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\u00a0/g, ' ')) as T;

describe('casetas', () => {
  const form = { ...EMPTY_STALL_FORM, name: ' Peña El Cántaro ', managerName: 'Ana R.', percent: '12,5', iban: 'es91 2100 0418 4502 0005 1332' };

  it('una nueva: el % en bps, el IBAN sin espacios y en mayúsculas, el contacto vacío a null', () => {
    expect(createStallDto(form)).toEqual({
      ok: true,
      value: { name: 'Peña El Cántaro', managerName: 'Ana R.', managerContact: null, organizerBps: 1250, iban: IBAN, zone: null, sells: null, active: true, openNow: false },
    });
  });

  it('«barra propia» es el 100 % (sin IBAN no pasa nada)', () => {
    const r = createStallDto({ ...form, ownBar: true, percent: '', iban: '' });
    expect(r.ok && r.value).toMatchObject({ organizerBps: 10_000, iban: null });
  });

  it('lo que no vale, con su motivo', () => {
    expect(createStallDto({ ...form, name: '  ' })).toEqual({ ok: false, problem: 'Pon el nombre de la caseta.' });
    expect(createStallDto({ ...form, managerName: '' })).toMatchObject({ ok: false });
    expect(createStallDto({ ...form, percent: '120' })).toMatchObject({ ok: false, problem: expect.stringContaining('de 0 a 100') });
    expect(createStallDto({ ...form, percent: 'diez' })).toMatchObject({ ok: false });
    expect(createStallDto({ ...form, iban: 'ES91 2100 0418 4502 0005 1333' })).toMatchObject({ ok: false, problem: expect.stringContaining('IBAN') });
  });

  it('al cambiarla, solo lo que cambia (y nada si no cambia nada)', () => {
    const stall = sampleStall();
    const same = updateStallDto(stallFormFrom(stall), stall);
    expect(same).toEqual({ ok: true, value: {} });
    expect(same.ok && hasStallChange(same.value)).toBe(false);
    const r = updateStallDto({ ...stallFormFrom(stall), percent: '15', iban: '', active: false }, stall);
    expect(r).toEqual({ ok: true, value: { organizerBps: 1500, iban: null, active: false } });
    expect(r.ok && hasStallChange(r.value)).toBe(true);
    expect(stallFormFrom(sampleStall({ organizerBps: 10_000, ownBar: true }))).toMatchObject({ ownBar: true, percent: '' });
    expect(stallFormFrom(stall).percent).toBe('10,00');
  });

  it('lo que ven los asistentes: zona y qué vende sin espacios sueltos (vacío = sin decir) y «Abierta ahora»', () => {
    const r = createStallDto({ ...form, zone: '  Junto al escenario ', sells: ' Bocadillos ', openNow: true });
    expect(r.ok && r.value).toMatchObject({ zone: 'Junto al escenario', sells: 'Bocadillos', openNow: true });
    expect(createStallDto({ ...form, zone: 'x'.repeat(61) })).toEqual({ ok: false, problem: 'La zona, como mucho 60 letras.' });
    expect(createStallDto({ ...form, sells: 'x'.repeat(121) })).toEqual({ ok: false, problem: 'Qué vende, como mucho 120 letras.' });
    const stall = sampleStall();
    expect(stallFormFrom(stall)).toMatchObject({ zone: 'Junto al escenario', sells: 'Bocadillos, cerveza, refrescos', openNow: true });
    expect(updateStallDto({ ...stallFormFrom(stall), zone: '', sells: 'Horchata', openNow: false }, stall)).toEqual({
      ok: true,
      value: { zone: null, sells: 'Horchata', openNow: false },
    });
    expect(stallFormFrom(sampleStall({ zone: null, sells: null, openNow: false }))).toMatchObject({ zone: '', sells: '', openNow: false });
  });

  it('cómo se lee en la tabla y en el personal', () => {
    expect(plain(organizerText(1000))).toBe('10 %');
    expect(plain(organizerText(1250))).toBe('12,5 %');
    expect(organizerText(10_000)).toBe('Barra propia');
    expect(stallIbanText(sampleStall())).toEqual({ text: 'ES91 •••• •••• 1332', tone: 'success' });
    expect(stallIbanText(sampleStall({ iban: null }))).toEqual({ text: 'Falta IBAN', tone: 'danger' });
    expect(stallIbanText(sampleStall({ ownBar: true, iban: null }))).toEqual({ text: 'No se paga', tone: 'neutral' });
    expect(staffRoleLabel('OPERATOR')).toBe('Personal');
    expect(staffRoleLabel('WAITER')).toBe('Camarero');
    expect(staffName({ displayName: '  ', email: 'x@y.es' })).toBe('x@y.es');
    expect(assignableStalls([sampleStall(), sampleStall({ id: 's-2', active: false })]).map((s) => s.id)).toEqual(['s-1']);
  });
});

describe('la fiesta: las horas en la del local', () => {
  const TZ = 'Europe/Madrid';

  it('de la hora de Madrid a UTC y vuelta (verano e invierno)', () => {
    expect(zonedInputToIso('2027-06-23T20:00', TZ)).toBe('2027-06-23T18:00:00.000Z');
    expect(zonedInputToIso('2027-01-10T20:00', TZ)).toBe('2027-01-10T19:00:00.000Z');
    expect(isoToZonedInput('2027-06-23T18:00:00.000Z', TZ)).toBe('2027-06-23T20:00');
    expect(isoToZonedInput('2027-01-10T19:00:00.000Z', TZ)).toBe('2027-01-10T20:00');
    expect(isoToZonedInput(null, TZ)).toBe('');
  });

  it('el día del cambio de hora (último domingo de marzo, 03:00 en Madrid)', () => {
    expect(zonedInputToIso('2027-03-28T03:30', TZ)).toBe('2027-03-28T01:30:00.000Z');
    expect(zonedInputToIso('2027-03-28T01:30', TZ)).toBe('2027-03-28T00:30:00.000Z');
  });

  it('lo mal escrito, null', () => {
    expect(zonedInputToIso('23/06/2027 20:00', TZ)).toBeNull();
    expect(zonedInputToIso('2027-02-30T20:00', TZ)).toBeNull();
    expect(zonedInputToIso('2027-06-23T25:00', TZ)).toBeNull();
  });

  const settings: PartySettings = {
    eventStartsAt: '2027-06-23T18:00:00.000Z',
    eventEndsAt: '2027-06-25T04:00:00.000Z',
    refundDeadline: '2027-07-15',
    allowDonation: true,
    cashAlertCents: 200_000,
    eventEnded: false,
  };

  it('el formulario y lo que cambia (solo lo distinto)', () => {
    const form = partySettingsFormFrom(settings, TZ);
    expect(form).toEqual({
      startsAt: '2027-06-23T20:00',
      endsAt: '2027-06-25T06:00',
      refundDeadline: '2027-07-15',
      allowDonation: true,
      cashAlertEur: '2000,00',
    });
    const same = partySettingsChange(form, settings, TZ);
    expect(same).toEqual({ ok: true, change: {} });
    expect(same.ok && hasPartySettingsChange(same.change)).toBe(false);
    const changed = partySettingsChange({ ...form, endsAt: '2027-06-25T07:00', allowDonation: false, cashAlertEur: '0', refundDeadline: '' }, settings, TZ);
    expect(changed).toEqual({
      ok: true,
      change: { eventEndsAt: '2027-06-25T05:00:00.000Z', allowDonation: false, cashAlertCents: 0, refundDeadline: null },
    });
    expect(partySettingsChange({ ...form, startsAt: '', endsAt: '' }, settings, TZ)).toEqual({
      ok: true,
      change: { eventStartsAt: null, eventEndsAt: null },
    });
  });

  it('lo que no vale: el fin antes del inicio, la devolución antes del fin, el umbral', () => {
    const form = partySettingsFormFrom(settings, TZ);
    expect(partySettingsChange({ ...form, endsAt: '2027-06-23T19:00' }, settings, TZ)).toEqual({
      ok: false,
      problem: 'El fin de la fiesta tiene que ser después del inicio.',
    });
    expect(partySettingsChange({ ...form, refundDeadline: '2027-06-24' }, settings, TZ)).toMatchObject({ ok: false });
    expect(partySettingsChange({ ...form, cashAlertEur: 'mucho' }, settings, TZ)).toMatchObject({ ok: false, problem: expect.stringContaining('0 = sin aviso') });
    expect(partySettingsChange({ ...form, startsAt: '2027-13-01T20:00' }, settings, TZ)).toMatchObject({ ok: false });
  });

  it('terminada la fiesta, el fin no se quita ni se retrasa (como el API: EVENT_LOCKED); adelantarlo y lo demás, sí', () => {
    const ended = { ...settings, eventEnded: true };
    const form = partySettingsFormFrom(ended, TZ);
    const locked = { ok: false, problem: expect.stringContaining('no se puede quitar ni retrasar') };
    expect(partySettingsChange({ ...form, endsAt: '' }, ended, TZ)).toEqual(locked);
    expect(partySettingsChange({ ...form, endsAt: '2027-06-25T07:00' }, ended, TZ)).toEqual(locked);
    expect(partySettingsChange({ ...form, endsAt: '2027-06-25T05:00' }, ended, TZ)).toEqual({ ok: true, change: { eventEndsAt: '2027-06-25T03:00:00.000Z' } });
    expect(partySettingsChange({ ...form, allowDonation: false, cashAlertEur: '0' }, ended, TZ)).toEqual({ ok: true, change: { allowDonation: false, cashAlertCents: 0 } });
    // Con la fiesta en marcha, retrasarlo o quitarlo vale.
    expect(partySettingsChange({ ...form, endsAt: '' }, settings, TZ)).toMatchObject({ ok: true });
  });
});

describe('el cierre', () => {
  it('cada fila: el %, «Barra propia», «Sin caseta» y el estado de su cuenta', () => {
    const rows = plain(sampleSettlement().rows.map(settlementRowView));
    expect(rows.map((r) => [r.name, r.sold, r.percent, r.organizer, r.pay, r.status.text])).toEqual([
      ['Peña El Cántaro', '7.920,00 €', '10 %', '792,00 €', '7.128,00 €', 'IBAN listo'],
      ['Barra de la Comisión', '3.260,00 €', 'Barra propia', '3.260,00 €', '—', 'No se paga'],
      ['Churrería San Juan', '1.840,00 €', '8 %', '147,20 €', '1.692,80 €', 'Falta IBAN'],
    ]);
    const none = settlementRowView({ ...sampleSettlement().rows[1]!, stallId: null, name: 'Sin caseta', managerName: null });
    expect(none.percent).toBe('Del organizador');
  });

  it('antes de descargar el fichero del banco: lo que falta y si se puede', () => {
    expect(sepaReadiness(sampleSettlement())).toEqual({
      can: true,
      notes: ['1 caseta no tiene IBAN: no van en el fichero. Pónselo en Casetas o págales aparte.'],
    });
    const noDebtor = sepaReadiness(sampleSettlement({ debtor: { name: 'X', ibanMasked: null } }));
    expect(noDebtor.can).toBe(false);
    expect(noDebtor.notes[0]).toContain('la pone OxioPay');
    const nothing = sepaReadiness(sampleSettlement({ totals: { ...sampleSettlement().totals, transfers: 0, missingIban: 0 } }));
    expect(nothing).toEqual({ can: false, notes: ['No hay transferencias que hacer: ninguna caseta tiene IBAN y algo que cobrar.'] });
    expect(transfersText(1)).toBe('1 transferencia');
    expect(transfersText(5)).toBe('5 transferencias');
  });

  it('lo que sobró en las pulseras: cargado − vendido, devuelto y lo que queda', () => {
    expect(plain(leftoverView(sampleSettlement()))).toEqual({
      leftover: '1.980,00 €',
      formula: 'Cargado 15.000,00 € − vendido 13.020,00 €',
      refunded: '1.200,00 €',
      left: '780,00 €',
      refundedPct: 61,
    });
  });

  it('las noches: las dos o ninguna, y en orden', () => {
    expect(rangeProblem('', '')).toBeNull();
    expect(rangeProblem('2027-06-23', '2027-06-24')).toBeNull();
    expect(rangeProblem('2027-06-23', '')).toContain('la primera y la última');
    expect(rangeProblem('2027-06-24', '2027-06-23')).toBe('La última noche es anterior a la primera.');
  });
});
