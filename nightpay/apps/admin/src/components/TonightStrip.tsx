'use client';

import { useId, useState } from 'react';
import { Button, FormError, Importe, RollingNumber } from '@nightpay/ui';
import { fetchCurrentNight, fetchTreasuryStats } from '@/lib/api';
import { COBRADO_HELP, cardPaymentsCount, cobradoNote, tonightCobradoNote, zCobradoParts } from '@/lib/cobrado';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { hourlyLabel, hoursLine, type NightHourView } from '@/lib/resumen';
import type { TabKey } from '@/lib/roles';
import { useIncidents } from '@/lib/use-incidents';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Skel } from './Skeleton';
import { Sparkline } from './Sparkline';

const POLL_MS = 20_000;
const MAX_POLL_MS = 120_000;

/** Lo que se enseña de la noche abierta (solo eso: el resto del Z cambia en cada refresco). */
interface NightFigures {
  openedAt: string;
  chargedCents: number;
  /** Lo que suma «Cobrado» (ventas + propinas + recargas); null si el API no lo dice. */
  chargedNote: string | null;
  /** Pagos con tarjeta (también las recargas con tarjeta). */
  cardCount: number;
  /** Lo que suma «Pagado»: los cobros (`summary.count`) y las recargas en efectivo. */
  count: number;
  cashTopUpsCount: number;
  /** Lo pagado hora a hora (un API de antes no lo trae: sin gráfico). */
  hourly: NightHourView[] | undefined;
}

interface PendingFigures {
  pendingCents: number;
  operatorCount: number;
}

/**
 * «Pagado esta noche» en el Resumen (idea 13), solo con lo que el API ya da:
 *  - `hero` (quien ve el mapa del dinero): lo pagado en grande, su gráfico
 *    por horas, el desglose y la línea de las horas. Las otras tres cifras
 *    las pone el mapa, al lado.
 *  - `full` (encargado sin informes): las cuatro cifras de hoy en toda la
 *    fila (pagado, pagos con tarjeta, lo pendiente de pagar a las compañeras
 *    y los avisos abiertos), con el gráfico y la línea en «Pagado».
 * Si una cifra no llega, sale «—»; si la noche no llega nunca, su error y «Reintentar».
 */
