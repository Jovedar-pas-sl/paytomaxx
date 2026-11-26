'use client';

import { useEffect, useState } from 'react';
import { Button, EmptyState, formatRelative, Input } from '@nightpay/ui';
import { CASH_UNDO_REASON_LABEL, fetchRecentCash, voidCashTopUp, type CashUndoReason, type RecentCash } from '@/lib/cash-undo';
import { formatEur } from '@/lib/money';
import { SkelRows } from '../loading-shapes';
import { DESK_FIELD } from './desk/desk-parts';
import r from './reception.module.css';

/** El motivo elegido, en crema (tinta en claro): la lima es de la acción principal. */
const CHOSEN = { background: 'var(--np-chosen)', color: 'var(--np-on-chosen)' } as const;

const time = (iso: string) => formatRelative(iso, new Date());

/**
 * Recepción → «Anular una recarga» (B4, encargado o dueño): pasados los 2
 * minutos del «Me he equivocado», las recargas en efectivo de las últimas 2 h
 * se anulan desde el móvil, como en el panel: el motivo y su 2FA. Sale de la
 * caja el saldo más la comisión del servicio, si la llevaba.
 */
export function CashVoids({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<RecentCash[] | null>(null);
  const [picked, setPicked] = useState<RecentCash | null>(null);
  const [reason, setReason] = useState<CashUndoReason | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setRows(await fetchRecentCash());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function confirm(row: RecentCash, why: CashUndoReason): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await voidCashTopUp(row, why, code);
      setDone(`Anulada: ${formatEur(out.amountCents + (out.serviceFeeCents ?? 0))} fuera de la caja (${row.codeHint}).`);
      setPicked(null);
      setReason(null);
      setCode('');
      void load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (picked) {
    const out = picked.amountCents + picked.serviceFeeCents;
    return (
      <div className={r.card}>
        <p className={r.kicker}>Anular una recarga</p>
        <p className={r.amount}>{formatEur(out)}</p>
        <p className={r.text}>
          {picked.codeHint} · {time(picked.at)}. Sale de la caja{picked.serviceFeeCents > 0 ? ' con la comisión del servicio' : ''}; solo si su saldo aún la cubre.
        </p>
        <p className={r.lead}>¿Qué ha pasado?</p>
        {(Object.keys(CASH_UNDO_REASON_LABEL) as CashUndoReason[]).map((why) => (
          <Button key={why} variant="ghost" aria-pressed={reason === why} style={reason === why ? CHOSEN : undefined} onClick={() => setReason(why)} disabled={busy}>
            {CASH_UNDO_REASON_LABEL[why]}
          </Button>
        ))}
        <Input
          label="Tu código 2FA"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          style={DESK_FIELD}
        />
        {error ? (
          <p role="alert" className={r.error}>
            {error}
          </p>
        ) : null}
        <Button size="lg" loading={busy} disabled={!reason || code.length !== 6} onClick={() => reason && void confirm(picked, reason)}>
          Anular
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setPicked(null)}>
          Volver
        </Button>
      </div>
    );
  }

  const open = (rows ?? []).filter((row) => !row.voided);
  return (
    <div className={r.card}>
      <p className={r.kicker}>Anular una recarga</p>
      <p className={r.text}>Recargas en efectivo de las últimas 2 h. Quien la cargó la deshace en los 2 minutos siguientes; después, tú, con tu 2FA.</p>
      {done ? (
        <p role="status" className={r.note}>
          {done}
        </p>
      ) : null}
      {rows === null && !error ? <SkelRows /> : null}
      {rows !== null && open.length === 0 ? <EmptyState compact icon="cash" title="Ninguna recarga que anular" /> : null}
      {open.map((row) => (
        <button key={row.id} type="button" className={r.pendRow} onClick={() => setPicked(row)}>
          <span className={`np-num ${r.pendAmount}`}>{formatEur(row.amountCents + row.serviceFeeCents)}</span>{' '}
          <span className={r.pendWho}>
            {time(row.at)} · {row.codeHint}
          </span>
        </button>
      ))}
      {error && !picked ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={onDone}>
        Volver
      </Button>
    </div>
  );
}
