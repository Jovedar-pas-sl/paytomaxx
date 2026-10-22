'use client';

import { useEffect, useRef, useState } from 'react';
import type { OwnCobro } from '@nightpay/contracts';
import { Button, Card } from '@nightpay/ui';
import {
  createOwnCobrosFeed,
  fetchOwnCobros,
  ownChargedCents,
  ownCobroState,
  ownNightTotals,
  type OwnCobroIcon,
  type OwnCobrosSnapshot,
  type OwnNight,
} from '@/lib/my-cobros';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';
import styles from './my-cobros.module.css';

const TZ = 'Europe/Madrid';
const TIME = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const DAY_TIME = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });

/**
 * «Cobros» del camarero: su historial (tarjeta y saldo, también las
 * invitaciones), para mirarlo de un vistazo a oscuras: arriba el total de la
 * noche y, en cada cobro, un chip de color con icono y palabra, la propina en
 * su línea y las recargas marcadas «no es venta». No autoriza devoluciones.
 */
export function MyCobros() {
  const [{ items, cursor, error, moreBusy, night }, setState] = useState<OwnCobrosSnapshot>({ items: null, cursor: null, error: null, moreBusy: false, night: null });
  const feed = useRef<ReturnType<typeof createOwnCobrosFeed> | null>(null);
  useEffect(() => {
    const current = createOwnCobrosFeed(fetchOwnCobros, setState);
    feed.current = current;
    return () => { current.dispose(); if (feed.current === current) feed.current = null; };
  }, []);
  // Revalida todo lo cargado (y la noche entera): puede ser más de una página.
  const refresh = usePolling(async (signal) => (await feed.current?.refresh(signal)) ? undefined : 'slow', { intervalMs: 15_000, timeoutMs: 45_000 });
  return (
    <section className={styles.list} aria-label="Mis cobros">
      <h2 className={styles.title}>Mis cobros</h2>
      {night && items ? <NightTotal items={items} night={night} cursor={cursor} /> : null}
      {error ? (
        <Card role="alert" style={{ padding: '1rem' }}>
          <p style={{ marginTop: 0 }}>{error}</p>
          <Button variant="ghost" onClick={refresh}>Reintentar</Button>
        </Card>
      ) : null}
      {items === null && !error ? <p className={styles.note}>Cargando tu historial…</p> : null}
      {items?.length === 0 ? <p className={styles.note}>Aún no has hecho cobros.</p> : null}
      {items?.map((r) => <CobroRow key={`${r.kind}-${r.id}`} row={r} night={night} />)}
      {cursor ? (
        <Button variant="ghost" onClick={() => void feed.current?.loadMore()} loading={moreBusy} disabled={moreBusy}>
          Ver anteriores
        </Button>
      ) : null}
    </section>
  );
}

function NightTotal({ items, night, cursor }: { items: readonly OwnCobro[]; night: OwnNight; cursor: string | null }) {
  const t = ownNightTotals(items, night, cursor);
  const extras = [
    t.tipCents > 0 ? <span key="tip" className={styles.tipTag}>Propinas {formatEur(t.tipCents, { compact: true })}</span> : null,
    t.topUpCount > 0 ? <span key="topup" className={styles.saleTag}>Recargas {formatEur(t.topUpCents, { compact: true })} · no es venta</span> : null,
    t.pending > 0 ? <span key="pending" className={styles.waitTag}>{t.pending === 1 ? '1 pendiente' : `${t.pending} pendientes`}</span> : null,
  ].filter(Boolean);
  return (
    <div className={styles.night}>
      <span className={styles.kicker}>
        {night.open ? 'Esta noche' : 'Desde el último cierre'} · desde las {TIME.format(new Date(night.from))}
      </span>
      <b className={`np-num ${styles.nightTotal}`}>{t.complete ? '' : 'Al menos '}{formatEur(t.salesCents, { compact: true })}</b>
      <span className={styles.nightLine}>
        {t.count === 1 ? '1 cobro' : `${t.count} cobros`} · con propinas, sin devoluciones
      </span>
      {extras.length > 0 ? <span className={styles.tags}>{extras}</span> : null}
      {t.complete ? null : <span className={styles.note}>Faltan cobros de la noche por cargar: toca «Ver anteriores».</span>}
    </div>
  );
}

function CobroRow({ row: r, night }: { row: OwnCobro; night: OwnNight | null }) {
  const state = ownCobroState(r.status);
  const when = new Date(r.createdAt);
  const tonight = night ? r.createdAt >= night.from : false;
  const left = ownChargedCents(r);
  const meta = [r.ref, r.methodLabel, r.via].filter(Boolean).join(' · ');
  return (
    <article className={styles.row} data-tone={state.tone}>
      <div className={styles.rowTop}>
        <span className={styles.chip} data-tone={state.tone}>
          <StateIcon icon={state.icon} />
          {state.label}
        </span>
        <time dateTime={r.createdAt} className={styles.time}>{tonight ? TIME.format(when) : DAY_TIME.format(when)}</time>
      </div>
      <b className={`np-num ${styles.amount}`} data-gone={(state.tone === 'bad' || (state.tone === 'void' && left === 0)) || undefined}>
        {formatEur(r.amountCents, { compact: true })}
      </b>
      {r.tipCents > 0 ? <span className={styles.tip}>+ {formatEur(r.tipCents, { compact: true })} de propina</span> : null}
      {r.refundedCents > 0 && r.status === 'PARTIALLY_REFUNDED' ? (
        <span className={styles.refund}>Devuelto {formatEur(r.refundedCents, { compact: true })} · quedan {formatEur(left, { compact: true })}</span>
      ) : null}
      <span className={styles.what}>
        {r.service ?? (r.isTopUp ? 'Recarga de saldo' : 'Cobro')}
        {r.isTopUp ? <span className={styles.saleTag}>no es venta</span> : null}
      </span>
      {r.invitedName ? <span className={styles.invited}>Invitación a {r.invitedName}</span> : null}
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </article>
  );
}

function StateIcon({ icon }: { icon: OwnCobroIcon }) {
  const path = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    clock: 'M12 7v5l3 2M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    back: 'M9 7L4.5 11.5 9 16M5 11.5h9.5a5 5 0 0 1 0 10H12',
  }[icon];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}
