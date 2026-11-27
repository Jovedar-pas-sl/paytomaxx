import { describe, expect, it } from 'vitest';
import {
  cobrosVentana,
  escribirFechas,
  etiquetaPeriodo,
  fechasValidas,
  inicioDiaMadrid,
  leerFechas,
  lineaPeriodo,
  mapaQuery,
  nombreNoche,
  resolverPeriodo,
  type NocheLista,
  type Periodo,
} from './periodos';

/** Noviembre: Madrid va a UTC+1. La lista, como fetchNights(): de nueva a vieja. */
const N4: NocheLista = { id: 'n4', openedAt: '2026-11-15T21:00:00.000Z', closedAt: '2026-11-16T05:00:00.000Z' };
const N3: NocheLista = { id: 'n3', openedAt: '2026-11-14T21:04:00.000Z', closedAt: '2026-11-15T05:31:00.000Z' };
const N2: NocheLista = { id: 'n2', openedAt: '2026-11-13T21:00:00.000Z', closedAt: '2026-11-14T05:00:00.000Z' };
const N1: NocheLista = { id: 'n1', openedAt: '2026-11-12T21:00:00.000Z', closedAt: '2026-11-13T05:00:00.000Z' };
const NIGHTS = [N4, N3, N2, N1];
const at = (iso: string) => new Date(iso);
const P = (clave: Exclude<Periodo['clave'], 'noche' | 'fechas'>): Periodo => ({ clave });

describe('una noche cuenta como su Z', () => {
  it('desde el cierre de la anterior (la siguiente de la lista) hasta su cierre; la más vieja, desde su apertura', () => {
    const r = resolverPeriodo({ clave: 'noche', id: 'n3' }, NIGHTS, at('2026-11-20T12:00:00Z'));
    expect(r).toMatchObject({ tipo: 'noches', ids: ['n3'], fromAt: N2.closedAt, toAt: N3.closedAt });
    const vieja = resolverPeriodo({ clave: 'noche', id: 'n1' }, NIGHTS, at('2026-11-20T12:00:00Z'));
    expect(vieja).toMatchObject({ fromAt: N1.openedAt, toAt: N1.closedAt });
  });

  it('una recarga a las 17:00 entre dos noches cae en la segunda', () => {
    const recarga = Date.parse('2026-11-14T16:00:00Z'); // sáb 14, 17:00 en Madrid
    const segunda = resolverPeriodo({ clave: 'noche', id: 'n3' }, NIGHTS, at('2026-11-20T12:00:00Z'));
    const primera = resolverPeriodo({ clave: 'noche', id: 'n2' }, NIGHTS, at('2026-11-20T12:00:00Z'));
    if (segunda.tipo !== 'noches' || primera.tipo !== 'noches') throw new Error('noches');
    expect(Date.parse(segunda.fromAt) <= recarga && recarga < Date.parse(segunda.toAt!)).toBe(true);
    expect(recarga < Date.parse(primera.toAt!)).toBe(false);
  });

  it('su nombre es el día de Madrid de la apertura menos 8 h: abierta a la 01:00 del domingo es la del sábado', () => {
    expect(nombreNoche('2026-11-15T00:00:00.000Z')).toBe('2026-11-14');
    expect(nombreNoche(N3.openedAt)).toBe('2026-11-14');
    // 08:30 de Madrid ya es la noche de ese día.
    expect(nombreNoche('2026-11-15T07:30:00.000Z')).toBe('2026-11-15');
  });
});

