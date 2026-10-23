'use client';

import { useEffect, useId, useState } from 'react';
import { fetchCurrentNight, fetchTreasuryStats } from '@/lib/api';
import { cobradoNote, zCobradoParts } from '@/lib/cobrado';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import type { TabKey } from '@/lib/roles';
import type { NightTotals } from '@/lib/today-tiles';
import { useIncidents } from '@/lib/use-incidents';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';

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
  const [pending, setPending] = useState<PendingFigures | null>(null);

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
                count: s.count,
              }
            : null;
        setNight((prev) => keepIfSame(prev, next));
      }
      if (t.status === 'fulfilled') {
        const next = { pendingCents: t.value.pendingPayoutsCents, operatorCount: t.value.pendingOperatorCount };
        setPending((prev) => keepIfSame(prev, next));
      }
      return n.status === 'fulfilled' && t.status === 'fulfilled';
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [],
  );

  const openCount = open ? open.length : null;
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
          <span className="np-tonight-since">Cargando…</span>
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
        <div className="np-tonight-fig" data-hero="">
          <dt>Cobrado</dt>
          <dd>{night ? formatEur(night.chargedCents) : '—'}</dd>
          {night?.chargedNote ? <span className="np-tonight-note">{night.chargedNote}</span> : null}
        </div>
        <div className="np-tonight-fig">
          <dt>Pagos con tarjeta</dt>
          <dd>{night ? night.count : '—'}</dd>
        </div>
        <div className="np-tonight-fig">
          <dt>Pendiente a chicas</dt>
          <dd>{pending ? formatEur(pending.pendingCents) : '—'}</dd>
          {pending && pending.operatorCount > 0 ? (
            <span className="np-tonight-note">
              a pagar ya · {pending.operatorCount === 1 ? '1 chica' : `${pending.operatorCount} chicas`}
            </span>
          ) : null}
        </div>
        <div className="np-tonight-fig">
          <dt>Incidencias abiertas</dt>
          <dd>{openCount ?? '—'}</dd>
          {openCount && onNavigate ? (
            <button type="button" className="np-tonight-link" onClick={() => onNavigate('incidents')}>
              Ver incidencias
            </button>
          ) : openCount === 0 ? (
            <span className="np-tonight-note">Todo en orden</span>
          ) : null}
        </div>
      </dl>
    </section>
  );
}
