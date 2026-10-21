'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { OwnCobro } from '@nightpay/contracts';
import { fetchOwnCobros, mergeOwnCobros, ownCobroStatus } from '@/lib/my-cobros';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';

/** Historial propio del camarero: tarjeta y saldo, incluidas invitaciones; no autoriza devoluciones. */
export function MyCobros() {
  const [items, setItems] = useState<OwnCobro[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const expanded = useRef(false);
  const more = useRef<AbortController | null>(null);
  useEffect(() => () => more.current?.abort(), []);
  const refresh = usePolling(async (signal) => {
    try {
      const page = await fetchOwnCobros(undefined, signal);
      if (signal.aborted) return 'slow';
      if (!expanded.current) setCursor(page.nextCursor);
      setItems((old) => mergeOwnCobros(old ?? [], page.items));
      setError(null);
    } catch (e) {
      if (!signal.aborted) setError((e as Error).message);
      return 'slow';
    }
  }, { intervalMs: 15000 });

  async function loadMore() {
    if (!cursor || moreBusy) return;
    const controller = new AbortController(); more.current = controller;
    setMoreBusy(true);
    try {
      const page = await fetchOwnCobros(cursor, controller.signal);
      if (controller.signal.aborted) return;
      expanded.current = true;
      setItems((old) => mergeOwnCobros(old ?? [], page.items)); setCursor(page.nextCursor); setError(null);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (!controller.signal.aborted) setMoreBusy(false); }
  }
  return <section style={{ display: 'grid', gap: '0.75rem' }} aria-label="Mis cobros">
    <h2 style={{ margin: 0 }}>Mis cobros</h2>
    <p style={{ margin: 0, color: 'var(--np-text-mute)' }}>Tu historial de cobros con tarjeta y saldo, incluidas las invitaciones.</p>
    {error ? <Card role="alert" style={{ padding: '1rem' }}><p>{error}</p><Button variant="ghost" onClick={refresh}>Reintentar</Button></Card> : null}
    {items === null && !error ? <p>Cargando historial…</p> : null}
    {items?.length === 0 ? <p>Aún no has creado cobros.</p> : null}
    {items?.map((r) => <Card key={`${r.kind}-${r.id}`} style={{ padding: '1rem', display: 'grid', gap: '0.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <b className="np-num" style={{ fontSize: '1.375rem' }}>{formatEur(r.amountCents + r.tipCents)}</b>
        <span>{ownCobroStatus(r.status)}</span>
      </div>
      <b>{r.service ?? (r.isTopUp ? 'Recarga de saldo' : 'Cobro')}</b>
      {r.invitedName ? <span>Invitación a {r.invitedName}</span> : null}
      <span style={{ color: 'var(--np-text-mute)' }}>{[r.ref, r.methodLabel, r.via].filter(Boolean).join(' · ')}</span>
      <time dateTime={r.createdAt} style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>{new Date(r.createdAt).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' })}</time>
    </Card>)}
    {cursor ? <Button variant="ghost" onClick={() => void loadMore()} loading={moreBusy} disabled={moreBusy}>Ver anteriores</Button> : null}
  </section>;
}
