'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, Modal } from '@nightpay/ui';
import type { CobroRow } from '@nightpay/contracts';
import { fetchCobros, fetchMetrics, type CobrosFilters, type Metrics, type PaymentRow, type User } from '@/lib/api';
import { cobradoNote, metricsCobradoParts } from '@/lib/cobrado';
import { COBROS_HINT } from '@/lib/cobros-help';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { paymentRowOf, reversibleSaldoCharge } from '@/lib/money-map';
import { appendPage, mergeLatestPage } from '@/lib/pagination';
import type { TabKey } from '@/lib/roles';
import { todayTiles, type NightTotals } from '@/lib/today-tiles';
import { useApprovals } from '@/lib/use-approvals';
import { usePolling } from '@/lib/use-polling';
import { BankRefundModal } from './BankRefundModal';
import { CobroRowActions } from './CobroRowActions';
import { CobrosHowTo } from './CobrosHowTo';
import { CobrosFiltersBar } from './fichas/CobrosFiltersBar';
import { CobrosTable } from './fichas/CobrosTable';
import { PaymentReferenceDetails } from './fichas/PaymentReferenceDetails';
import { Notice } from './Notice';
import { RefundModal, ResolveModal } from './PaymentModals';
import { RefundsModal } from './RefundsModal';
import { ReverseChargeModal } from './ReverseChargeModal';
import { TonightStrip } from './TonightStrip';

const PAGE_SIZE = 50;
/** Tope de `limit` en GET /v1/admin/cobros. */
const MAX_PAGE_SIZE = 200;
const POLL_MS = 5000;
const MAX_POLL_MS = 60_000;

interface Props {
  user: User;
  onNavigate?: (key: TabKey) => void;
  /** Cobro a abrir al llegar (desde una incidencia): se abren sus devoluciones. */
  focusPaymentId?: string | null;
  onFocusDone?: () => void;
  /** Filtros con los que abrir la lista (desde una cifra del mapa del dinero). */
  initialFilter?: CobrosFilters | null;
  onInitialFilterDone?: () => void;
}

/**
 * Pestaña Cobros: «Esta noche», métricas y los cobros (con tarjeta y del
 * saldo) con su referencia, chica, sección, cómo pagó y servicio, y filtros.
 * Solo pide datos mientras está a la vista (pestaña del panel y del
 * navegador), espera más si el API falla y una respuesta vieja no pisa la de
 * un filtro nuevo. Si llega lo mismo, no se repinta nada.
 */
