'use client';

import { useState } from 'react';
import type { NightView } from '@/lib/api';
import type { CobroRow, MoneyMap } from '@nightpay/contracts';
import { Button, Etiqueta, FormError } from '@nightpay/ui';
import { fetchCobros, fetchCurrentNight, fetchMoneyMap } from '@/lib/api';
import { decidableCount } from '@/lib/approvals';
import { avisosCount } from '@/lib/bottom-nav';
import { keepIfSame } from '@/lib/diff';
import { moneyMapQuestions } from '@/lib/money-map-questions';
import { attentionList, moreAvisosLabel, type AttentionItem } from '@/lib/resumen';
import type { PanelTab, TabKey } from '@/lib/roles';
import { useApprovals } from '@/lib/use-approvals';
import { useIncidents } from '@/lib/use-incidents';
import { usePolling } from '@/lib/use-polling';
import { useSections } from '@/lib/use-sections';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { CobrosTable } from './fichas/CobrosTable';
import { NightCloseScreen } from './NightCloseScreen';
import { PrimerosPasos } from './PrimerosPasos';
import { QuestionCardView } from './money-map/MoneyMapView';
import { Skel } from './Skeleton';
import { TonightStrip } from './TonightStrip';

const MAP_POLL_MS = 30_000;
const MAP_MAX_POLL_MS = 240_000;
const COBROS_POLL_MS = 20_000;
const COBROS_MAX_POLL_MS = 120_000;
/** Las tres preguntas del mapa que van en la portada (el banco se queda en el mapa). */
const MAP_CARDS = ['ganado', 'caja', 'debo'] as const;

interface Props {
  isOwner: boolean;
  /** El local (las marcas de Primeros pasos van por local). */
  tenantId: string;
  /** El dueño, o el encargado con «cerrar la noche»: el botón «Cerrar noche» de «Esta noche». */
  canCloseNight: boolean;
  /** Quien ve el mapa del dinero (el dueño, y el encargado con «ver informes»). */
  showMoneyMap: boolean;
  /** Ya se sabe si lo ve (el permiso del encargado tarda): hasta entonces, siluetas. */
  mapKnown: boolean;
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  /** «Abrir cobro» de un aviso (Cobros, con sus devoluciones). */
  onOpenPayment: (paymentId: string) => void;
  /** Un cobro de «Últimos cobros»: Cobros con su detalle abierto. */
  onOpenCobro: (row: CobroRow) => void;
}

/**
 * Hoy → Resumen (idea 13), la portada: una fila de cifras («Pagado esta
 * noche» y, para quien ve el mapa del dinero, lo ganado, la caja y lo que se
 * debe), y debajo «Pide tu atención» y «Últimos cobros». Solo enseña: los
 * botones del dinero (devolver, anular, resolver) siguen en el detalle de
 * Cobros. Cada bloque carga y falla aparte.
 */
