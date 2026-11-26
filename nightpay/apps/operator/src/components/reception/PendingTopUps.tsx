'use client';

import { useEffect, useState } from 'react';
import type { PendingTopUpView } from '@nightpay/contracts';
import { Button, EmptyState, formatRelative } from '@nightpay/ui';
import { fetchPendingTopUps } from '@/lib/api-noche';
import { formatEur } from '@/lib/money';
import { SkelRows } from '../loading-shapes';
import { StaffOutcome } from '../StaffOutcome';
import { AssignTopUp } from './AssignTopUp';
import r from './reception.module.css';

/**
 * Recepción → Pendientes de asignar: recargas cobradas sin el NFC del cliente
 * (Inicio → «Recargar saldo», plan B). Se toca una y se acerca su NFC o se
 * teclea su código: se suma a su saldo.
 */
export function PendingTopUps({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<PendingTopUpView[] | null>(null);
  const [picked, setPicked] = useState<PendingTopUpView | null>(null);
  const [assigned, setAssigned] = useState<{ amountCents: number; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setRows(await fetchPendingTopUps());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (assigned) {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={assigned.amountCents}
        message="Recarga asignada"
        detail={<p>{assigned.detail}</p>}
        primary={{
          label: 'Ver las pendientes',
          onClick: () => {
            setAssigned(null);
            void load();
          },
        }}
        secondary={{ label: 'Volver', onClick: onDone }}
      />
    );
  }

  if (picked) {
    return (
      <AssignTopUp
        walletId={picked.walletId}
        amountCents={picked.amountCents}
        paidWith={picked.paidWith ?? null}
        onAssigned={(out) => {
          setPicked(null);
          setAssigned({ amountCents: out.amountCents, detail: `Saldo ${out.codeHint} · tiene ${formatEur(out.balanceCents)}` });
        }}
        onLater={() => setPicked(null)}
      />
    );
  }

  return (
    <div className={r.card}>
      <p className={r.kicker}>Pendientes de asignar</p>
      <p className={r.text}>Recargas cobradas sin la ficha del cliente. Toca una y acerca su ficha (o teclea su código).</p>
      {rows === null && !error ? <SkelRows /> : null}
      {rows?.length === 0 ? <EmptyState compact icon="clock" title="Ninguna recarga pendiente" /> : null}
      {(rows ?? []).map((row) => (
        <button key={row.walletId} type="button" className={r.pendRow} onClick={() => setPicked(row)}>
          <span className={`np-num ${r.pendAmount}`}>{formatEur(row.amountCents)}</span>
          {/* El espacio no se pinta (fila flex), pero el lector de pantalla no los junta. */}{' '}
          <span className={r.pendWho}>
            {formatRelative(row.since, new Date())}
            {row.byName ? ` · ${row.byName}` : ''}
          </span>
          {/* Para reconocer al cliente (A8): «Tarjeta Visa ••4242». */}
          {row.paidWith ? (
            <>
              {' '}
              <span className={r.pendWho}>{row.paidWith}</span>
            </>
          ) : null}
        </button>
      ))}
      {error ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={() => void load()}>
        Actualizar
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Volver
      </Button>
    </div>
  );
}