export function PaymentsPanel({ user, onNavigate, focusPaymentId = null, onFocusDone, initialFilter = null, onInitialFilterDone }: Props) {
  // «Por aprobar»: desde cuánto pide el encargado las devoluciones al dueño.
  const refundRequestFromCents = useApprovals().rules?.refundRequestFromCents ?? null;
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  /** null = aún no ha llegado la primera página. */
  const [payments, setPayments] = useState<CobroRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<CobrosFilters>(() => initialFilter ?? {});
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailFor, setDetailFor] = useState<CobroRow | null>(null);
  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);
  const [resolveFor, setResolveFor] = useState<PaymentRow | null>(null);
  const [refundsFor, setRefundsFor] = useState<PaymentRow | null>(null);
  const [reverseFor, setReverseFor] = useState<CobroRow | null>(null);
  /** «Abrir cobro» de una incidencia que no está entre los cobros cargados. */
  const [focusMissing, setFocusMissing] = useState(false);
  // Lo cobrado y los pagos de «Esta noche»: «Hoy» no repite las cifras que coinciden.
  const [nightTotals, setNightTotals] = useState<NightTotals>(undefined);
  // Filas cargadas (el refresco pide las mismas) y filtro vigente (para
  // descartar un "Cargar más" que vuelve después de cambiar el filtro).
  const loadedRef = useRef(0);
  const filterRef = useRef(filter);
  /** La lista (al llegar desde el mapa del dinero, se baja hasta ella). */
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    loadedRef.current = payments?.length ?? 0;
  }, [payments]);

  // Desde una incidencia (devolución sin confirmar): en cuanto llega la lista,
  // se abren las devoluciones de ese cobro, donde está «Resolver».
  useEffect(() => {
    if (!focusPaymentId || payments === null) return;
    const found = payments.find((p) => p.kind === 'PAYMENT' && p.id === focusPaymentId);
    const row = found ? paymentRowOf(found) : null;
    if (row) setRefundsFor(row);
    setFocusMissing(!row);
    onFocusDone?.();
  }, [focusPaymentId, payments, onFocusDone]);

  // Desde el mapa del dinero: la lista con los filtros de esa cifra (una vez).
  useEffect(() => {
    if (!initialFilter) return;
    if (filterRef.current !== initialFilter) changeFilter(initialFilter);
    listRef.current?.scrollIntoView({ block: 'start' });
    onInitialFilterDone?.();
  }, [initialFilter, onInitialFilterDone]);

  const refresh = usePolling(
    async (signal) => {
      const loaded = loadedRef.current;
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loaded));
      try {
        const [m, page] = await Promise.all([fetchMetrics(), fetchCobros(filter, { limit })]);
        if (signal.aborted) return true;
        setMetrics((prev) => keepIfSame(prev, m));
        setPayments((prev) => (prev ? keepIfSame(prev, mergeLatestPage(page.items, prev, page.nextCursor === null)) : page.items));
        // Si entretanto se cargó otra página, su cursor es el bueno.
        if (loaded <= MAX_PAGE_SIZE && loaded === loadedRef.current) setNextCursor(page.nextCursor);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [filter],
  );

  function changeFilter(value: CobrosFilters): void {
    filterRef.current = value;
    loadedRef.current = 0;
    setPayments(null);
    setNextCursor(null);
    setFilter(value);
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    const forFilter = filter;
    setLoadingMore(true);
    try {
      const page = await fetchCobros(forFilter, { cursor: nextCursor, limit: PAGE_SIZE });
      if (filterRef.current !== forFilter) return;
      setPayments((prev) => appendPage(prev ?? [], page.items));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function afterAction(close: () => void): () => void {
    return () => {
      close();
      refresh();
    };
  }

  return (
    <>
      <TonightStrip onNavigate={onNavigate} onNightTotals={setNightTotals} />

      {focusMissing ? (
        <Notice tone="info" action={{ label: 'Entendido', onClick: () => setFocusMissing(false) }}>
          Ese cobro no está entre los últimos cargados. Pulsa «Cargar más» abajo y, en él, Devoluciones → Resolver.
        </Notice>
      ) : null}

      {error ? (
        <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
          <div style={errorRow}>
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
              {payments ? ' · se siguen enseñando los últimos datos.' : ''}
            </p>
            <Button variant="ghost" size="sm" onClick={refresh}>
              Reintentar
            </Button>
          </div>
        </Card>
      ) : null}

      <section className="np-metrics">
        {/* Los pagos con tarjeta (también las recargas con tarjeta): lo pagado con el saldo no cuenta aquí. */}
        {/* Solo si dicen otra cosa que «Esta noche» (y nada hasta saberlo: no aparecen para desaparecer). */}
        {todayTiles(nightTotals, metrics?.today) !== 'show' ? null : (
          <>
            <MetricTile title="Hoy · pagos con tarjeta" value={metrics ? String(metrics.today.count) : '—'} />
            <MetricTile
              title="Hoy · cobrado"
              value={eurOrDash(metrics ? (metrics.today.chargedCents ?? metrics.today.grossCents) : undefined)}
              // Lo que suma el total: ventas con tarjeta + propinas + recargas (no son venta).
              note={metrics ? (cobradoNote(metricsCobradoParts(metrics.today), formatEur) ?? undefined) : undefined}
            />
          </>
        )}
        <MetricTile title="Hoy · reembolsos" value={eurOrDash(metrics?.today.refundedCents)} />
        {/* El neto resta también el saldo devuelto en efectivo, que no sale en «reembolsos»: su cuenta, a la vista (P-12). */}
        <MetricTile title="Hoy · neto" value={eurOrDash(metrics?.today.netCents)} note={NET_NOTE} />
        <MetricTile title="Semana · neto" value={eurOrDash(metrics?.week.netCents)} note={NET_NOTE} />
      </section>

      <section ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', scrollMarginTop: '0.75rem', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 18rem' }}>
            <h2 style={sectionTitle}>Cobros</h2>
            <p className="np-help-line">{COBROS_HINT}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} style={{ marginLeft: 'auto' }}>
            Refrescar
          </Button>
        </div>
        <CobrosHowTo />
        <CobrosFiltersBar value={filter} onChange={changeFilter} />

        <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }}>
          <CobrosTable
            rows={payments}
            showReferences
            onDetails={setDetailFor}
            empty={
              payments === null
                ? error
                  ? 'No se pudieron cargar los cobros.'
                  : 'Cargando cobros…'
                : filter.search
                  ? `No hay ningún cobro con «${filter.search}».`
                  : 'Sin cobros'
            }
            actions={(row) => (
              <CobroRowActions
                row={row}
                role={user.role}
                onReverse={setReverseFor}
                onResolve={setResolveFor}
                onRefund={setRefundFor}
                onRefunds={setRefundsFor}
              />
            )}
          />
        </Card>

        {payments && payments.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span style={{ ...cellMeta, fontSize: '0.8125rem' }}>
              {payments.length === 1 ? '1 cobro' : `${payments.length} cobros`}
            </span>
            {nextCursor ? (
              <Button variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                Cargar más
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <Modal open={Boolean(detailFor)} onClose={() => setDetailFor(null)} title="Detalle del cobro">
        {detailFor ? <PaymentReferenceDetails row={detailFor} /> : null}
      </Modal>

      <ResolveModal
        payment={resolveFor}
        onClose={() => setResolveFor(null)}
        onDone={afterAction(() => setResolveFor(null))}
      />

      <BankRefundModal
        payment={refundFor?.provider === 'REDSYS' ? refundFor : null}
        onClose={() => setRefundFor(null)}
        onDone={afterAction(() => setRefundFor(null))}
      />

      <RefundModal
        open={Boolean(refundFor) && refundFor?.provider !== 'REDSYS'}
        payment={refundFor?.provider === 'REDSYS' ? null : refundFor}
        onClose={() => setRefundFor(null)}
        onDone={afterAction(() => setRefundFor(null))}
        requestFromCents={user.role === 'MANAGER' ? refundRequestFromCents : null}
      />

      {reverseFor && reversibleSaldoCharge(reverseFor, user.role) ? (
        <ReverseChargeModal
          key={reverseFor.id}
          row={reverseFor}
          target={reversibleSaldoCharge(reverseFor, user.role)!}
          onClose={() => setReverseFor(null)}
          onDone={afterAction(() => setReverseFor(null))}
        />
      ) : null}

      {refundsFor ? (
        <RefundsModal
          payment={refundsFor}
          isOwner={user.role === 'OWNER'}
          onClose={() => setRefundsFor(null)}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

function eurOrDash(cents: number | undefined): string {
  return cents === undefined ? '—' : formatEur(cents);
}

/**
 * Una cifra del día, en el color del texto (el lima es para la acción y el
 * «pagado»). Sin tarjeta: una fila de cifras con filetes (panel-tonight.css).
 */
/** Cómo sale el neto (period-totals.ts del API: cobrado − devoluciones − saldo devuelto en efectivo). */
const NET_NOTE = 'Cobrado − reembolsos − saldo devuelto en efectivo';

function MetricTile({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div className="np-metric">
      <p className="np-metric-label">{title}</p>
      <p className="np-metric-value">{value}</p>
      {note ? <p className="np-metric-note">{note}</p> : null}
    </div>
  );
}

const errorRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h2)',
  fontWeight: 600,
};


const cellMeta: CSSProperties = {
  color: 'var(--np-text-mute)',
};