export function ResumenPanel({ isOwner, tenantId, canCloseNight, showMoneyMap, mapKnown, tabs, onNavigate, onOpenPayment, onOpenCobro }: Props) {
  const withMap = showMoneyMap || !mapKnown;
  /** «Cerrar noche»: la noche abierta, pedida al tocar (como en Noches). */
  const [closing, setClosing] = useState<NightView | null>(null);
  const [opening, setOpening] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  /** Al cerrar la noche se vuelve a cargar todo el Resumen. */
  const [generation, setGeneration] = useState(0);

  async function openClose(): Promise<void> {
    setOpening(true);
    setCloseError(null);
    try {
      const night = await fetchCurrentNight();
      if (night) setClosing(night);
      else setGeneration((g) => g + 1);
    } catch (err) {
      setCloseError((err as Error).message);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="np-resumen" key={generation}>
      {isOwner ? <PrimerosPasos tenantId={tenantId} onNavigate={onNavigate} /> : null}
      {closeError ? <FormError>No se pudo abrir el cierre: {closeError}</FormError> : null}
      <div className="np-resumen-figs" data-map={withMap ? '' : undefined}>
        <TonightStrip
          variant={withMap ? 'hero' : 'full'}
          onNavigate={onNavigate}
          onCloseNight={canCloseNight ? () => void openClose() : undefined}
          closeBusy={opening}
        />
        {withMap ? <MapFigures known={mapKnown} onOpen={() => onNavigate('money')} /> : null}
      </div>
      <div className="np-resumen-cols">
        <Attention isOwner={isOwner} tabs={tabs} onNavigate={onNavigate} onOpenPayment={onOpenPayment} />
        <LatestCobros onOpenCobro={onOpenCobro} onNavigate={onNavigate} />
      </div>
      {closing ? (
        <NightCloseScreen
          night={closing}
          isOwner={isOwner}
          tabs={tabs}
          onNavigate={onNavigate}
          onClose={() => setClosing(null)}
          onClosed={() => {
            setClosing(null);
            setGeneration((g) => g + 1);
          }}
        />
      ) : null}
    </div>
  );
}

/** Lo ganado, la caja y lo que se debe (las preguntas del mapa del dinero de esta noche); tocar una abre el mapa. */
function MapFigures({ known, onOpen }: { known: boolean; onOpen: () => void }) {
  const venue = useVenue();
  const { sections } = useSections();
  const [map, setMap] = useState<MoneyMap | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = usePolling(
    async (signal) => {
      try {
        const next = await fetchMoneyMap({}, signal);
        if (signal.aborted) return true;
        setMap((prev) => keepIfSame(prev, next));
        setFailed(false);
        return true;
      } catch {
        if (!signal.aborted) setFailed(true);
        return false;
      }
    },
    { intervalMs: MAP_POLL_MS, maxIntervalMs: MAP_MAX_POLL_MS, enabled: known },
    [venue.slug, known],
  );

  if (known && failed && !map) {
    return (
      <div className="np-resumen-map" data-tour="resumen-mapa">
        <div className="np-resumen-error">
          <FormError>No se pudo cargar el dinero de esta noche.</FormError>
          <Button variant="ghost" size="sm" onClick={refresh}>
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const cards = map ? moneyMapQuestions(map, sections).cards.filter((c) => (MAP_CARDS as readonly string[]).includes(c.key)) : null;
  return (
    <div className="np-resumen-map" data-tour="resumen-mapa" aria-busy={cards ? undefined : 'true'}>
      {cards
        ? cards.map((card) => <QuestionCardView key={card.key} card={card} onOpen={onOpen} />)
        : MAP_CARDS.map((key) => (
            <div key={key} className="np-mmq-card" aria-hidden="true">
              <Skel width="70%" height="1.125rem" />
              <Skel width="45%" height="2rem" />
            </div>
          ))}
      {cards ? null : <span className="np-sr-only">Cargando el dinero de esta noche…</span>}
    </div>
  );
}

/** «Pide tu atención»: lo que decidir (el dueño) y los avisos abiertos, como mucho tres. */
function Attention({ isOwner, tabs, onNavigate, onOpenPayment }: { isOwner: boolean; tabs: readonly PanelTab[]; onNavigate: (key: TabKey) => void; onOpenPayment: (paymentId: string) => void }) {
  const tz = useVenueTimezone();
  const approvals = useApprovals();
  const incidents = useIncidents();
  const { items, total } = attentionList({ approvals: approvals.pending, incidents: incidents.open, isOwner, tabs, now: new Date(), timeZone: tz });
  // El mismo número que el globo de «Hoy».
  const count = avisosCount({ incidents: incidents.open, approvals: decidableCount(approvals.pending), isOwner }) ?? total;
  const more = moreAvisosLabel(count);
  // Sin los avisos no se puede decir «Todo en orden», aunque las aprobaciones ya estén.
  const loading = incidents.open === null;

  function act(item: AttentionItem): void {
    const a = item.action;
    if (a.kind === 'payment') onOpenPayment(a.paymentId);
    else if (a.kind === 'tab') onNavigate(a.tab);
    else onNavigate('incidents');
  }

  let body;
  if (loading && incidents.error) {
    body = (
      <div className="np-resumen-error">
        <FormError>No se pudieron cargar los avisos.</FormError>
        <Button variant="ghost" size="sm" onClick={incidents.refresh}>
          Reintentar
        </Button>
      </div>
    );
  } else if (loading) {
    body = (
      <div aria-busy="true">
        <span className="np-sr-only">Cargando los avisos…</span>
        <Skel lines={3} />
      </div>
    );
  } else if (items.length === 0) {
    body = <p className="np-resumen-calma">Todo en orden. No hay nada pendiente.</p>;
  } else {
    body = (
      <ul className="np-resumen-rows">
        {items.map((item) => (
          <li key={item.key} className="np-resumen-row">
            <Etiqueta tone={item.tone} size="sm">
              {item.tag}
            </Etiqueta>
            <span className="np-resumen-row-text">
              <span className="np-resumen-row-title">{item.title}</span>
              <span className="np-resumen-row-meta">{item.meta}</span>
            </span>
            <Button variant="ghost" size="sm" className="np-resumen-row-btn" onClick={() => act(item)}>
              {item.action.label}
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="np-resumen-block" data-col="atencion" aria-labelledby="np-resumen-atencion" data-tour="resumen-atencion">
      <h2 id="np-resumen-atencion" className="np-resumen-title">
        Pide tu atención
      </h2>
      {body}
      {more ? (
        <button type="button" className="np-tonight-link np-resumen-more" onClick={() => onNavigate('incidents')}>
          {more}
        </button>
      ) : null}
    </section>
  );
}

/** Los cinco últimos cobros (hora, qué, estado e importe); tocar uno abre su detalle en Cobros. */
function LatestCobros({ onOpenCobro, onNavigate }: { onOpenCobro: (row: CobroRow) => void; onNavigate: (key: TabKey) => void }) {
  const venue = useVenue();
  const [rows, setRows] = useState<CobroRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = usePolling(
    async (signal) => {
      try {
        const page = await fetchCobros({}, { limit: 5 });
        if (signal.aborted) return true;
        setRows((prev) => keepIfSame(prev, page.items));
        setFailed(false);
        return true;
      } catch {
        if (!signal.aborted) setFailed(true);
        return false;
      }
    },
    { intervalMs: COBROS_POLL_MS, maxIntervalMs: COBROS_MAX_POLL_MS },
    [venue.slug],
  );

  return (
    <section className="np-resumen-block" data-col="cobros" aria-labelledby="np-resumen-cobros" data-tour="resumen-cobros">
      <h2 id="np-resumen-cobros" className="np-resumen-title">
        Últimos cobros
      </h2>
      {failed && rows === null ? (
        <div className="np-resumen-error">
          <FormError>No se pudieron cargar los cobros.</FormError>
          <Button variant="ghost" size="sm" onClick={refresh}>
            Reintentar
          </Button>
        </div>
      ) : (
        <div className="np-table-host np-resumen-cobros">
          <CobrosTable rows={rows} compact onDetails={onOpenCobro} empty={{ title: 'Aún no hay cobros' }} />
        </div>
      )}
      <button type="button" className="np-tonight-link np-resumen-more" onClick={() => onNavigate('payments')}>
        Ver todos los cobros
      </button>
    </section>
  );
}
