import { describe, it, expect } from 'vitest';
import { publicId } from '@nightpay/contracts';
import { recargasEfectivoCsv, recargasSociosCsv, summarize } from './export-csv';
import type { RecargaEfectivoRow, RecargaSocioRow } from './export-rows';

/**
 * Las cargas de los cajeros de otras plataformas (API de socios, PR 3 B) en
 * los CSV: `recargas-socios` (cada carga a su hora y cada anulación a la suya,
 * en negativo y con el cajero de su carga) y «{socio} (plataforma)» en
 * `recargas-efectivo`. Lo que escribe el socio o el local va como texto.
 */

const LOAD_ID = '2b1c6d1e-7f00-4c3a-9a65-0d1f5a9e0b01';
const VOID_ID = '9a0e3c55-1b2d-4e6f-8a7b-3c4d5e6f7a8b';
const OTHER_LOAD = '6f5e4d3c-2b1a-4098-8765-43210fedcba9';
const AT = new Date('2026-11-27T23:15:00Z');
const LATER = new Date('2026-11-28T00:40:00Z');

const load: RecargaSocioRow = {
  id: LOAD_ID, loadId: LOAD_ID, kind: 'LOAD', at: AT, amountCents: 3000, funding: 'cash', partnerName: 'Cajeros Beta',
  device: 'ATM0042', reference: 'TX-1', description: '=1+1', reason: null, voidedByName: null, voidedByEmail: null,
};
const voidByPanel: RecargaSocioRow = {
  id: VOID_ID, loadId: OTHER_LOAD, kind: 'LOAD_VOID', at: LATER, amountCents: 2500, funding: 'cash', partnerName: 'Cajeros Beta',
  device: 'ATM0007', reference: 'TX-0', description: 'Recarga en cajero 0007', reason: '@billete falso', voidedByName: 'Marta', voidedByEmail: 'marta@local.es',
};
const voidByApi: RecargaSocioRow = { ...voidByPanel, id: 'v2', loadId: LOAD_ID, at: LATER, amountCents: 3000, device: 'ATM0042', reason: null, voidedByName: null, voidedByEmail: null };

const lines = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');

describe('CSV «recargas-socios»', () => {
  it('columnas y orden', () => {
    const [header] = lines(recargasSociosCsv([load]));
    expect(header).toBe(
      'Fecha;Hora;Plataforma;Tipo;Importe;Forma de pago;Cajero;Referencia del socio;Descripción;Motivo;Anulada por;Carga',
    );
  });

  it('la carga, con su cajero y su id público; la descripción `=1+1` va como texto, no como fórmula', () => {
    const [, row] = lines(recargasSociosCsv([load]));
    expect(row).toBe(`28/11/2026;00:15;Cajeros Beta;Carga;30,00;Efectivo;ATM0042;TX-1;'=1+1;;;${publicId('wl', LOAD_ID)}`);
  });

  it('la anulación, en negativo, con el cajero de su carga y quién la anuló', () => {
    const [, panel, api] = lines(recargasSociosCsv([voidByPanel, voidByApi]));
    expect(panel).toBe(
      `28/11/2026;01:40;Cajeros Beta;Anulación;-25,00;Efectivo;ATM0007;TX-0;Recarga en cajero 0007;'@billete falso;Marta;${publicId('wl', OTHER_LOAD)}`,
    );
    expect(api).toMatch(/;Anulación;-30,00;Efectivo;ATM0042;.*;La plataforma;wl_/);
  });

  it('el nombre del socio también va como texto', () => {
    const [, row] = lines(recargasSociosCsv([{ ...load, partnerName: '+Cajeros', description: 'Recarga' }]));
    expect(row).toContain(";'+Cajeros;Carga;");
  });
});

describe('«{socio} (plataforma)» en recargas-efectivo', () => {
  const reception: RecargaEfectivoRow = { id: 'ct-1', at: AT, amountCents: 5000, takenByName: 'Javi', takenByEmail: 'javi@local.es', terminalLabel: null };
  const partner: RecargaEfectivoRow = {
    id: 'ct-2', at: AT, amountCents: 3000, takenByName: null, takenByEmail: null, terminalLabel: null,
    partnerConnectionId: 'pc-1', partnerName: 'Cajeros Beta',
  };
  // Anulada en el panel: la fila lleva a la persona, pero el efectivo lo cobró el cajero.
  const partnerVoid: RecargaEfectivoRow = { ...partner, id: 'ct-3', amountCents: -3000, voidOfId: 'ct-2', takenByName: 'Marta', reason: 'Billete falso' };

  it('«Cobrada por» dice «{socio} (plataforma)» en las filas de un socio; las de recepción, la persona', () => {
    const [, r, p, v] = lines(recargasEfectivoCsv([reception, partner, partnerVoid]));
    expect(r).toContain(';Javi;');
    expect(p).toContain(';Cajeros Beta (plataforma);');
    expect(v).toContain(';Cajeros Beta (plataforma);');
  });

  it('el resumen del Z sigue contando una vez la recarga del cajero (dinero del local)', () => {
    const s = summarize([], [], [], [], [], [reception, partner]);
    expect(s).toMatchObject({ walletCashTopUpsCount: 2, walletCashTopUpsCents: 8000, chargedCents: 8000 });
  });
});
