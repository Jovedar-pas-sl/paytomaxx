'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import { createOwnCobrosFeed, fetchOwnCobros, ownCobroStatus, type OwnCobrosSnapshot } from '@/lib/my-cobros';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';

/** Historial propio del camarero: tarjeta y saldo, incluidas invitaciones; no autoriza devoluciones. */
export function MyCobros() {
  const [{ items, cursor, error, moreBusy }, setState] = useState<OwnCobrosSnapshot>({ items: null, cursor: null, error: null, moreBusy: false });
  const feed = useRef<ReturnType<typeof createOwnCobrosFeed> | null>(null);
  useEffect(() => {
    const current = createOwnCobrosFeed(fetchOwnCobros, setState);
    feed.current = current;
    return () => { current.dispose(); if (feed.current === current) feed.current = null; };
  }, []);
  const refresh = usePolling(async (signal) => (await feed.current?.refresh(signal)) ? undefined : 'slow', { intervalMs: 15000 });
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
    {cursor ? <Button variant="ghost" onClick={() => void feed.current?.loadMore()} loading={moreBusy} disabled={moreBusy}>Ver anteriores</Button> : null}
  </section>;
}
