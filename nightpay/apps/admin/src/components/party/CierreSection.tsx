'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PartySettings, PartySettlement } from '@nightpay/contracts';
import { Button, Input, useConfirm } from '@nightpay/ui';
import { formatDateTime } from '@/lib/dates';
import {
  downloadPartySettlement,
  downloadPartySettlementSepa,
  fetchPartySettings,
  fetchPartySettlement,
  type PartyRange,
} from '@/lib/endpoints/party';
import { formatEur } from '@/lib/money';
import { leftoverView, rangeProblem, sepaReadiness, settlementRowView, transfersText } from '@/lib/party-settlement';
import { saveBlob } from '@/lib/save-file';
import { downloadSepaAsking, sepaAgainConfirm } from '@/lib/sepa-again';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';

/**
 * OxioParty · Cierre (maqueta Cierre): lo que se paga a cada caseta. El
 * dinero está en la cuenta del organizador (su TPV y el efectivo de las
 * taquillas): OxioParty hace las cuentas y el organizador hace las
 * transferencias, con el fichero para el banco (SEPA) o el CSV. La fiesta
 * entera o unas noches (de las 08:00 de la primera a las 08:00 del día
 * siguiente a la última).
 */
export function CierreSection() {
  const timeZone = useVenueTimezone();
  const [range, setRange] = useState<PartyRange>({});
  const [data, setData] = useState<PartySettlement | null>(null);
  const [settings, setSettings] = useState<PartySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<'sepa' | 'csv' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();

  const load = useCallback(async (r: PartyRange, signal?: AbortSignal) => {
    setError(null);
    try {
      const s = await fetchPartySettlement(r, signal);
      if (!signal?.aborted) setData(s);
    } catch (err) {
      if (!signal?.aborted) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(range, controller.signal);
    return () => controller.abort();
  }, [load, range]);

  useEffect(() => {
    fetchPartySettings()
      .then(setSettings)
      .catch(() => {
        // Sin los ajustes solo falta la línea de la fiesta: el cierre sigue.
      });
  }, []);

  async function download(kind: 'sepa' | 'csv'): Promise<void> {
    setDownloading(kind);
    setDownloadError(null);
    try {
      // El SEPA ya descargado con esas noches: pregunta antes (subirlo dos veces al banco paga dos veces).
      const blob =
        kind === 'sepa'
          ? await downloadSepaAsking((again) => downloadPartySettlementSepa(range, again), (body) => sepaAgainConfirm(confirm, body), timeZone)
          : await downloadPartySettlement(kind, range);
      if (!blob) return;
      const slug = range.from && range.to ? (range.from === range.to ? range.from : `${range.from}_${range.to}`) : 'fiesta';
      saveBlob(blob, kind === 'sepa' ? `oxioparty-transferencias-${slug}.xml` : `oxioparty-liquidacion-${slug}.csv`);
    } catch (err) {
      setDownloadError((err as Error).message);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <CierreView
        data={data}
        settings={settings}
        error={error}
        timeZone={timeZone}
        range={range}
        onRange={setRange}
        onRetry={() => void load(range)}
        onDownload={(k) => void download(k)}
        downloading={downloading}
        downloadError={downloadError}
      />
      {dialog}
    </>
  );
}

export interface CierreViewProps {
  data: PartySettlement | null;
  settings: PartySettings | null;
  error: string | null;
  timeZone: string;
  range: PartyRange;
  onRange: (r: PartyRange) => void;
  onRetry: () => void;
  onDownload: (kind: 'sepa' | 'csv') => void;
  downloading: 'sepa' | 'csv' | null;
  downloadError: string | null;
}

export function CierreView(p: CierreViewProps) {
  const ready = p.data ? sepaReadiness(p.data) : null;
  return (
    <div className="np-party">
      <div className="np-party-head">
        <div className="np-party-head-text">
          <h2 className="np-party-title">Cierre: lo que se paga a cada caseta</h2>
          <p className="np-party-sub">
            El dinero está en la cuenta del organizador (su TPV y el efectivo de las taquillas). OxioParty hace las cuentas; el
            organizador hace las transferencias.
            {p.settings ? ` ${eventLine(p.settings, p.timeZone)}` : ''}
          </p>
        </div>
        <div className="np-party-tools">
          <Button variant="ghost" onClick={() => p.onDownload('csv')} loading={p.downloading === 'csv'} disabled={!p.data}>
            Descargar CSV
          </Button>
          <Button onClick={() => p.onDownload('sepa')} loading={p.downloading === 'sepa'} disabled={!ready?.can}>
            Descargar transferencias para el banco
          </Button>
        </div>
      </div>

      <RangePicker range={p.range} onRange={p.onRange} />

      {p.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: p.onRetry }}>
          No se pudo hacer el cierre: {p.error}
        </Notice>
      ) : null}
      {p.downloadError ? <Notice tone="danger">No se pudo descargar: {p.downloadError}</Notice> : null}
      {ready && ready.notes.length > 0 ? (
        <Notice tone="warning">
          {ready.notes.map((n) => (
            <span key={n} style={{ display: 'block' }}>
              {n}
            </span>
          ))}
        </Notice>
      ) : null}

      {p.data ? <SettlementTable data={p.data} /> : p.error ? null : <p className="np-party-empty">Haciendo las cuentas…</p>}
      {p.data ? <Leftover data={p.data} settings={p.settings} timeZone={p.timeZone} /> : null}
    </div>
  );
}

