'use client';

import { useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { CobroRow } from '@nightpay/contracts';
import { fetchCobros } from '@/lib/api';
import { appendPage } from '@/lib/pagination';
import { Notice } from '../Notice';
import { CobrosTable } from './CobrosTable';

const PAGE = 50;

/** Ficha de la chica → Cobros: cada cobro con su referencia, cómo pagó, sección, saldo y servicio. */
export function OperatorCobros({ operatorId }: { operatorId: string }) {
  const [rows, setRows] = useState<CobroRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchCobros({ operatorId }, { limit: PAGE })
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
  }, [operatorId, attempt]);

  async function more(): Promise<void> {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchCobros({ operatorId }, { cursor, limit: PAGE });
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
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
          {error}
        </Notice>
      ) : null}
      <div className="np-table-host" style={{ border: '1px solid var(--np-border)', borderRadius: 'var(--np-r-md)', overflow: 'hidden' }}>
        <CobrosTable rows={rows} hidePerson empty={rows === null ? 'Cargando…' : 'Aún no ha cobrado nada.'} />
      </div>
      {cursor ? (
        <Button variant="ghost" onClick={() => void more()} loading={loadingMore}>
          Cargar más
        </Button>
      ) : null}
    </div>
  );
}
