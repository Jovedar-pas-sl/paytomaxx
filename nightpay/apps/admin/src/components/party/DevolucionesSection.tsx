'use client';

import { useState } from 'react';
import type { PartyRefundList, PartyRefundMethod, PartyRefundRow, PartyRefundStatus } from '@nightpay/contracts';
import {
  cancelPartyRefund,
  downloadTransfersCsv,
  downloadTransfersSepa,
  fetchPartyRefunds,
  markPartyRefundDone,
} from '@/lib/endpoints/party-devoluciones';
import { dayInZone, formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import {
  REFUND_METHOD_FILTERS,
  REFUND_STATUS_FILTERS,
  refundActions,
  refundCancelConfirm,
  refundDoneConfirm,
  refundMethodLabel,
  refundStatusLabel,
  refundTiles,
  transfersFileName,
  sectionError,
} from '@/lib/party-asistente';
import { saveBlob } from '@/lib/save-file';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Chip, DayButton, DayCard, DayMessage, DaySelect, DayStyles, Kpi, type ChipTone } from './asistente-ui';

const POLL_MS = 30_000;

const STATUS_TONE: Readonly<Record<PartyRefundStatus, ChipTone>> = { PENDING: 'warn', DONE: 'ok', CANCELED: 'mute' };

/**
 * OxioParty · Devoluciones de «Lo que sobra» (dueño y encargado): lo
 * pendiente a la tarjeta y por transferencia, lo hecho y lo donado; la lista
 * por estado y forma; «Hecha» (la tarjeta, después de devolverla en el portal
 * del banco: hoy Redsys no devuelve por API; la transferencia, después de
 * enviarla) y las transferencias pendientes para el banco: el fichero SEPA
 * (todas de una vez) o el CSV.
 */
export function DevolucionesSection() {
  return <Devoluciones />;
}

export default DevolucionesSection;

