'use client';

import { useState, type ReactNode } from 'react';
import { Button, Card } from '@nightpay/ui';
import {
  OXIOPAY_SETTLEMENT_LABEL,
  SETTLEMENT_CONCEPT_LABELS,
  formatIbanGroups,
  settlementWeekLabel,
  type SettlementDetail,
} from '@nightpay/contracts';
import { formatDateTime, MADRID_TIMEZONE } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import {
  conceptRows,
  nightColumns,
  nightLabel,
  settlementFileName,
  settlementPeriodText,
  settlementStatusView,
  transferText,
} from '@/lib/oxiopay-settlements';
import { openPendingWindow, saveBlob, showPrintable } from '@/lib/save-file';
import '../../styles/panel-liquidacion.css';
import { Notice } from '../Notice';
import { Pill } from '../Pill';

interface Props {
  detail: SettlementDetail;
  /** El dueño (solo lectura) o la consola (sus botones van en `actions`). */
  audience: 'owner' | 'superadmin';
  /** Descarga el documento o el CSV (cada uno con su endpoint). */
  download: (kind: 'document' | 'csv') => Promise<Blob>;
  actions?: ReactNode;
}

/** Un importe con su signo (lo devuelto en rojo; a 0, apagado). */
function Amount({ cents }: { cents: number }) {
  const cls = ['np-liq-num', cents < 0 ? 'np-liq-neg' : cents === 0 ? 'np-liq-zero' : ''].filter(Boolean).join(' ');
  return <span className={cls}>{formatEur(cents)}</span>;
}

/**
 * La ficha de una «Liquidación OxioPay» (dueño y consola): lo que hay que
 * pagar, a dónde y con qué referencia; por concepto, por noche y los ajustes
 * de semanas anteriores; los pagos recibidos; y el documento para imprimir /
 * guardar en PDF y el CSV.
 */
