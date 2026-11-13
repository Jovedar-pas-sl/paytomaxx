'use client';

import { useState, type FormEvent } from 'react';
import { pulseraLabel, type PulseraRow, type PulserasView, type WalletCardStatus } from '@nightpay/contracts';
import { blockPulsera, downloadPulseraSheet, fetchPulseras, preparePulseras, replacePulsera } from '@/lib/endpoints/party-pulseras';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import {
  PULSERA_COUNT_LABEL,
  PULSERA_STATUSES,
  blockConfirmText,
  parseBatchCount,
  pulseraActions,
  pulseraFilters,
  pulseraNumberInput,
  pulseraStatusLabel,
  replaceDoneText,
  sheetFileName,
  sheetRangeProblem,
  sectionError,
} from '@/lib/party-asistente';
import { openPendingWindow, showPrintable } from '@/lib/save-file';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Chip, DayButton, DayCard, DayField, DayMessage, DaySelect, DayStyles, type ChipTone } from './asistente-ui';

const POLL_MS = 20_000;

const STATUS_TONE: Readonly<Record<WalletCardStatus, ChipTone>> = {
  STOCK: 'mute',
  ISSUED: 'ok',
  RETURNED: 'mute',
  LOST: 'warn',
  BLOCKED: 'bad',
};

/**
 * OxioParty · Pulseras (dueño y encargado): cuántas hay en cada estado,
 * preparar N de una vez y su hoja para imprimir (número y QR), el buscador
 * por número y, con una perdida, bloquearla y pasar su saldo a otra del stock.
 */
export function PulserasSection() {
  return <Pulseras />;
}

export default PulserasSection;

function Pulseras() {
  const tz = useVenueTimezone();
  const [view, setView] = useState<PulserasView | null>(null);
  const [status, setStatus] = useState<WalletCardStatus | ''>('');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = usePolling(
    async (signal) => {
      try {
        const next = await fetchPulseras({ q: query, status }, signal);
        if (signal.aborted) return true;
        setView(next);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError(sectionError(err, 'pulseras'));
        return false;
      }
    },
    { intervalMs: POLL_MS },
    [query, status],
  );

  function search(e: FormEvent): void {
    e.preventDefault();
    setQuery(draft.trim());
  }

  return (
    <div className="pa-root">
      <DayStyles />
      {error ? <DayMessage tone="bad">{error}{view ? ' Se siguen enseñando los últimos datos.' : ''}</DayMessage> : null}

      <section aria-label="Pulseras por estado" className="pa-counts">
        {PULSERA_STATUSES.map((s) => (
          <div className="pa-count" key={s}>
            <b>{view ? view.counts[s] : '—'}</b>
            <span>{PULSERA_COUNT_LABEL[s]}</span>
          </div>
        ))}
        <div className="pa-count">
          <b>{view ? view.counts.total : '—'}</b>
          <span>En total</span>
        </div>
      </section>

      <PrepareCard onPrepared={reload} />

      <DayCard title="Buscar una pulsera" labelId="pa-pulseras-lista" aside={<p className="pa-sub">Por su número (P-0412 o 412) o el código del saldo</p>}>
        <form className="pa-row" role="search" aria-label="Buscar pulseras" onSubmit={search}>
          <DayField id="pa-q" label="Número" placeholder="P-0412" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: '12rem' }} />
          <DayButton type="submit">Buscar</DayButton>
          <DaySelect id="pa-status" label="Estado" value={status} onChange={(e) => setStatus(e.target.value as WalletCardStatus | '')}>
            {pulseraFilters(view?.counts ?? null).map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </DaySelect>
        </form>
        <PulseraList rows={view?.rows ?? null} tz={tz} query={query} onChanged={reload} />
      </DayCard>
    </div>
  );
}