describe('Esta noche', () => {
  it('con una abierta: la abierta, desde el cierre anterior y hasta ahora', () => {
    const open = { id: 'n5', openedAt: '2026-11-16T21:00:00.000Z', closedAt: null };
    const r = resolverPeriodo(P('esta-noche'), [open, ...NIGHTS], at('2026-11-17T01:00:00Z'));
    expect(r).toMatchObject({ tipo: 'noches', ids: ['n5'], fromAt: N4.closedAt, toAt: null });
    expect(mapaQuery(P('esta-noche'), r)).toEqual({});
    expect(cobrosVentana(r)).toEqual({ from: N4.closedAt });
    expect(lineaPeriodo(r)).toBe('Noche del lun 16, abierta desde las 22:00');
  });

  it('sin abierta: desde el último cierre', () => {
    const r = resolverPeriodo(P('esta-noche'), NIGHTS, at('2026-11-16T15:00:00Z'));
    expect(r).toMatchObject({ tipo: 'noches', ids: [], fromAt: N4.closedAt, toAt: null });
    expect(mapaQuery(P('esta-noche'), r)).toEqual({});
    expect(cobrosVentana(r)).toEqual({ from: N4.closedAt });
    expect(lineaPeriodo(r)).toBe('Sin noche abierta: desde el último cierre, a las 06:00');
  });

  it('sin noches: desde las últimas 08:00 de Madrid', () => {
    const tarde = resolverPeriodo(P('esta-noche'), [], at('2026-11-16T15:00:00Z'));
    expect(tarde).toMatchObject({ fromAt: '2026-11-16T07:00:00.000Z', toAt: null });
    const madrugada = resolverPeriodo(P('esta-noche'), [], at('2026-11-16T03:00:00Z'));
    expect(madrugada).toMatchObject({ fromAt: '2026-11-15T07:00:00.000Z' });
    expect(cobrosVentana(madrugada)).toEqual({ from: '2026-11-15T07:00:00.000Z' });
  });
});

describe('Anoche, finde y 7 noches', () => {
  it('anoche: la última cerrada (con una abierta, la de antes)', () => {
    const r = resolverPeriodo(P('anoche'), NIGHTS, at('2026-11-16T15:00:00Z'));
    expect(r).toMatchObject({ ids: ['n4'], fromAt: N3.closedAt, toAt: N4.closedAt });
    expect(mapaQuery(P('anoche'), r)).toEqual({ night: 'n4' });
    expect(cobrosVentana(r)).toEqual({ from: N3.closedAt, to: N4.closedAt });
    const open = { id: 'n5', openedAt: '2026-11-16T21:00:00.000Z', closedAt: null };
    expect(resolverPeriodo(P('anoche'), [open, ...NIGHTS], at('2026-11-17T01:00:00Z'))).toMatchObject({ ids: ['n4'] });
    expect(resolverPeriodo(P('anoche'), [], at('2026-11-17T01:00:00Z'))).toEqual({ tipo: 'vacio' });
  });

  it('finde visto el martes: el último (vie 13, sáb 14 y dom 15)', () => {
    const r = resolverPeriodo(P('finde'), NIGHTS, at('2026-11-17T12:00:00Z'));
    expect(r).toMatchObject({ tipo: 'noches', ids: ['n4', 'n3', 'n2'], fromAt: N1.closedAt, toAt: N4.closedAt });
    expect(mapaQuery(P('finde'), r)).toEqual({ fromAt: N1.closedAt, toAt: N4.closedAt });
    expect(cobrosVentana(r)).toEqual({ from: N1.closedAt, to: N4.closedAt });
    expect(lineaPeriodo(r)).toBe('3 noches: vie 13, sáb 14 y dom 15');
  });

  it('finde visto el viernes por la tarde: el que empieza (aún sin noches: vacío)', () => {
    expect(resolverPeriodo(P('finde'), NIGHTS, at('2026-11-20T16:00:00Z'))).toEqual({ tipo: 'vacio' });
    const open = { id: 'n6', openedAt: '2026-11-20T21:00:00.000Z', closedAt: null };
    const r = resolverPeriodo(P('finde'), [open, ...NIGHTS], at('2026-11-20T23:00:00Z'));
    expect(r).toMatchObject({ ids: ['n6'], toAt: null });
    expect(mapaQuery(P('finde'), r)).toEqual({ night: 'n6' });
  });

  it('finde visto el domingo y el lunes a las 03:00: el que está en curso', () => {
    const domingo = resolverPeriodo(P('finde'), [N3, N2, N1], at('2026-11-15T18:00:00Z'));
    expect(domingo).toMatchObject({ ids: ['n3', 'n2'] });
    const open = { id: 'n4', openedAt: N4.openedAt, closedAt: null };
    const lunes = resolverPeriodo(P('finde'), [open, N3, N2, N1], at('2026-11-16T02:00:00Z'));
    expect(lunes).toMatchObject({ ids: ['n4', 'n3', 'n2'], fromAt: N1.closedAt, toAt: null });
    expect(mapaQuery(P('finde'), lunes)).toEqual({ fromAt: N1.closedAt });
    expect(cobrosVentana(lunes)).toEqual({ from: N1.closedAt });
  });

  it('7 noches habiendo 3: las 3, con la abierta', () => {
    const open = { id: 'n3', openedAt: N3.openedAt, closedAt: null };
    const r = resolverPeriodo(P('7noches'), [open, N2, N1], at('2026-11-15T01:00:00Z'));
    expect(r).toMatchObject({ ids: ['n3', 'n2', 'n1'], fromAt: N1.openedAt, toAt: null });
    expect(lineaPeriodo(r)).toBe('3 noches: jue 12, vie 13 y sáb 14');
  });

  it('7 noches de 9: las 7 últimas, del día de la más vieja al de la más nueva', () => {
    const many: NocheLista[] = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      openedAt: new Date(Date.parse('2026-11-15T21:00:00Z') - i * 86_400_000).toISOString(),
      closedAt: new Date(Date.parse('2026-11-16T05:00:00Z') - i * 86_400_000).toISOString(),
    }));
    const r = resolverPeriodo(P('7noches'), many, at('2026-11-16T12:00:00Z'));
    expect(r).toMatchObject({ ids: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'], fromAt: many[7]!.closedAt, toAt: many[0]!.closedAt });
    expect(lineaPeriodo(r)).toBe('7 noches, del lun 9 al dom 15');
  });

  it('una noche cerrada: su línea con la hora de apertura y la de cierre', () => {
    const r = resolverPeriodo({ clave: 'noche', id: 'n3' }, NIGHTS, at('2026-11-20T12:00:00Z'));
    expect(lineaPeriodo(r)).toBe('Noche del sáb 14, de 22:04 a 06:31');
    expect(etiquetaPeriodo({ clave: 'noche', id: 'n3' }, NIGHTS)).toBe('Noche del sáb 14');
    expect(resolverPeriodo({ clave: 'noche', id: 'nada' }, NIGHTS, at('2026-11-20T12:00:00Z'))).toEqual({ tipo: 'vacio' });
    expect(lineaPeriodo({ tipo: 'vacio' })).toBe('No abriste ninguna noche esos días');
  });
});