export function SettlementView({ detail: d, audience, download, actions }: Props) {
  const status = settlementStatusView(d);
  const open = d.status === 'ISSUED' || d.status === 'PARTIALLY_PAID';
  const [busy, setBusy] = useState<'document' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function get(kind: 'document' | 'csv'): Promise<void> {
    setError(null);
    // La pestaña del documento se abre al pulsar (si no, el navegador la bloquea).
    const win = kind === 'document' ? openPendingWindow() : null;
    setBusy(kind);
    try {
      const blob = await download(kind);
      if (kind === 'document') showPrintable(win, blob, settlementFileName(d.reference, 'html'));
      else saveBlob(blob, settlementFileName(d.reference, 'csv'));
    } catch (err) {
      win?.close();
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="np-liq" aria-labelledby={`liq-${d.id}`}>
      <header className="np-liq-head">
        <div>
          <p className="np-liq-kicker">{OXIOPAY_SETTLEMENT_LABEL}</p>
          <h2 id={`liq-${d.id}`} className="np-liq-ref">
            {d.reference}
          </h2>
          <p className="np-liq-sub">
            {audience === 'superadmin' ? `${d.party.venueName} · ` : ''}
            {settlementPeriodText(d)}
          </p>
        </div>
        <Pill tone={status.tone}>{status.label}</Pill>
      </header>

      {d.status === 'VOID' ? (
        <Notice tone="neutral">
          <strong>Anulada: no hay que pagarla.</strong>{' '}
          {audience === 'superadmin' && d.voidReason ? `Motivo (solo lo ve OxioPay): ${d.voidReason}` : 'OxioPay la ha anulado; si hace falta, emitirá otra.'}
          {d.voidedAt ? ` (${formatDateTime(d.voidedAt, MADRID_TIMEZONE)})` : ''}
        </Notice>
      ) : null}

      <dl className="np-liq-figs">
        <div className="np-liq-fig" data-hero="true">
          <dt>Total a pagar</dt>
          <dd>{formatEur(d.totalCents)}</dd>
          <span className="np-liq-fig-note">
            Semana {formatEur(d.periodCents)}
            {d.adjustmentsCents !== 0 ? ` · ajustes ${formatEur(d.adjustmentsCents)}` : ''}
          </span>
        </div>
        <div className="np-liq-fig" data-tone={d.paidCents > 0 ? 'success' : undefined}>
          <dt>Pagado</dt>
          <dd>{formatEur(d.paidCents)}</dd>
        </div>
        <div className="np-liq-fig" data-tone={d.overdue ? 'danger' : undefined}>
          <dt>Pendiente</dt>
          <dd>{formatEur(d.pendingCents)}</dd>
          {d.overdue ? <span className="np-liq-fig-note">{d.daysOpen} días desde que se emitió</span> : null}
        </div>
      </dl>

      {open ? <TransferCard detail={d} audience={audience} /> : null}

      <Card>
        <section className="np-liq-block" aria-label="Por concepto">
          <h3>Por concepto</h3>
          <table className="np-liq-concepts">
            <tbody>
              {conceptRows(d).map((row) => (
                <tr key={row.concept}>
                  <th scope="row">
                    {row.label}
                    <small>{row.help}</small>
                  </th>
                  <td>
                    <Amount cents={row.cents} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total de la semana</th>
                <td>
                  <Amount cents={d.periodCents} />
                </td>
              </tr>
              <tr>
                <th scope="row">Ajustes de semanas anteriores</th>
                <td>
                  <Amount cents={d.adjustmentsCents} />
                </td>
              </tr>
              <tr data-total="true">
                <th scope="row">Total a pagar</th>
                <td>
                  <span className="np-liq-num">{formatEur(d.totalCents)}</span>
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="np-liq-help">
            Es lo que el mapa del dinero pone como de OxioPay en esta semana ({formatEur(d.moneyMapCents)} al emitirla): la comisión del
            servicio que pagaron los clientes menos la devuelta, y la comisión de plataforma donde no la hay.
          </p>
        </section>
      </Card>

      <NightsCard detail={d} />
      <AdjustmentsCard detail={d} />
      <PaymentsCard detail={d} audience={audience} />

      {error ? <Notice tone="danger">No se pudo descargar: {error}</Notice> : null}
      <footer className="np-liq-foot">
        <span>
          Emitida el {formatDateTime(d.generatedAt, MADRID_TIMEZONE)}
          {audience === 'superadmin' ? (d.auto ? ' · por el repaso del lunes' : ' · a mano') : ''}. No es una factura.
        </span>
        <div className="np-liq-actions">
          <Button type="button" variant="ghost" loading={busy === 'document'} disabled={busy !== null} onClick={() => void get('document')}>
            Imprimir o guardar en PDF
          </Button>
          <Button type="button" variant="ghost" loading={busy === 'csv'} disabled={busy !== null} onClick={() => void get('csv')}>
            Descargar CSV
          </Button>
          {actions}
        </div>
      </footer>
    </article>
  );
}

function TransferCard({ detail: d, audience }: { detail: SettlementDetail; audience: 'owner' | 'superadmin' }) {
  if (!d.payee) {
    return (
      <Notice tone="warning">
        {audience === 'owner'
          ? `OxioPay aún no ha puesto la cuenta para la transferencia: pídesela. Importe ${formatEur(d.pendingCents)}, concepto ${d.reference}.`
          : 'Falta la cuenta de OxioPay (Liquidaciones → Cuenta de OxioPay): la liquidación sale sin IBAN para la transferencia.'}
      </Notice>
    );
  }
  const changedAt = new Date(d.payee.updatedAt);
  const recentlyChanged = Date.now() - changedAt.getTime() < PAYEE_RECENT_MS;
  const rows: Array<[string, string, boolean]> = [
    ['Titular', d.payee.holder, false],
    ['IBAN', formatIbanGroups(d.payee.iban), true],
    ['Concepto', d.reference, true],
    ['Importe', formatEur(d.pendingCents), false],
  ];
  return (
    <section className="np-liq-pay" aria-label="Cómo pagar">
      <h3>Cómo pagar</h3>
      <p className="np-liq-help">
        Transferencia bancaria a la cuenta de {d.payee.name}, con la referencia como concepto: así se casa sola con esta liquidación.
      </p>
      {recentlyChanged ? (
        <Notice tone="warning">
          La cuenta de OxioPay cambió el {formatDateTime(changedAt, MADRID_TIMEZONE, 'date')}. Si no te lo han avisado, pregunta a OxioPay antes de
          transferir.
        </Notice>
      ) : (
        <p className="np-liq-help">Cuenta de OxioPay puesta o cambiada el {formatDateTime(changedAt, MADRID_TIMEZONE, 'date')}.</p>
      )}
      <dl className="np-liq-pay-rows">
        {rows.map(([label, value, mono]) => (
          <div key={label} className="np-liq-pay-row">
            <dt>{label}</dt>
            <dd className={mono ? 'np-liq-mono' : undefined}>{value}</dd>
            <CopyText text={label === 'IBAN' ? d.payee!.iban : value} label="Copiar" ariaLabel={`Copiar ${label === 'IBAN' ? 'el IBAN' : label.toLowerCase()}`} />
          </div>
        ))}
      </dl>
      <div className="np-liq-actions">
        <CopyText text={transferText(d, d.payee)} label="Copiarlo todo" />
      </div>
    </section>
  );
}

const COPIED_MS = 2000;
/** Una cuenta de OxioPay cambiada hace menos de esto se avisa en grande (comprobarla antes de transferir). */
const PAYEE_RECENT_MS = 14 * 24 * 60 * 60 * 1000;

function CopyText({ text, label, ariaLabel }: { text: string; label: string; ariaLabel?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), COPIED_MS);
  }
  return (
    <Button type="button" variant="ghost" size="sm" className="np-sa-sm" onClick={() => void copy()} aria-live="polite" aria-label={ariaLabel}>
      {state === 'copied' ? 'Copiado' : state === 'failed' ? 'Cópialo a mano' : label}
    </Button>
  );
}

function NightsCard({ detail: d }: { detail: SettlementDetail }) {
  const columns = nightColumns(d);
  // Las noches sin nada no ocupan sitio (en el móvil, cada noche es una tarjeta): se nombran debajo.
  const busy = d.nights.filter((n) => columns.some((c) => n.concepts[c] !== 0));
  const quiet = d.nights.filter((n) => !busy.includes(n));
  return (
    <Card className="np-table-host" style={{ padding: '1rem' }}>
      <section className="np-liq-block" aria-label="Por noche">
        <h3>Por noche</h3>
        <p className="np-liq-help">Cada noche, de 08:00 a 08:00 del día siguiente (hora de Madrid).</p>
        <div className="np-sa-scroll-x">
          <table className="np-table np-liq-nights">
            <thead>
              <tr>
                <th scope="col">Noche</th>
                {columns.map((c) => (
                  <th key={c} scope="col">
                    {SETTLEMENT_CONCEPT_LABELS[c]}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {busy.map((n) => (
                <tr key={n.day}>
                  <th scope="row" data-label="Noche" data-card="title">
                    {nightLabel(n.day)}
                  </th>
                  {columns.map((c) => (
                    <td key={c} data-label={SETTLEMENT_CONCEPT_LABELS[c]}>
                      <Amount cents={n.concepts[c]} />
                    </td>
                  ))}
                  <td data-label="Total">
                    <strong>
                      <Amount cents={n.totalCents} />
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {busy.length === 0 ? <p className="np-liq-help">Ninguna noche con movimientos en esta semana.</p> : null}
        {busy.length > 0 && quiet.length > 0 ? (
          <p className="np-liq-help">Sin movimientos: {quiet.map((n) => nightLabel(n.day)).join(', ')}.</p>
        ) : null}
      </section>
    </Card>
  );
}

function AdjustmentsCard({ detail: d }: { detail: SettlementDetail }) {
  return (
    <Card>
      <section className="np-liq-block" aria-label="Ajustes de semanas anteriores">
        <h3>Ajustes de semanas anteriores</h3>
        {d.adjustments.length === 0 ? (
          <p className="np-liq-help">Ninguno: nada se apuntó tarde en semanas ya liquidadas.</p>
        ) : (
          <>
            <p className="np-liq-help">
              Lo apuntado después de liquidar esas semanas, con la fecha de entonces (por ejemplo, una devolución del banco apuntada días
              después).
            </p>
            <table className="np-liq-concepts">
              <tbody>
                {d.adjustments.map((a, i) => (
                  <tr key={`${a.day}-${a.concept}-${i}`}>
                    <th scope="row">
                      {SETTLEMENT_CONCEPT_LABELS[a.concept]}
                      <small>
                        {settlementWeekLabel(a)} · noche del {nightLabel(a.day)}
                        {a.reference ? ` · ${a.reference}` : ' · sin liquidar entonces'}
                      </small>
                    </th>
                    <td>
                      <Amount cents={a.amountCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-total="true">
                  <th scope="row">Total de los ajustes</th>
                  <td>
                    <Amount cents={d.adjustmentsCents} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </section>
    </Card>
  );
}

function PaymentsCard({ detail: d, audience }: { detail: SettlementDetail; audience: 'owner' | 'superadmin' }) {
  if (d.payments.length === 0) return null;
  return (
    <Card>
      <section className="np-liq-block" aria-label="Pagos recibidos">
        <h3>Pagos recibidos</h3>
        <table className="np-liq-concepts">
          <tbody>
            {d.payments.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  {formatDateTime(`${p.paidOn}T12:00:00Z`, MADRID_TIMEZONE, 'date')} · <span className="np-liq-mono">{p.bankReference}</span>
                  <small>
                    {audience === 'superadmin'
                      ? `${p.reason ?? 'Lo pendiente entero'}${p.recordedByEmail ? ` · lo apuntó ${p.recordedByEmail}` : ''}`
                      : 'Transferencia recibida por OxioPay'}
                  </small>
                </th>
                <td>
                  <Amount cents={p.amountCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Card>
  );
}
