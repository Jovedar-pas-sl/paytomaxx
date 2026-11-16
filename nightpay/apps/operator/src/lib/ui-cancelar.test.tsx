import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CancelCobroConfirm } from '../components/CancelCobroConfirm';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const noop = () => undefined;

describe('«¿Cancelar este cobro?»', () => {
  it('siempre pide confirmar: «Cancelar cobro» (peligroso) y «Volver»', () => {
    const html = renderToStaticMarkup(<CancelCobroConfirm open atBank={false} busy={false} onConfirm={noop} onClose={noop} />);
    expect(html).toContain('¿Cancelar este cobro?');
    expect(html).toMatch(/data-variant="danger"[^>]*>(<[^>]+>)*Cancelar cobro/);
    expect(html).toContain('Volver');
    expect(html).not.toContain('Está pagando en su banco');
  });

  it('con el cliente en su banco, además, que el pago puede entrar igual', () => {
    const html = renderToStaticMarkup(<CancelCobroConfirm open atBank busy={false} detail="C-0012 · 12 € · de Lucía" onConfirm={noop} onClose={noop} />);
    expect(html).toContain('Está pagando en su banco. Si lo termina, el pago entrará igual y te avisaremos para devolverlo.');
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
