import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CancelCobroConfirm } from '../components/CancelCobroConfirm';
import { UnpaidInVenue } from '../components/UnpaidInVenue';
import type { UnpaidRow } from './api-sin-pagar';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => undefined;

describe('«¿Cancelar este cobro?»', () => {
  it('siempre pide confirmar: «Cancelar cobro» (peligroso) y «Volver»', () => {
    const html = renderToStaticMarkup(<CancelCobroConfirm open atBank={false} busy={false} onConfirm={noop} onClose={noop} />);
    expect(html).toContain('¿Cancelar este cobro?');
    expect(html).toMatch(/data-variant="danger"[^>]*>(<[^>]+>)*Cancelar cobro/);
    expect(html).toContain('Volver');
    expect(html).not.toContain('su banco');
  });

  it('con el cliente en su banco (pasados los 2 minutos), además, que si su banco lo cobra después se avisa para devolverlo', () => {
    const html = renderToStaticMarkup(<CancelCobroConfirm open atBank busy={false} detail="C-0012 · 12 € · de Lucía" onConfirm={noop} onClose={noop} />);
    expect(html).toContain('Si su banco lo cobra después, te avisaremos para devolverlo');
    expect(html).toContain('C-0012 · 12 € · de Lucía');
  });

  it('Esperando, el QR del cobro y «Cobros» cancelan pasando por la confirmación', () => {
    const esperando = read('../components/cobrar/Esperando.tsx');
    expect(esperando).toContain('onClick={() => setConfirming(true)} disabled={canceling}');
    expect(esperando).not.toMatch(/onClick=\{\(\) => void cancel\(\)\}/);
    const active = read('../components/ActivePayment.tsx');
    expect(active).toContain("preCobro || shown === 'AUTHORIZING'");
    expect(active).toContain('<CancelCobroConfirm');
    const list = read('../components/MyCobros.tsx');
    expect(list).toContain('<UnpaidInVenue');
    expect(list).toContain('run: () => setConfirmRow(r)');
  });

  it('con el cliente en su banco: las cuatro pantallas usan la misma regla y un solo reloj', () => {
    // Esperando: el reloj de la espera del banco (el de la pastilla), pasado al pie.
    const esperando = read('../components/cobrar/Esperando.tsx');
    expect(esperando).toContain('cancelOffer(card, bankCancelOf(atBank, wait))');
    expect(esperando).toContain('{children(wait)}');
    expect(esperando.match(/useNow\(/g)).toHaveLength(1);
    // «Cobros»: un solo useNow para «Sin pagar» y las filas suyas; «Sin pagar» no lleva reloj propio.
    const list = read('../components/MyCobros.tsx');
    expect(list.match(/useNow\(/g)).toHaveLength(1);
    expect(list).toContain('ownRowBank(r, unpaid.items, now)');
    const unpaid = read('../components/UnpaidInVenue.tsx');
    expect(unpaid).not.toMatch(/useNow\(|usePolling\(|setInterval\(/);
    expect(unpaid).toContain("bank === 'wait' ? null");
    // El QR del cobro (recepción): sin botón en los primeros 2 minutos.
    const active = read('../components/ActivePayment.tsx');
    expect(active).toContain("bank === 'free' || bank === 'late'");
    expect(active.match(/useNow\(/g)).toHaveLength(1);
  });
});

describe('«Sin pagar en el local» con el cliente en su banco', () => {
  const T0 = Date.parse('2026-11-16T23:40:00.000Z');
  const banco: UnpaidRow = {
    id: 'p1',
    ref: 'C-0031',
    totalCents: 2400,
    status: 'AUTHORIZING',
    createdAt: '2026-11-16T23:38:00.000Z',
    createdByName: 'Lucía',
    mine: false,
    atBank: true,
    bitcoin: false,
    atBankSince: '2026-11-16T23:39:00.000Z',
    cancelableInMs: 60_000,
    cancelableAtMs: T0 + 60_000,
  };
  const list = (nowMs: number, rows: UnpaidRow[] = [banco]) =>
    renderToStaticMarkup(<UnpaidInVenue items={rows} nowMs={nowMs} refresh={noop} ownListCancels={false} onCanceled={noop} />);

  it('los primeros 2 minutos: «El cliente está pagando en su banco» y sin botón', () => {
    const html = list(T0);
    expect(html).toContain('El cliente está pagando en su banco');
    expect(html).not.toContain('Cancelar el cobro');
  });

  it('pasados: «El banco tarda. Si el cliente no ha pagado, puedes cancelar» y el botón', () => {
    const html = list(T0 + 60_000);
    expect(html).toContain('El banco tarda. Si el cliente no ha pagado, puedes cancelar');
    expect(html).toContain('Cancelar el cobro C-0031');
  });

  it('con bitcoin o sin empezar a pagar: el botón, como siempre', () => {
    const btc: UnpaidRow = { ...banco, id: 'p2', atBank: false, bitcoin: true, atBankSince: null, cancelableInMs: 0, cancelableAtMs: null };
    const qr: UnpaidRow = { ...banco, id: 'p3', ref: 'C-0032', status: 'CREATED', atBank: false, atBankSince: null, cancelableInMs: 0, cancelableAtMs: null };
    const html = list(T0, [btc, qr]);
    expect(html).toContain('Pagando con bitcoin');
    expect(html).toContain('Cancelar el cobro C-0031');
    expect(html).toContain('Cancelar el cobro C-0032');
  });
});

describe('Recepción → Incidencias: «Pagó después de cancelar»', () => {
  it('la ve recepción; sin poder cerrarla, lo dice; al cerrarla manda su tipo', () => {
    const inbox = read('../components/reception/ReceptionIncidents.tsx');
    expect(inbox).toContain('Lo cierra el encargado o el dueño: devuelto en el banco o dado por bueno.');
    expect(inbox).toContain('closeReceptionIncident(row.refId, note, row.kind)');
    const client = read('./api-incidencias.ts');
    expect(client).toContain("kind: 'wallet_charge_disputed' | 'approval_unbooked'");
    expect(client).toContain('JSON.stringify({ kind, refId, note: note.trim() })');
  });
});