function eventLine(s: PartySettings, timeZone: string): string {
  if (s.eventEnded && s.eventEndsAt) return `Terminada el ${formatDateTime(s.eventEndsAt, timeZone, 'short')}.`;
  if (s.eventEndsAt) return `Termina el ${formatDateTime(s.eventEndsAt, timeZone, 'short')}: hasta entonces, las cifras aún cambian.`;
  return '';
}

function RangePicker({ range, onRange }: { range: PartyRange; onRange: (r: PartyRange) => void }) {
  const [from, setFrom] = useState(range.from ?? '');
  const [to, setTo] = useState(range.to ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [byNights, setByNights] = useState(Boolean(range.from));

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    const issue = rangeProblem(from, to) ?? (from && to ? null : 'Pon la primera y la última noche.');
    setProblem(issue);
    if (!issue) onRange({ from, to });
  }

  function wholeParty(): void {
    setByNights(false);
    setProblem(null);
    onRange({});
  }

  return (
    <form className="np-party-card" onSubmit={onSubmit} noValidate aria-label="Qué noches liquidar">
      <div className="np-party-inline">
        <div className="np-party-seg" role="group" aria-label="Qué liquidar">
          <button type="button" aria-pressed={!byNights} onClick={wholeParty}>
            Toda la fiesta
          </button>
          <button type="button" aria-pressed={byNights} onClick={() => setByNights(true)}>
            Unas noches
          </button>
        </div>
        {byNights ? (
          <>
            <div style={{ width: '11rem' }}>
              <Input label="Primera noche" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div style={{ width: '11rem' }}>
              <Input label="Última noche" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button type="submit" size="sm">
              Ver esas noches
            </Button>
          </>
        ) : null}
      </div>
      <p className="np-party-card-note" style={{ margin: 0 }}>
        {byNights
          ? 'Cada noche va de las 08:00 de ese día a las 08:00 del siguiente.'
          : 'Todo lo de la fiesta, también lo cargado desde casa antes de empezar.'}
      </p>
      {problem ? (
        <p role="alert" className="np-set-error">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

function SettlementTable({ data }: { data: PartySettlement }) {
  const rows = data.rows.map(settlementRowView);
  const t = data.totals;
  return (
    <section className="np-party-card" aria-label="Liquidación por caseta">
      {rows.length === 0 ? (
        <p className="np-party-empty">Aún no hay casetas ni ventas que liquidar.</p>
      ) : (
        <div className="np-party-scroll">
          <table className="np-party-table" style={{ minWidth: '58rem' }}>
            <thead>
              <tr>
                <th scope="col">Caseta</th>
                <th scope="col" data-num="true">
                  Vendido
                </th>
                <th scope="col" data-num="true">
                  % del organizador
                </th>
                <th scope="col" data-num="true">
                  Para el organizador
                </th>
                <th scope="col" data-num="true">
                  A pagar a la caseta
                </th>
                <th scope="col">Cuenta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row">
                    <span className="np-party-strong">{r.name}</span>
                    {r.owner ? <span className="np-party-dim">{r.owner}</span> : null}
                  </th>
                  <td data-num="true" className="np-party-num">
                    {r.sold}
                  </td>
                  <td data-num="true">
                    <span className="np-party-chip">{r.percent}</span>
                  </td>
                  <td data-num="true" className="np-party-num">
                    {r.organizer}
                  </td>
                  <td data-num="true" className="np-party-big">
                    {r.pay}
                  </td>
                  <td>
                    <span className="np-party-status" data-tone={r.status.tone}>
                      {r.status.text}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td data-num="true" className="np-party-num">
                  {formatEur(t.soldCents)}
                </td>
                <td />
                <td data-num="true" className="np-party-num">
                  {formatEur(t.organizerCents)}
                </td>
                <td data-num="true" className="np-party-big">
                  {formatEur(t.toPayCents)}
                </td>
                <td>
                  {transfersText(t.transfers)} · {formatEur(t.transfersCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="np-party-card-note" style={{ margin: 0 }}>
        Para el organizador = lo vendido × su % (al céntimo). La parte que cuenta es la de cada caseta ahora: si la cambias, cambia el
        cierre. La cuenta del local: {data.debtor.ibanMasked ?? 'sin IBAN'} ({data.debtor.name}).
      </p>
    </section>
  );
}

function Leftover({ data, settings, timeZone }: { data: PartySettlement; settings: PartySettings | null; timeZone: string }) {
  const v = leftoverView(data);
  const deadline = settings?.refundDeadline ? formatDateTime(`${settings.refundDeadline}T12:00:00Z`, timeZone, 'date') : null;
  return (
    <section className="np-party-card" aria-labelledby="np-party-h-left">
      <h3 id="np-party-h-left" className="np-party-card-title">
        Lo que sobró en las pulseras: <span className="np-party-num">{v.leftover}</span>
      </h3>
      <p className="np-party-card-note" style={{ margin: 0 }}>
        {v.formula}
      </p>
      <div className="np-party-split" aria-hidden="true">
        <span style={{ width: `${v.refundedPct}%` }} />
      </div>
      <ul className="np-party-legend-list">
        <li>
          <i />
          Devuelto: {v.refunded}
        </li>
        <li>
          <i data-kind="left" />
          Aún en las pulseras: {v.left}
          {deadline ? ` (se puede pedir hasta el ${deadline})` : ''}
        </li>
      </ul>
    </section>
  );
}
