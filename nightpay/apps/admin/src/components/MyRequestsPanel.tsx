'use client';

import { useId, useState } from 'react';
import { useNow } from '@nightpay/ui';
import type { PayoutMethod } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { fetchApprovals, handOverCash, type ApprovalView } from '@/lib/api';
import { APPROVAL_STATUS, approvalTarget, decisionLine, handOverState, kindLabel, sortApprovals } from '@/lib/approvals';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';
import { Notice } from './Notice';
import { PAYOUT_METHOD_SHORT } from './PayoutMethodForm';
import { Pill } from './Pill';

const methodLabel = (m: PayoutMethod) => PAYOUT_METHOD_SHORT[m] ?? m;
const POLL_MS = 20_000;

/**
 * «Mis solicitudes» (encargado): lo que ha pedido al dueño y cómo va. Arriba
 * lo que espera (y cuándo caduca); debajo lo aprobado, rechazado (con el
 * motivo), caducado o lo que no se pudo hacer (con la razón).
 */
export function MyRequestsPanel({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean } = {}) {
  const [items, setItems] = useState<ApprovalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const now = new Date(useNow(true, 30_000));

  const refresh = usePolling(
    async (signal) => {
      try {
        const list = sortApprovals(await fetchApprovals(undefined, 50));
        if (signal.aborted) return true;
        setItems((prev) => keepIfSame(prev, list));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: 5 * 60_000 },
    [],
  );

  const waiting = items?.filter((i) => i.status === 'PENDING').length ?? 0;
  // En Avisos, sin nada pedido no ocupa sitio.
  if (hideWhenEmpty && !error && (items === null || items.length === 0)) return null;

  return (
    <section aria-labelledby={listId} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 id={listId} className="np-approvals-title">
          Mis solicitudes
        </h2>
        <p className="np-approvals-hint">
          Pagos a las compañeras y devoluciones grandes que has pedido al dueño. Se hacen cuando él los aprueba; sin
          decidir, caducan a las 24 h.
        </p>
      </div>
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar tus solicitudes: {error}
        </Notice>
      ) : null}
      {items === null ? (
        error ? null : <p className="np-approvals-hint">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="np-inbox-empty">Aún no has pedido nada.</p>
      ) : (
        <>
          <p className="np-approvals-hint">
            {waiting === 0 ? 'Nada esperando al dueño.' : waiting === 1 ? '1 esperando al dueño.' : `${waiting} esperando al dueño.`}
          </p>
          <ul className="np-approvals">
            {items.map((item) => (
              <RequestRow key={item.id} item={item} now={now} onChanged={refresh} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RequestRow({ item, now, onChanged }: { item: ApprovalView; now: Date; onChanged: () => void }) {
  const status = APPROVAL_STATUS[item.status];
  const hand = handOverState(item, now);
  const [busy, setBusy] = useState(false);
  const [handError, setHandError] = useState<string | null>(null);
  async function handed() {
    setBusy(true);
    setHandError(null);
    try {
      await handOverCash(item.id);
      onChanged();
    } catch (err) {
      setHandError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="np-approval" data-state={item.status === 'PENDING' ? 'waiting' : 'done'}>
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">{kindLabel(item)}</span>
        <Pill tone={status.tone}>{status.label}</Pill>
      </p>
      <p className="np-approval-amount np-num">{formatEur(item.amountCents)}</p>
      <p className="np-approval-target">{approvalTarget(item, methodLabel)}</p>
      <p className="np-approval-meta">{decisionLine(item, now)}</p>
      {hand === 'ready' ? (
        <>
          <p className="np-approval-meta">
            Aprobada: saca {formatEur(item.amountCents)} de la caja, dáselos al cliente y pulsa «Entregado» (si no, caduca a las 24 h).
          </p>
          <Button onClick={() => void handed()} loading={busy}>
            Entregado
          </Button>
        </>
      ) : hand === 'done' ? (
        <p className="np-approval-meta">Entregado: apuntado en la caja.</p>
      ) : hand === 'late' ? (
        <p className="np-approval-meta">No se entregó a tiempo (24 h): si aún hay que devolverlo, pídelo otra vez.</p>
      ) : null}
      {handError ? (
        <p role="alert" className="np-approval-meta" style={{ color: 'var(--np-danger)' }}>
          {handError}
        </p>
      ) : null}
    </li>
  );
}
