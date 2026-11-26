import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateRange } from '../components/DateRange';
import { PayoutAccountLine } from '../components/PayoutProfile';
import { PayoutList, PayoutsReceived } from '../components/PayoutsReceived';
import type { MyPayout } from './api';

describe('su cuenta de cobro en «Mi perfil»', () => {
  it('tapada, con el texto para cambiarla (sin botón: la cambia el encargado)', () => {
    const html = renderToStaticMarkup(<PayoutAccountLine account={{ method: 'SEPA_IBAN', masked: 'ES91 •••• •••• 1332', label: 'Mi banco' }} />);
    expect(html).toContain('ES91 •••• •••• 1332');
    expect(html).toContain('Mi banco');
    expect(html).toContain('Para cambiarla, pídeselo al encargado.');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('21000418450200051332');
  });

  it('sin cuenta, o sin poder cargarla: lo dice', () => {
    expect(renderToStaticMarkup(<PayoutAccountLine account={null} />)).toContain('Aún no tienes cuenta de cobro: pídesela al encargado.');
    expect(renderToStaticMarkup(<PayoutAccountLine account={false} />)).toContain('No se ha podido cargar tu cuenta de cobro');
  });
});

// El panel de la compañera (19-nov-2026): el justificante de cada pago (enlace
// solo https) y «Buscar por fechas». Se pintan con react-dom/server: solo el marcado.

const payout = (over: Partial<MyPayout> = {}): MyPayout => ({
  id: 'p-1',
  totalCents: 3_750,
  paidByEmail: 'jefe@local.es',
  notes: null,
  earningCount: 3,
  createdAt: '2026-11-13T10:00:00.000Z',
  externalRail: 'SEPA_IBAN',
  externalTxId: 'ES-TRF-20261113-04',
  receiptUrl: 'https://banco.example/j/4',
  ...over,
});

describe('el justificante de cada pago', () => {
  it('la referencia y «Ver justificante», que se abre aparte sin pasar nada de la app', () => {
    const html = renderToStaticMarkup(<PayoutList payouts={[payout()]} />);
    expect(html).toContain('Referencia: ES-TRF-20261113-04');
    expect(html).toContain('href="https://banco.example/j/4"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Ver justificante');
    expect(html).not.toContain('jefe@local.es');
  });

  it('un enlace que no es https no se enseña; sin justificante, nada', () => {
    for (const receiptUrl of ['http://banco.example/j/4', 'javascript:alert(1)', null]) {
      const html = renderToStaticMarkup(<PayoutList payouts={[payout({ receiptUrl })]} />);
      expect(html, String(receiptUrl)).not.toContain('<a');
      expect(html).not.toContain('Ver justificante');
    }
    expect(renderToStaticMarkup(<PayoutList payouts={[payout({ externalTxId: null, receiptUrl: null })]} />)).not.toContain('Referencia');
  });

  it('«Ver todos los pagos» solo si hay pagos', () => {
    expect(renderToStaticMarkup(<PayoutsReceived payouts={[payout()]} account={null} onAll={() => undefined} />)).toContain('Ver todos los pagos');
    expect(renderToStaticMarkup(<PayoutsReceived payouts={[]} account={null} onAll={() => undefined} />)).not.toContain('Ver todos los pagos');
  });
});

describe('«Buscar por fechas»', () => {
  const noop = () => undefined;

  it('sin fechas: solo el botón', () => {
    const html = renderToStaticMarkup(<DateRange value={{ fromDay: '', toDay: '' }} onChange={noop} />);
    expect(html).toContain('Buscar por fechas');
    expect(html).not.toContain('type="date"');
  });

  it('con fechas: desde y hasta (de 16 px), cuándo acaba cada noche y «Quitar fechas»', () => {
    const html = renderToStaticMarkup(<DateRange value={{ fromDay: '2026-11-01', toDay: '2026-11-15' }} onChange={noop} />);
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toContain('value="2026-11-01"');
    expect(html).toContain('Desde');
    expect(html).toContain('Hasta');
    expect(html).toContain('Cada noche cuenta hasta las 8:00 del día siguiente.');
    expect(html).toContain('Quitar fechas');
    // 16 px: ahora lo pone el campo común desde pieces.css (.np-field-input), no un estilo en línea.
    expect(html.match(/class="np-field-input"/g)).toHaveLength(2);
    const pieces = readFileSync(new URL('../../../../packages/ui/src/pieces.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(pieces).toMatch(/\n\.np-field-input \{[^}]*font-size: var\(--np-fs-16\);/);
  });

  it('«Desde» después de «Hasta»: lo dice', () => {
    const html = renderToStaticMarkup(<DateRange value={{ fromDay: '2026-11-15', toDay: '2026-11-01' }} onChange={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('«Desde» tiene que ser antes que «Hasta».');
  });
});