/** «Preparar pulseras»: cuántas, y luego su hoja (o la de otro rango). */
function PrepareCard(props: { onPrepared: () => void }) {
  const [count, setCount] = useState('100');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function prepare(e: FormEvent): Promise<void> {
    e.preventDefault();
    const n = parseBatchCount(count);
    if (n === null) return setMsg({ tone: 'bad', text: 'Escribe cuántas: de 1 a 500.' });
    if (!window.confirm(`¿Preparar ${n} pulseras nuevas? Salen con números seguidos, ya en el stock.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const made = await preparePulseras(n);
      setFrom(made.firstLabel);
      setTo(made.lastLabel);
      setMsg({ tone: 'ok', text: `Listas ${made.count} pulseras: de ${made.firstLabel} a ${made.lastLabel}. Imprime su hoja con el QR.` });
      props.onPrepared();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function print(): Promise<void> {
    const a = pulseraNumberInput(from);
    const b = pulseraNumberInput(to || from);
    const problem = sheetRangeProblem(a, b);
    if (problem || a === null || b === null) return setMsg({ tone: 'bad', text: problem ?? 'Revisa los números.' });
    const win = openPendingWindow();
    setBusy(true);
    try {
      const blob = await downloadPulseraSheet(a, b);
      const how = showPrintable(win, blob, sheetFileName(a, b));
      setMsg({ tone: 'ok', text: how === 'opened' ? 'La hoja está en otra pestaña: imprímela desde allí.' : 'Hoja guardada: ábrela e imprímela.' });
    } catch (err) {
      win?.close();
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DayCard title="Preparar pulseras" labelId="pa-preparar" aside={<p className="pa-sub">Como mucho 500 de una vez · cada una con su número y su QR</p>}>
      <form className="pa-row" onSubmit={(e) => void prepare(e)}>
        <DayField id="pa-count" label="Cuántas" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 4))} style={{ width: '8rem' }} />
        <DayButton type="submit" variant="primary" disabled={busy}>
          Preparar
        </DayButton>
      </form>
      <div className="pa-row">
        <DayField id="pa-from" label="Hoja desde" placeholder="P-0001" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: '9rem' }} />
        <DayField id="pa-to" label="hasta" placeholder="P-0100" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: '9rem' }} />
        <DayButton onClick={() => void print()} disabled={busy}>
          Hoja para imprimir
        </DayButton>
      </div>
      {msg ? <DayMessage tone={msg.tone}>{msg.text}</DayMessage> : null}
    </DayCard>
  );
}

/** La lista con sus botones (Bloquear, Pasar a otra); los datos vienen de fuera. */
export function PulseraList(props: { rows: PulseraRow[] | null; tz: string; query: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<{ id: string; draft: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function block(row: PulseraRow): Promise<void> {
    if (!window.confirm(blockConfirmText(row))) return;
    setBusy(row.id);
    setMsg(null);
    try {
      await blockPulsera(row.id);
      setMsg({ tone: 'ok', text: `${row.label} bloqueada: ya no paga. Para pasar su saldo, «Pasar a otra».` });
      props.onChanged();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function replace(e: FormEvent, row: PulseraRow): Promise<void> {
    e.preventDefault();
    const n = replacing ? pulseraNumberInput(replacing.draft) : null;
    if (n === null) return setMsg({ tone: 'bad', text: 'Escribe el número de la pulsera nueva (P-0413).' });
    if (!window.confirm(`¿Bloquear ${row.label} y pasar su saldo a ${pulseraLabel(n)}?`)) return;
    setBusy(row.id);
    setMsg(null);
    try {
      const done = await replacePulsera(row.id, String(n));
      setReplacing(null);
      setMsg({ tone: 'ok', text: replaceDoneText(done.from.label, done.to.label, done.balanceCents) });
      props.onChanged();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (props.rows === null) return <p className="pa-empty">Cargando…</p>;
  return (
    <>
      {msg ? <DayMessage tone={msg.tone}>{msg.text}</DayMessage> : null}
      {props.rows.length === 0 ? (
        <p className="pa-empty">{props.query ? 'Ninguna pulsera con eso.' : 'Aún no hay pulseras: prepáralas arriba.'}</p>
      ) : (
        <div className="pa-scroll">
          <table className="pa-table">
            <thead>
              <tr>
                <th scope="col">Pulsera</th>
                <th scope="col">Estado</th>
                <th scope="col">Saldo</th>
                <th scope="col" className="n">Le queda</th>
                <th scope="col">Último uso</th>
                <th scope="col" className="n">
                  <span className="np-sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => {
                const acts = pulseraActions(r);
                const open = replacing?.id === r.id;
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="lab">{r.label}</span>
                      {r.hasUid ? null : <div className="dim">Sin leer aún por NFC</div>}
                    </td>
                    <td>
                      <Chip tone={STATUS_TONE[r.status]}>{pulseraStatusLabel(r.status)}</Chip>
                    </td>
                    <td className="dim">{r.walletCode ?? '—'}</td>
                    <td className="n">{r.balanceCents === null ? '—' : formatEur(r.balanceCents)}</td>
                    <td className="dim">{r.lastUsedAt ? formatDateTime(r.lastUsedAt, props.tz, 'short') : '—'}</td>
                    <td>
                      {open ? (
                        <form className="pa-acts" onSubmit={(e) => void replace(e, r)} aria-label={`Pasar el saldo de ${r.label}`}>
                          <input
                            className="pa-input"
                            aria-label="Número de la pulsera nueva"
                            placeholder="P-0413"
                            autoFocus
                            value={replacing.draft}
                            onChange={(e) => setReplacing({ id: r.id, draft: e.target.value })}
                            style={{ width: '7.5rem' }}
                          />
                          <DayButton type="submit" variant="primary" size="sm" disabled={busy !== null}>
                            Pasar
                          </DayButton>
                          <DayButton size="sm" onClick={() => setReplacing(null)}>
                            Cancelar
                          </DayButton>
                        </form>
                      ) : (
                        <div className="pa-acts">
                          {acts.block ? (
                            <DayButton size="sm" disabled={busy !== null} onClick={() => void block(r)}>
                              Bloquear
                            </DayButton>
                          ) : null}
                          {acts.replace ? (
                            <DayButton size="sm" disabled={busy !== null} onClick={() => setReplacing({ id: r.id, draft: '' })}>
                              Pasar a otra
                            </DayButton>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