describe('calendario: días naturales de Madrid', () => {
  it('este mes y mes pasado (en enero, diciembre del año anterior)', () => {
    const mes = resolverPeriodo(P('mes'), NIGHTS, at('2026-11-25T12:00:00Z'));
    expect(mes).toEqual({ tipo: 'dias', desde: '2026-11-01', hasta: '2026-11-25' });
    expect(mapaQuery(P('mes'), mes)).toEqual({ from: '2026-11-01', to: '2026-11-25' });
    expect(cobrosVentana(mes)).toEqual({ from: '2026-10-31T23:00:00.000Z', to: '2026-11-25T23:00:00.000Z' });
    expect(lineaPeriodo(mes, at('2026-11-25T12:00:00Z'))).toBe('Del 1 al 25 de noviembre, por días naturales');
    const enero = resolverPeriodo(P('mes-pasado'), [], at('2027-01-10T12:00:00Z'));
    expect(enero).toEqual({ tipo: 'dias', desde: '2026-12-01', hasta: '2026-12-31' });
    expect(lineaPeriodo(enero, at('2027-01-10T12:00:00Z'))).toBe('Del 1 al 31 de diciembre de 2026, por días naturales');
  });

  it('elegir fechas: de inicioDiaMadrid(desde) a inicioDiaMadrid(hasta + 1)', () => {
    const r = resolverPeriodo({ clave: 'fechas', desde: '2026-10-20', hasta: '2026-11-03' }, [], at('2026-11-25T12:00:00Z'));
    expect(cobrosVentana(r)).toEqual({ from: '2026-10-19T22:00:00.000Z', to: '2026-11-03T23:00:00.000Z' });
    expect(lineaPeriodo(r, at('2026-11-25T12:00:00Z'))).toBe('Del 20 de octubre al 3 de noviembre, por días naturales');
  });

  it('cambios de hora: el día de marzo y el de octubre empiezan a su medianoche', () => {
    expect(inicioDiaMadrid('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(inicioDiaMadrid('2026-03-30').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(inicioDiaMadrid('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(inicioDiaMadrid('2026-10-26').toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // Una noche que cruza el cambio de octubre se llama por su día.
    expect(nombreNoche('2026-10-24T20:00:00.000Z')).toBe('2026-10-24');
    expect(nombreNoche('2026-10-25T22:30:00.000Z')).toBe('2026-10-25');
  });

  it('fechas válidas: en orden, como mucho 366 días y nada después de hoy', () => {
    expect(fechasValidas('2026-11-01', '2026-11-25', '2026-11-25')).toBe(true);
    expect(fechasValidas('2026-11-25', '2026-11-01', '2026-11-25')).toBe(false);
    expect(fechasValidas('2025-11-25', '2026-11-25', '2026-11-25')).toBe(true); // 366 días
    expect(fechasValidas('2025-11-24', '2026-11-25', '2026-11-25')).toBe(false);
    expect(fechasValidas('2026-11-20', '2026-11-26', '2026-11-25')).toBe(false);
    expect(fechasValidas('2026-02-30', '2026-03-01', '2026-11-25')).toBe(false);
  });
});

describe('?fechas= en la URL', () => {
  const now = at('2026-11-25T12:00:00Z');

  it('se leen las que se entienden', () => {
    expect(leerFechas('?fechas=anoche', now)).toEqual({ clave: 'anoche' });
    expect(leerFechas('?t=mapa&fechas=finde', now)).toEqual({ clave: 'finde' });
    expect(leerFechas('?fechas=7noches', now)).toEqual({ clave: '7noches' });
    expect(leerFechas('?fechas=mes', now)).toEqual({ clave: 'mes' });
    expect(leerFechas('?fechas=mes-pasado', now)).toEqual({ clave: 'mes-pasado' });
    expect(leerFechas('?fechas=2026-11-01_2026-11-25', now)).toEqual({ clave: 'fechas', desde: '2026-11-01', hasta: '2026-11-25' });
    expect(leerFechas('?t=mapa', now)).toBeNull();
  });

  it('una rota (o que no va en la URL) no se entiende', () => {
    for (const roto of ['ayer', 'esta-noche', 'trimestre-pasado', 'noche', '2026-11-25_2026-11-01', '2026-13-01_2026-13-02', '2024-01-01_2026-11-01', '2026-11-01_2026-12-30', '<script>']) {
      expect(leerFechas(`?fechas=${encodeURIComponent(roto)}`, now), roto).toBe('roto');
    }
  });

  it('se escribe sin tocar lo demás; Esta noche y Otra noche la quitan', () => {
    expect(escribirFechas('?s=hoy&t=mapa', { clave: 'finde' })).toBe('?s=hoy&t=mapa&fechas=finde');
    expect(escribirFechas('?s=hoy&t=mapa&fechas=finde', { clave: 'fechas', desde: '2026-11-01', hasta: '2026-11-25' })).toBe(
      '?s=hoy&t=mapa&fechas=2026-11-01_2026-11-25',
    );
    expect(escribirFechas('?s=hoy&t=mapa&fechas=finde', { clave: 'esta-noche' })).toBe('?s=hoy&t=mapa');
    expect(escribirFechas('?fechas=finde', { clave: 'noche', id: 'n3' })).toBe('');
  });
});

describe('filtro de Cobros en cada caso: siempre from/to, nunca nightId', () => {
  const now = at('2026-11-17T12:00:00Z');
  const casos: Periodo[] = [P('esta-noche'), P('anoche'), P('finde'), P('7noches'), P('mes'), P('mes-pasado'), { clave: 'noche', id: 'n2' }, { clave: 'fechas', desde: '2026-11-01', hasta: '2026-11-02' }];
  it.each(casos.map((c) => [JSON.stringify(c), c] as const))('%s', (_name, periodo) => {
    const v = cobrosVentana(resolverPeriodo(periodo, NIGHTS, now));
    expect(v).not.toBeNull();
    expect(Object.keys(v!).every((k) => k === 'from' || k === 'to')).toBe(true);
    expect(typeof v!.from).toBe('string');
    if (v!.to) expect(Date.parse(v!.to)).toBeGreaterThan(Date.parse(v!.from));
  });
  it('sin noches en el periodo: no se pide nada', () => {
    expect(cobrosVentana({ tipo: 'vacio' })).toBeNull();
    expect(mapaQuery(P('finde'), { tipo: 'vacio' })).toBeNull();
  });
});
