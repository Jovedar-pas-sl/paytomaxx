'use client';

import { useState } from 'react';
import type { OverviewBusiness, OverviewTotals, OverviewVenue, SuperAdminOverview } from '@nightpay/contracts';
import { useVenueSwitch } from '../VenueSwitchDialog';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { fetchSaOverview } from '@/lib/endpoints/superadmin';
import { formatEur } from '@/lib/money';
import { venuePauseLabel } from '@/lib/superadmin/labels';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { Pill } from '../Pill';
import { useSa } from './context';
import { Figure, SectionHead } from './ui';

/** El resumen se refresca solo cada minuto (con la pestaña a la vista). */
const REFRESH_MS = 60_000;

/**
 * Resumen de toda la plataforma: por negocio y por local, lo cobrado hoy y
 * en la semana, lo que hay que pagar a las chicas, el saldo vivo de los
 * clientes y las incidencias abiertas. Tocar un local cambia a ese local.
 */
export function SummarySection() {
  const tz = useVenueTimezone();
  const [overview, setOverview] = useState<SuperAdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = usePolling(
    async (signal) => {
      try {
        const next = await fetchSaOverview(signal);
        if (signal.aborted) return true;
        setOverview((prev) => keepIfSame(prev, next));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: REFRESH_MS },
    [],
  );

  if (!overview) {
    return error ? (
      <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
        No se pudo cargar el resumen: {error}
      </Notice>
    ) : (
      <p className="np-sa-loading" role="status">
        Cargando el resumen…
      </p>
    );
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Toda la plataforma"
        title="Resumen"
        sub={`Actualizado a las ${formatDateTime(overview.generatedAt, tz, 'time')} · se refresca solo cada minuto`}
      />
      {error ? (
        <Notice tone="warning" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudo actualizar: {error}
        </Notice>
      ) : null}
      <TotalsBand totals={overview.totals} />
      {overview.businesses.length === 0 ? (
        <p className="np-sa-empty">Aún no hay locales.</p>
      ) : (
        overview.businesses.map((b) => <BusinessBlock key={b.businessId ?? 'none'} business={b} />)
      )}
    </div>
  );
}

function TotalsBand({ totals }: { totals: OverviewTotals }) {
  return (
    <section className="np-sa-band" aria-label="Totales de la plataforma">
      <dl className="np-sa-figs">
        <Figure label="Cobrado hoy" value={formatEur(totals.chargedTodayCents)} hero note={`${totals.paymentsToday} cobros`} />
        <Figure label="Esta semana" value={formatEur(totals.chargedWeekCents)} />
        <Figure
          label="Pendiente a chicas"
          value={formatEur(totals.pendingToChicasCents)}
          note={totals.heldForChicasCents > 0 ? `+ ${formatEur(totals.heldForChicasCents)} en espera` : undefined}
        />
        <Figure
          label="Saldo vivo de clientes"
          value={formatEur(totals.liveCustomerBalanceCents)}
          note={`${totals.liveCustomerWallets} saldos`}
        />
        <Figure label="Incidencias abiertas" value={totals.openIncidents} alert={totals.openIncidents > 0} />
        <Figure
          label="Locales en pausa"
          value={`${totals.pausedVenues} de ${totals.venues}`}
          alert={totals.pausedVenues > 0}
        />
      </dl>
    </section>
  );
}

function BusinessBlock({ business }: { business: OverviewBusiness }) {
  const t = business.totals;
  return (
    <section className="np-sa-biz" aria-label={business.name}>
      <div className="np-sa-biz-head">
        <h3 className="np-sa-subtitle">{business.name}</h3>
        {business.status === 'PAUSED' ? <Pill tone="warning">En pausa</Pill> : null}
        <p className="np-sa-biz-totals">
          Hoy <strong className="np-num">{formatEur(t.chargedTodayCents)}</strong> · Semana{' '}
          <strong className="np-num">{formatEur(t.chargedWeekCents)}</strong> · A chicas{' '}
          <strong className="np-num">{formatEur(t.pendingToChicasCents)}</strong>
        </p>
      </div>
      <ul className="np-sa-venue-grid">
        {business.venues.map((v) => (
          <li key={v.venueId}>
            <VenueTile venue={v} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function VenueTile({ venue }: { venue: OverviewVenue }) {
  const { currentSlug } = useSa();
  const switcher = useVenueSwitch();
  const isCurrent = venue.slug === currentSlug;
  const pause = venuePauseLabel(venue);

  function goTo(): void {
    if (!isCurrent) switcher.start(venue.venueId, venue.name);
  }

  return (
    <>
      <button
        type="button"
        className="np-sa-venue"
        data-current={isCurrent ? 'true' : undefined}
        data-paused={pause ? 'true' : undefined}
        aria-disabled={isCurrent || undefined}
        onClick={goTo}
      >
        <span className="np-sa-venue-top">
          <span className="np-sa-venue-name">{venue.name}</span>
          {isCurrent ? <Pill tone="info">Estás aquí</Pill> : null}
          {pause ? <Pill tone="warning">{pause}</Pill> : null}
        </span>
        <span className="np-sa-venue-figs">
          <VenueFig label="Hoy" value={formatEur(venue.chargedTodayCents)} hero />
          <VenueFig label="Semana" value={formatEur(venue.chargedWeekCents)} />
          <VenueFig label="A chicas" value={formatEur(venue.pendingToChicasCents)} />
          <VenueFig label="Saldo clientes" value={formatEur(venue.liveCustomerBalanceCents)} />
          <VenueFig label="Cobros hoy" value={String(venue.paymentsToday)} />
        </span>
        <span className="np-sa-venue-foot">
          <span data-alert={venue.openIncidents > 0 ? 'true' : undefined}>
            {venue.openIncidents === 1 ? '1 incidencia abierta' : `${venue.openIncidents} incidencias abiertas`}
          </span>
          <span className="np-sa-venue-go">
            {isCurrent ? 'Local activo' : 'Ir a este local →'}
          </span>
        </span>
      </button>
      {switcher.error ? (
        <p role="alert" className="np-sa-venue-error">
          {switcher.error}
        </p>
      ) : null}
      {switcher.dialog}
    </>
  );
}

function VenueFig({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  return (
    <span className="np-sa-venue-fig" data-hero={hero ? 'true' : undefined}>
      <span className="np-sa-venue-fig-label">{label}</span>
      <span className="np-sa-venue-fig-value">{value}</span>
    </span>
  );
}
