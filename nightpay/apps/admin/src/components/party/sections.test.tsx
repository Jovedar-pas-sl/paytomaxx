import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PartyRefundRow, PulseraRow } from '@nightpay/contracts';
import { DevolucionesSection, RefundTable } from './DevolucionesSection';
import { PulseraList } from './PulserasSection';

// Pulseras y Devoluciones con datos: qué botón sale en cada fila y que nada
// del asistente que no haga falta (el IBAN entero) llegue a la pantalla.

const refund = (o: Partial<PartyRefundRow>): PartyRefundRow => ({
  id: 'r',
  method: 'CARD',
  status: 'PENDING',
  amountCents: 1300,
  createdAt: '2027-06-25T09:00:00.000Z',
  doneAt: null,
  doneByName: null,
  pulsera: 'P-0412',
  walletCode: 'K7Q-4M2',
  ibanHint: null,
  holderName: null,
  email: null,
  ...o,
});

const pulsera = (o: Partial<PulseraRow>): PulseraRow => ({
  id: 'p',
  number: 412,
  label: 'P-0412',
  status: 'ISSUED',
  walletCode: 'K7Q-4M2',
  balanceCents: 1300,
  hasUid: true,
  stockedAt: null,
  linkedAt: null,
  lastUsedAt: null,
  blockedAt: null,
  lostAt: null,
  ...o,
});

describe('Devoluciones con datos', () => {
  it('«Hecha» en la de tarjeta y la transferencia pendientes; la donada y la hecha, sin botones', () => {
    const html = renderToStaticMarkup(
      <RefundTable
        tz="Europe/Madrid"
        disabled={false}
        onAct={() => undefined}
        rows={[
          refund({ id: 'a' }),
          refund({ id: 'b', method: 'TRANSFER', ibanHint: 'ES91 •••• •••• 1332', holderName: 'Ana Pérez Núñez', email: 'ana@correo.es' }),
          refund({ id: 'c', method: 'DONATE', status: 'DONE', doneAt: '2027-06-25T09:00:00.000Z' }),
          refund({ id: 'd', status: 'DONE', doneAt: '2027-06-26T10:00:00.000Z', doneByName: 'Lola' }),
        ]}
      />,
    );
    expect(html.match(/>Hecha<\/button>/g)).toHaveLength(2);
    expect(html.match(/>Anular<\/button>/g)).toHaveLength(2);
    expect(html).toContain('ES91 •••• •••• 1332');
    expect(html).toContain('Ana Pérez Núñez');
    expect(html).toContain('Donado');
    expect(html).toContain('· Lola');
    expect(html).not.toContain('ES9121000418450200051332');
  });
});

describe('Devoluciones: las transferencias para el banco', () => {
  it('el botón del fichero SEPA junto al CSV (apagados mientras no hay pendientes)', () => {
    const html = renderToStaticMarkup(<DevolucionesSection />).replace(/<!-- -->/g, '');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fichero SEPA \(0\)<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Exportar CSV<\/button>/);
    expect(html).toContain('subirlas a tu banco de una vez');
    expect(html).not.toContain('no sale de aquí');
  });
});

describe('Pulseras con datos', () => {
  it('cada una con su número, estado en palabras, lo que le queda y sus botones', () => {
    const html = renderToStaticMarkup(
      <PulseraList
        tz="Europe/Madrid"
        query=""
        onChanged={() => undefined}
        rows={[
          pulsera({ id: 'a' }),
          pulsera({ id: 'b', number: 413, label: 'P-0413', status: 'STOCK', walletCode: null, balanceCents: null, hasUid: false }),
          pulsera({ id: 'c', number: 414, label: 'P-0414', status: 'LOST' }),
        ]}
      />,
    );
    expect(html).toContain('P-0412');
    expect(html).toContain('Entregada');
    expect(html).toContain('En stock');
    expect(html).toContain('Sin leer aún por NFC');
    expect(html.match(/>Bloquear<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Pasar a otra<\/button>/g)).toHaveLength(2);
  });

  it('sin pulseras, cómo empezar', () => {
    expect(renderToStaticMarkup(<PulseraList tz="Europe/Madrid" query="" onChanged={() => undefined} rows={[]} />)).toContain('prepáralas arriba');
    expect(renderToStaticMarkup(<PulseraList tz="Europe/Madrid" query="P-9" onChanged={() => undefined} rows={[]} />)).toContain('Ninguna pulsera con eso');
  });
});