export function TonightStrip({
  variant,
  onNavigate,
  onCloseNight,
  closeBusy = false,
}: {
  variant: 'hero' | 'full';
  onNavigate?: (key: TabKey) => void;
  /** «Cerrar noche» con la noche abierta (el dueño, o el encargado con permiso): abre el cierre en pasos. */
  onCloseNight?: () => void;
  closeBusy?: boolean;
}) {
  const tz = useVenueTimezone();
  const titleId = useId();
  const { open } = useIncidents();
  const full = variant === 'full';
  /** undefined = cargando; null = no hay noche abierta. */
  const [night, setNight] = useState<NightFigures | null | undefined>(undefined);
  const [nightFailed, setNightFailed] = useState(false);
  /** undefined = cargando; null = no llegó (sale «—», no una silueta para siempre). */
  const [pending, setPending] = useState<PendingFigures | null | undefined>(undefined);

  const refresh = usePolling(
    async (signal) => {
      const [n, t] = await Promise.allSettled([fetchCurrentNight(), full ? fetchTreasuryStats() : Promise.resolve(null)]);
      if (signal.aborted) return true;
      if (n.status === 'fulfilled') {
        const v = n.value;
        const s = v?.z.summary;
        const next: NightFigures | null =
          v && s
            ? {
                openedAt: v.openedAt,
                chargedCents: s.chargedCents,
                chargedNote: cobradoNote(zCobradoParts(s), formatEur),
                // Pagos con tarjeta: sin los de bitcoin (no pasan por el banco).
                cardCount: cardPaymentsCount(s),
                count: s.count,
                cashTopUpsCount: s.walletCashTopUpsCount ?? 0,
                hourly: v.hourly,
              }
            : null;
        setNight((prev) => keepIfSame(prev, next));
        setNightFailed(false);
      } else {
        setNightFailed(true);
      }
      if (t.status === 'fulfilled' && t.value) {
        const next = { pendingCents: t.value.pendingPayoutsCents, operatorCount: t.value.pendingOperatorCount };
        setPending((prev) => keepIfSame(prev ?? null, next));
      } else if (full) {
        // Sin respuesta: «—» (si ya había una cifra, se queda).
        setPending((prev) => prev ?? null);
      }
      return n.status === 'fulfilled' && t.status === 'fulfilled';
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [full],
  );

  const openCount = open ? open.length : null;
  const cobradoLine = tonightCobradoNote(night);
  const line = night ? hoursLine({ count: night.count, cashTopUpsCount: night.cashTopUpsCount, chargedCents: night.chargedCents, hourly: night.hourly, timeZone: tz, full }) : null;
  const hourly = night?.hourly ?? [];

  /** Sin la noche y sin poder pedirla: lo dice y deja volver a intentarlo (una cifra vieja, si la hay, se queda). */
  const failed = nightFailed && night === undefined;

  const since =
    night === undefined ? (
      failed ? null : (
        <span className="np-tonight-since" role="status">
          <Skel width="9rem" height="1rem" />
          <span className="np-sr-only">Cargando la noche</span>
        </span>
      )
    ) : night ? (
      <span className="np-tonight-since">
        {full ? 'Abierta desde las' : '· desde las'} {formatDateTime(night.openedAt, tz, 'time')}
      </span>
    ) : onNavigate ? (
      <button type="button" className="np-tonight-link" onClick={() => onNavigate('nights')}>
        No hay noche abierta · Abrirla
      </button>
    ) : (
      <span className="np-tonight-since">No hay noche abierta</span>
    );

  const paid = (
    <>
      <dd className="np-count">
        {night ? (
          <Importe cents={night.chargedCents} size={full ? undefined : 'hero'} decimals="always" rolling />
        ) : night === undefined && !failed ? (
          <Skel width="9rem" height="2.75rem" />
        ) : full ? (
          '—'
        ) : null}
      </dd>
      {night ? <Sparkline values={hourly.map((h) => h.chargedCents)} label={hourlyLabel(hourly, tz)} /> : null}
      {cobradoLine ? <span className="np-tonight-note np-tonight-parts">{cobradoLine}</span> : null}
      {line ? (
        <span className="np-tonight-hours">
          {line.lead} <Importe cents={line.averageCents} decimals="always" />
        </span>
      ) : null}
    </>
  );

  const closeButton =
    night && onCloseNight ? (
      <Button variant="ghost" size="sm" className="np-tonight-close" onClick={onCloseNight} loading={closeBusy}>
        Cerrar noche
      </Button>
    ) : null;

  const error = failed ? (
    <div className="np-tonight-error">
      <FormError>No se pudo cargar la noche.</FormError>
      <Button variant="ghost" size="sm" onClick={refresh}>
        Reintentar
      </Button>
    </div>
  ) : null;

  if (!full) {
    return (
      <section className="np-tonight" data-variant="hero" aria-labelledby={titleId} data-tour="resumen-noche">
        <div className="np-tonight-head">
          <h2 id={titleId} className="np-tonight-title">
            Pagado esta noche
          </h2>
          {since}
          {closeButton}
        </div>
        {error}
        <dl className="np-tonight-hero">
          <div className="np-tonight-fig" data-hero="" data-tone="ok" title={COBRADO_HELP}>
            <dt className="np-sr-only">Pagado esta noche</dt>
            {paid}
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section className="np-tonight" data-variant="full" aria-labelledby={titleId} data-tour="resumen-noche">
      <div className="np-tonight-head">
        <h2 id={titleId} className="np-tonight-title">
          Esta noche
        </h2>
        {since}
        {closeButton}
      </div>
      {error}
      <dl className="np-tonight-grid">
        {/* Qué cuenta: el desglose (o, sin él, de qué está hecho) y, al pasar el ratón, la frase entera. */}
        <div className="np-tonight-fig" data-hero="" data-tone="ok" title={COBRADO_HELP}>
          <dt>Pagado esta noche</dt>
          {paid}
        </div>
        <div className="np-tonight-fig" data-tone="card">
          <dt>Pagos con tarjeta</dt>
          <dd className="np-count">{night ? <RollingNumber text={String(night.cardCount)} /> : night === undefined && !failed ? <Skel width="3rem" height="1.5rem" /> : '—'}</dd>
        </div>
        <div className="np-tonight-fig" data-tone="pay">
          {/* «A pagar ya»: lo que se les debe ahora; lo de esta noche sale en el Mapa del dinero
              («Pago a compañeras · al cerrar»). Antes las dos cifras parecían la misma (P-11). */}
          <dt>A pagar ya a compañeras</dt>
          <dd className="np-count">{pending ? <Importe cents={pending.pendingCents} decimals="always" rolling /> : pending === undefined ? <Skel width="6rem" height="1.5rem" /> : '—'}</dd>
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
