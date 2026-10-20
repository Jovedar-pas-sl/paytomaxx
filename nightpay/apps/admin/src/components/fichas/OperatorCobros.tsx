'use client';

import { useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { CobroRow, InvitationSummary } from '@nightpay/contracts';
import { fetchCobros, fetchInvitationSummary, type CobrosFilters } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { appendPage } from '@/lib/pagination';
import { Notice } from '../Notice';
import { CobrosTable } from './CobrosTable';

const PAGE = 50;

/**
 * Ficha de la chica → Cobros: cada cobro con su referencia, cómo pagó,
 * sección, saldo y servicio. Arriba, sus invitaciones («Invitar a una copa»):
 * cuántas, cuánto y su parte; y la lista de esas copas (las cobra el camarero).
 */
export function OperatorCobros({ operatorId }: { operatorId: string }) {
  const [invitations, setInvitations] = useState(false);
  const filters: CobrosFilters = invitations ? { invitedOperatorId: operatorId } : { operatorId };
  const [rows, setRows] = useState<CobroRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    fetchCobros(invitations ? { invitedOperatorId: operatorId } : { operatorId }, { limit: PAGE })
      .then((page) => {
        if (cancelled) return;
        setRows(page.items);
        setCursor(page.nextCursor);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [operatorId, attempt, invitations]);

  async function more(): Promise<void> {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchCobros(filters, { cursor, limit: PAGE });
      setRows((prev) => appendPage(prev ?? [], page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <InvitationsLine operatorId={operatorId} showing={invitations} onToggle={() => setInvitations((v) => !v)} />
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
          {error}
        </Notice>
      ) : null}
      <div className="np-table-host" style={{ border: '1px solid var(--np-border)', borderRadius: 'var(--np-r-md)', overflow: 'hidden' }}>
        <CobrosTable
          rows={rows}
          hidePerson={!invitations}
          empty={rows === null ? 'Cargando…' : invitations ? 'Aún no la han invitado a nada.' : 'Aún no ha cobrado nada.'}
        />
      </div>
      {cursor ? (
        <Button variant="ghost" onClick={() => void more()} loading={loadingMore}>
          Cargar más
        </Button>
      ) : null}
    </div>
  );
}

/** «Invitaciones: 3 · 60,00 € (su parte 30,00 €)» y el botón para ver esas copas. */
function InvitationsLine({ operatorId, showing, onToggle }: { operatorId: string; showing: boolean; onToggle: () => void }) {
  const [summary, setSummary] = useState<InvitationSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchInvitationSummary(operatorId)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [operatorId]);

  if (failed) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        Invitaciones:{' '}
        {summary
          ? `${summary.count} · ${formatEur(summary.amountCents)} (su parte ${formatEur(summary.shareCents)})`
          : '…'}
      </p>
      {summary && (summary.count > 0 || showing) ? (
        <Button variant="ghost" onClick={onToggle}>
          {showing ? 'Ver sus cobros' : 'Ver sus invitaciones'}
        </Button>
      ) : null}
    </div>
  );
}