function Devoluciones() {
  const tz = useVenueTimezone();
  const [list, setList] = useState<PartyRefundList | null>(null);
  const [status, setStatus] = useState<PartyRefundStatus | ''>('PENDING');
  const [method, setMethod] = useState<PartyRefundMethod | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = usePolling(
    async (signal) => {
      try {
        const next = await fetchPartyRefunds({ status, method }, signal);
        if (signal.aborted) return true;
        setList(next);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError(sectionError(err, 'devoluciones'));
        return false;
      }
    },
    { intervalMs: POLL_MS },
    [status, method],
  );

  async function act(row: PartyRefundRow, what: 'done' | 'cancel'): Promise<void> {
    if (!window.confirm(what === 'done' ? refundDoneConfirm(row) : refundCancelConfirm(row))) return;
    setBusy(row.id);
    setMsg(null);
    try {
      const next = what === 'done' ? await markPartyRefundDone(row.id) : await cancelPartyRefund(row.id);
      setList((prev) => (prev ? { ...prev, rows: prev.rows.map((r) => (r.id === next.id ? next : r)) } : prev));
      setMsg({ tone: 'ok', text: what === 'done' ? `Hecha: ${formatEur(next.amountCents)} fuera de su saldo.` : 'Anulada: su saldo vuelve a poder gastarse.' });
      reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function exportTransfers(kind: 'csv' | 'sepa'): Promise<void> {
    setBusy(kind);
    setMsg(null);
    try {
      const blob = kind === 'sepa' ? await downloadTransfersSepa() : await downloadTransfersCsv();
      saveBlob(blob, transfersFileName(dayInZone(new Date(), tz), kind));
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const pendingTransfers = list?.totals.pending.TRANSFER.count ?? 0;
  return (
    <div className="pa-root">
      <DayStyles />
      {error ? <DayMessage tone="bad">{error}{list ? ' Se siguen enseñando los últimos datos.' : ''}</DayMessage> : null}

      <section aria-label="Totales de las devoluciones" className="pa-kpis">
        {list ? refundTiles(list.totals).map((t) => <Kpi key={t.key} label={t.label} value={t.value} hint={t.hint} strong={t.strong} />) : <p className="pa-empty">Cargando…</p>}
      </section>

      <DayCard
        title="Transferencias"
        labelId="pa-transferencias"
        aside={
          <div className="pa-row">
            <DayButton variant="primary" disabled={busy !== null || pendingTransfers === 0} onClick={() => void exportTransfers('sepa')}>
              Fichero SEPA ({pendingTransfers})
            </DayButton>
            <DayButton disabled={busy !== null || pendingTransfers === 0} onClick={() => void exportTransfers('csv')}>
              Exportar CSV
            </DayButton>
          </div>
        }
      >
        <p className="pa-note">
          El fichero SEPA lleva todas las transferencias pendientes para subirlas a tu banco de una vez, desde la cuenta del local. El CSV trae las mismas con el IBAN
          entero, el importe y el concepto («Devolución … P-0412»), por si las haces a mano. Después, márcalas «Hecha» aquí.
        </p>
      </DayCard>

      <DayCard title="Devoluciones" labelId="pa-devoluciones" aside={<p className="pa-sub">Las de tarjeta se hacen a mano en el portal del banco y después se marcan «Hecha»</p>}>
        <div className="pa-row">
          <DaySelect id="pa-r-status" label="Estado" value={status} onChange={(e) => setStatus(e.target.value as PartyRefundStatus | '')}>
            {REFUND_STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </DaySelect>
          <DaySelect id="pa-r-method" label="Forma" value={method} onChange={(e) => setMethod(e.target.value as PartyRefundMethod | '')}>
            {REFUND_METHOD_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </DaySelect>
        </div>
        {msg ? <DayMessage tone={msg.tone}>{msg.text}</DayMessage> : null}
        {!list ? (
          <p className="pa-empty">Cargando…</p>
        ) : list.rows.length === 0 ? (
          <p className="pa-empty">{status === 'PENDING' ? 'No hay devoluciones pendientes.' : 'Ninguna con ese filtro.'}</p>
        ) : (
          <RefundTable rows={list.rows} tz={tz} disabled={busy !== null} onAct={(r, what) => void act(r, what)} />
        )}
      </DayCard>
    </div>
  );
}

/** La tabla de las devoluciones (sin estado: la pinta quien tiene los datos). */
export function RefundTable(props: { rows: PartyRefundRow[]; tz: string; disabled: boolean; onAct: (row: PartyRefundRow, what: 'done' | 'cancel') => void }) {
  return (
    <div className="pa-scroll">
      <table className="pa-table">
        <thead>
          <tr>
            <th scope="col">Pedida</th>
            <th scope="col">Pulsera</th>
            <th scope="col">Forma</th>
            <th scope="col" className="n">Importe</th>
            <th scope="col">Estado</th>
            <th scope="col" className="n">
              <span className="np-sr-only">Acciones</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const acts = refundActions(r);
            return (
              <tr key={r.id}>
                <td className="dim">{formatDateTime(r.createdAt, props.tz, 'short')}</td>
                <td>
                  <span className="lab">{r.pulsera ?? '—'}</span>
                  {r.walletCode ? <div className="dim">{r.walletCode}</div> : null}
                </td>
                <td>
                  {refundMethodLabel(r.method)}
                  {r.ibanHint ? <div className="dim">{r.ibanHint}</div> : null}
                  {r.email ? <div className="dim">{r.email}</div> : null}
                </td>
                <td className="n">{formatEur(r.amountCents)}</td>
                <td>
                  <Chip tone={STATUS_TONE[r.status]}>{refundStatusLabel(r.status)}</Chip>
                  {r.doneAt ? (
                    <div className="dim">
                      {formatDateTime(r.doneAt, props.tz, 'short')}
                      {r.doneByName ? ` · ${r.doneByName}` : ''}
                    </div>
                  ) : null}
                </td>
                <td>
                  <div className="pa-acts">
                    {acts.done ? (
                      <DayButton variant="primary" size="sm" disabled={props.disabled} onClick={() => props.onAct(r, 'done')}>
                        Hecha
                      </DayButton>
                    ) : null}
                    {acts.cancel ? (
                      <DayButton size="sm" disabled={props.disabled} onClick={() => props.onAct(r, 'cancel')}>
                        Anular
                      </DayButton>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
