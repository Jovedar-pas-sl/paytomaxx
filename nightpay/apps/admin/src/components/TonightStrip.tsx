'use client';

import { useEffect, useId, useState } from 'react';
import { fetchCurrentNight, fetchTreasuryStats } from '@/lib/api';
import { COBRADO_HELP, cardPaymentsCount, cobradoNote, tonightCobradoNote, zCobradoParts } from '@/lib/cobrado';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import type { TabKey } from '@/lib/roles';
import type { NightTotals } from '@/lib/today-tiles';
import { useIncidents } from '@/lib/use-incidents';
import { useCountUp } from '@/lib/use-count-up';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Skel } from './Skeleton';

const POLL_MS = 20_000;
const MAX_POLL_MS = 120_000;

/** Lo que se enseña de la noche abierta (solo eso: el resto del Z cambia en cada refresco). */
interface NightFigures {
  openedAt: string;
  chargedCents: number;
  /** Lo que suma «Cobrado» (ventas + propinas + recargas); null si el API no lo dice. */
  chargedNote: string | null;
  /** Pagos con tarjeta (también las recargas con tarjeta). */
  count: number;
}

interface PendingFigures {
  pendingCents: number;
  operatorCount: number;
}

/**
 * Franja «Esta noche» encima de Pagos: cobrado (con lo que lo suma) y pagos
 * con tarjeta de la noche abierta, lo pendiente de pagar a las chicas y las
 * incidencias abiertas. Solo con lo que el API ya da (noche actual, tesorería
 * e incidencias); si una cifra no llega, sale "—".
 */
export function TonightStrip({
  onNavigate,
  onNightTotals,
}: {
  onNavigate?: (key: TabKey) => void;
  /**
   * Lo cobrado y los pagos con tarjeta de la noche abierta (undefined mientras
   * carga; null sin noche abierta): «Hoy» no repite las cifras que coinciden.
   */
  onNightTotals?: (totals: NightTotals) => void;
}) {
  const tz = useVenueTimezone();
  const titleId = useId();
  const { open } = useIncidents();
  /** undefined = cargando; null = no hay noche abierta. */
  const [night, setNight] = useState<NightFigures | null | undefined>(undefined);
  /** undefined = cargando; null = no llegó (sale «—», no una silueta para siempre). */
  const [pending, setPending] = useState<PendingFigures | null | undefined>(undefined);

  usePolling(
    async (signal) => {
      const [n, t] = await Promise.allSettled([fetchCurrentNight(), fetchTreasuryStats()]);
      if (signal.aborted) return true;
      if (n.status === 'fulfilled') {
        const v = n.value;
        const s = v?.z.summary;
        const next =
          v && s
            ? {
                openedAt: v.openedAt,
                chargedCents: s.chargedCents,
                chargedNote: cobradoNote(zCobradoParts(s), formatEur),
                // Pagos con tarjeta: sin los de bitcoin (no pasan por el banco).
                count: cardPaymentsCount(s),
              }
            : null;
        setNight((prev) => keepIfSame(prev, next));
      }
      if (t.status === 'fulfilled') {
        const next = { pendingCents: t.value.pendingPayoutsCents, operatorCount: t.value.pendingOperatorCount };
        setPending((prev) => keepIfSame(prev ?? null, next));
      } else {
        // Sin respuesta: «—» (si ya había una cifra, se queda).
        setPending((prev) => prev ?? null);
      }
      return n.status === 'fulfilled' && t.status === 'fulfilled';
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [],
  );

  // Los totales suben contando cuando cambian (medio segundo; sin movimiento, directos).
  const chargedShown = useCountUp(night ? night.chargedCents : null);
  const cardCountShown = useCountUp(night ? night.count : null);
  const pendingShown = useCountUp(pending ? pending.pendingCents : null);
  const openCount = open ? open.length : null;
  const cobradoLine = tonightCobradoNote(night);
  const chargedCents = night ? night.chargedCents : null;
  const cardCount = night ? night.count : null;
  const known = night !== undefined;
  useEffect(() => {
    if (!known) onNightTotals?.(undefined);
    else onNightTotals?.(chargedCents === null || cardCount === null ? null : { chargedCents, count: cardCount });
  }, [known, chargedCents, cardCount, onNightTotals]);

  return (
    <section className="np-tonight" aria-labelledby={titleId}>
      <div className="np-tonight-head">
        <h2 id={titleId} className="np-tonight-title">
          Esta noche
        </h2>
        {night === undefined ? (
          <span className="np-tonight-since" role="status">
            <Skel width="11rem" height="1rem" />
            <span className="np-sr-only">Cargando la noche</span>
          </span>
        ) : night ? (
          <span className="np-tonight-since">Abierta desde las {formatDateTime(night.openedAt, tz, 'time')}</span>
        ) : onNavigate ? (
          <button type="button" className="np-tonight-link" onClick={() => onNavigate('nights')}>
            No hay noche abierta · Abrirla
          </button>
        ) : (
          <span className="np-tonight-since">No hay noche abierta</span>
        )}
      </div>
      <dl className="np-tonight-grid">
        {/* Qué cuenta: el desglose (o, sin él, de qué está hecho) y, al pasar el ratón, la frase entera. */}
        <div className="np-tonight-fig" data-hero="" data-tone="ok" title={COBRADO_HELP}>
          <dt>Pagado esta noche</dt>
          <dd className="np-count">{chargedShown !== null ? formatEur(chargedShown) : night === undefined ? <Skel width="9rem" height="2.75rem" /> : '—'}</dd>
          {cobradoLine ? <span className="np-tonight-note">{cobradoLine}</span> : null}
        </div>
        <div className="np-tonight-fig" data-tone="card">
          <dt>Pagos con tarjeta</dt>
          <dd className="np-count">{cardCountShown !== null ? cardCountShown : night === undefined ? <Skel width="3rem" height="1.5rem" /> : '—'}</dd>
        </div>
        <div className="np-tonight-fig" data-tone="pay">
          {/* «A pagar ya»: lo que se les debe ahora; lo de esta noche sale en el Mapa del dinero
              («Pago a compañeras · al cerrar»). Antes las dos cifras parecían la misma (P-11). */}
          <dt>A pagar ya a compañeras</dt>
          <dd className="np-count">{pendingShown !== null ? formatEur(pendingShown) : pending === undefined ? <Skel width="6rem" height="1.5rem" /> : '—'}</dd>
          {pending && pending.operatorCount > 0 ? (
            <span className="np-tonight-note">{pending.operatorCount === 1 ? '1 compañera' : `${pending.operatorCount} compañeras`}</span>
          ) : null}
        </div>
        <div className="np-tonight-fig" data-tone="warn">
          <dt>Avisos abiertos</dt>
          <dd>{openCount ?? '—'}</dd>
          {openCount && onNavigate ? (
            <button type="button" className="np-tonight-link" onClick={() => onNavigate('incidents')}>
              Ver avisos
            </button>
          ) : openCount === 0 ? (
            <span className="np-tonight-note">Todo en orden</span>
          ) : null}
        </div>
      </dl>
    </section>
  );
}
