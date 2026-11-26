'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { CobroRow } from '@nightpay/contracts';
import { fetchCobros, fetchMetrics, type CobrosFilters, type Metrics, type PaymentRow, type User } from '@/lib/api';
import { cobradoNote, metricsCobradoParts } from '@/lib/cobrado';
import { refFromSearch, withoutRef } from '@/lib/cobro-detail-view';
import { dockKeyAction, dockView, neighbour, type DockKey, type DockSeen } from '@/lib/cobro-dock';
import { COLUMNS_STORAGE_KEY, parseColumns, type CobrosColumn } from '@/lib/cobros-views';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { paymentRowOf, reversibleSaldoCharge } from '@/lib/money-map';
import { appendPage, mergeLatestPage } from '@/lib/pagination';
import type { TabKey } from '@/lib/roles';
import { todayTiles, type NightTotals } from '@/lib/today-tiles';
import { useApprovals } from '@/lib/use-approvals';
import { usePolling } from '@/lib/use-polling';
import { BankRefundModal } from './BankRefundModal';
import { CobroDetailDock, useDocked } from './CobroDetailDock';
import { CobroRowActions } from './CobroRowActions';
import { CobrosToolbar } from './CobrosToolbar';
import { CobrosTable } from './fichas/CobrosTable';
import { Notice } from './Notice';
import { RefundModal, ResolveModal } from './PaymentModals';
import { BitcoinCashModal, type BitcoinCashTarget } from './BitcoinCashModal';
import { useBitcoinCash } from '@/lib/use-bitcoin-cash';
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
  /** Cobro cuyo detalle abrir al llegar, sin filtrar la lista. */
  openRow?: CobroRow | null;
  onOpenRowDone?: () => void;
  /** «Descargar» la lista: el dueño, y el encargado con «ver informes». */
  canExport?: boolean;
}

/**
 * Pestaña Cobros: «Esta noche», métricas y los cobros (con tarjeta y del
 * saldo) en seis columnas, con sus vistas y filtros. Tocar un cobro abre su
 * detalle al lado de la lista (sin taparla), con sus botones (devolver, anular,
 * resolver…) en el pie: las mismas reglas, confirmaciones y verificaciones.
 * Solo pide datos mientras está a la vista (pestaña del panel y del
 * navegador), espera más si el API falla y una respuesta vieja no pisa la de
 * un filtro nuevo. Si llega lo mismo, no se repinta nada.
 */
export function PaymentsPanel({
  user,
  onNavigate,
  focusPaymentId = null,
  onFocusDone,
  initialFilter = null,
  onInitialFilterDone,
  openRow = null,
  onOpenRowDone,
  canExport = false,
}: Props) {
  // «Por aprobar»: desde cuánto pide el encargado las devoluciones al dueño.
  const refundRequestFromCents = useApprovals().rules?.refundRequestFromCents ?? null;
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  /** null = aún no ha llegado la primera página. */
  const [payments, setPayments] = useState<CobroRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // El enlace de «Compartir» (?ref=C-0024): se busca ese cobro y se abre su detalle (una vez).
  const [linkRef, setLinkRef] = useState<string | null>(() => (typeof window === 'undefined' ? null : refFromSearch(window.location.search)));
  const [linkMissing, setLinkMissing] = useState<string | null>(null);
  const [filter, setFilter] = useState<CobrosFilters>(() => initialFilter ?? (linkRef ? { search: linkRef } : {}));
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // El detalle guarda QUÉ cobro está abierto; su fila sale de `payments` en cada pintada (la última del API).
  const [dock, setDock] = useState<DockKey | null>(null);
  /** La última fila vista del cobro abierto: por si deja de estar en la lista (otro filtro). */
  const lastDockRow = useRef<DockSeen | null>(null);
  /** Sube tras cada acción: el detalle se vuelve a pedir. */
  const [detailVersion, setDetailVersion] = useState(0);
  const versionRef = useRef(0);
  /** La vuelta (`detailVersion`) de la que salen las filas de la lista. */
  const [listVersion, setListVersion] = useState(0);
  /** El cobro abierto, pedido aparte tras una acción (aunque el filtro ya no lo enseñe). */
  const [freshDock, setFreshDock] = useState<DockSeen | null>(null);
  const docked = useDocked();
  const splitRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState<CobrosColumn[]>(() => readColumns());
  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);
  const [resolveFor, setResolveFor] = useState<PaymentRow | null>(null);
  const [refundsFor, setRefundsFor] = useState<PaymentRow | null>(null);
  const [cashFor, setCashFor] = useState<BitcoinCashTarget | null>(null);
  const bitcoinCash = useBitcoinCash(user.role);
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

  useEffect(() => {
    if (!linkRef || payments === null) return;
    const row = payments.find((p) => p.ref === linkRef);
    if (row) openDetail(row);
    else setLinkMissing(linkRef);
    setLinkRef(null);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${withoutRef(search)}${hash}`);
  }, [linkRef, payments]);

  // Desde otra pantalla: el detalle de ese cobro, sin filtrar la lista (una vez).
  useEffect(() => {
    if (!openRow) return;
    openDetail(openRow, versionRef.current);
    onOpenRowDone?.();
  }, [openRow, onOpenRowDone]);

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
      const version = versionRef.current;
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loaded));
      try {
        const [m, page] = await Promise.all([fetchMetrics(), fetchCobros(filter, { limit })]);
        if (signal.aborted) return true;
        setMetrics((prev) => keepIfSame(prev, m));
        setPayments((prev) => (prev ? keepIfSame(prev, mergeLatestPage(page.items, prev, page.nextCursor === null)) : page.items));
        setListVersion(version);
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

  /** Tras devolver, anular o resolver: la lista y el detalle, al día. */
  const refreshAll = useCallback(() => {
    versionRef.current += 1;
    refresh();
    setDetailVersion(versionRef.current);
  }, [refresh]);

  // Tras una acción, el cobro abierto se pide aparte, sin el filtro de la lista:
  // si ya no sale en ella (una devolución entera con «Pagado»), su fila al día llega igual.
  useEffect(() => {
    const ref = lastDockRow.current?.row.ref;
    if (detailVersion === 0 || !ref) return;
    const { kind, id } = lastDockRow.current!.row;
    let gone = false;
    fetchCobros({ search: ref }, { limit: PAGE_SIZE }).then(
      (page) => {
        const row = page.items.find((r) => r.kind === kind && r.id === id);
        if (!gone && row) setFreshDock({ row, version: detailVersion });
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [detailVersion]);

  function afterAction(close: () => void): () => void {
    return () => {
      close();
      refreshAll();
    };
  }

  /** `version`: de qué vuelta sale la fila (la de la lista, si no se dice). */
  function openDetail(row: CobroRow, version = listVersion): void {
    lastDockRow.current = { row, version };
    setDock({ kind: row.kind, id: row.id });
  }

  function changeColumns(next: CobrosColumn[]): void {
    setColumns(next);
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Sin sitio o en privado: valen hasta recargar.
    }
  }

  // Los botones del pie, solo con una fila al día (`actionsRow`): nunca con el estado o lo que queda de antes.
  const view = dockView(payments, listVersion, dock, [lastDockRow.current, freshDock], detailVersion);
  if (view.seen) lastDockRow.current = view.seen;
  const dockedRow = view.seen?.row ?? null;
  const actionsRow = view.actionsRow;

  /** La fila abierta en la tabla (para devolverle el foco o llevarla a la vista). */
  const currentRowEl = () => splitRef.current?.querySelector<HTMLElement>('tr[aria-current="true"]') ?? null;

  // Con el detalle al lado: ↑ y ↓ pasan al cobro anterior o siguiente; Esc lo cierra y el foco vuelve a su fila.
  function onSplitKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (!docked || !dock) return;
    const action = dockKeyAction(e.key, e.target as Element);
    if (!action) return;
    if (action === 'close') {
      e.preventDefault();
      const rowEl = currentRowEl();
      setDock(null);
      rowEl?.focus();
      return;
    }
    // Las flechas no mueven la página mientras hay un cobro abierto.
    e.preventDefault();
    const next = neighbour(payments, dock, action === 'prev' ? -1 : 1);
    if (!next) return;
    const fromRow = (e.target as Element).closest('tr') !== null;
    openDetail(next);
    requestAnimationFrame(() => {
      const rowEl = currentRowEl();
      rowEl?.scrollIntoView({ block: 'nearest' });
      if (fromRow) rowEl?.focus();
    });
  }

  const filtered = Object.keys(filter).length > 0;

  return (
    <>
      <TonightStrip onNavigate={onNavigate} onNightTotals={setNightTotals} />

      {focusMissing ? (
        <Notice tone="info" action={{ label: 'Entendido', onClick: () => setFocusMissing(false) }}>
          Ese cobro no está entre los últimos cargados. Pulsa «Cargar más» abajo, ábrelo y, en su detalle, Devoluciones → Resolver.
        </Notice>
      ) : null}

      {linkMissing ? (
        <Notice tone="info" action={{ label: 'Entendido', onClick: () => setLinkMissing(null) }}>
          El cobro {linkMissing} no está entre los de este local.
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

      <section className="np-metrics" data-tour="cobros-resumen">
        {/* Los pagos con tarjeta (también las recargas con tarjeta): lo pagado con el saldo no cuenta aquí. */}
        {/* Solo si dicen otra cosa que «Esta noche» (y nada hasta saberlo: no aparecen para desaparecer). */}
        {todayTiles(nightTotals, metrics?.today) !== 'show' ? null : (
          <>
            {/* Sin los pagados con bitcoin: no pasan por el banco. */}
            <MetricTile title="Hoy · pagos con tarjeta" value={metrics ? String(metrics.today.count - (metrics.today.bitcoinCount ?? 0)) : '—'} />
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

      <div ref={splitRef} className="np-cobros-split" data-open={dockedRow && docked ? '' : undefined} onKeyDown={onSplitKeyDown}>
        <section ref={listRef} className="np-cobros-list">
          <div className="np-cobros-head">
            <h2>Cobros</h2>
            <Button variant="ghost" size="sm" onClick={refresh}>
              Refrescar
            </Button>
          </div>
          <CobrosToolbar
            value={filter}
            onChange={changeFilter}
            rows={payments}
            hasMore={nextCursor !== null}
            columns={columns}
            onColumns={changeColumns}
            canExport={canExport}
          />

          <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden', minWidth: 0 }} data-tour="cobros-tabla">
            <CobrosTable
              rows={payments}
              columns={columns}
              onDetails={openDetail}
              current={dock}
              empty={
                filtered
                  ? { title: 'No hay cobros con estos filtros', action: { label: 'Quitar todo', onClick: () => changeFilter({}) } }
                  : { title: 'Aún no hay cobros', text: 'Aquí verás cada cobro y cómo se pagó.' }
              }
            />
          </Card>

          {nextCursor ? (
            <div className="np-cobros-more">
              <Button variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                Cargar más
              </Button>
            </div>
          ) : null}
        </section>

        <CobroDetailDock
          row={dockedRow}
          version={detailVersion}
          docked={docked}
          onClose={() => setDock(null)}
          actions={
            actionsRow ? (
              <CobroRowActions
                row={actionsRow}
                role={user.role}
                onReverse={setReverseFor}
                onResolve={setResolveFor}
                onRefund={setRefundFor}
                onRefunds={setRefundsFor}
                bitcoinCash={bitcoinCash}
                onCashRefund={(p) => setCashFor(cashTargetOf(p))}
              />
            ) : null
          }
        />
      </div>

      <BitcoinCashModal
        target={cashFor}
        config={bitcoinCash}
        onClose={() => setCashFor(null)}
        onDone={afterAction(() => undefined)}
      />

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
          onChanged={refreshAll}
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

/** El cobro con bitcoin que se devuelve en efectivo: lo que queda y lo ya devuelto (cuenta para el dueño). */
function cashTargetOf(p: PaymentRow): BitcoinCashTarget {
  const charged = p.amountCents + (p.serviceFeeCents ?? 0) + (p.tipCents ?? 0);
  return {
    kind: 'payment',
    paymentId: p.id,
    leftCents: p.availableAmountCents,
    alreadyCents: Math.max(0, charged - p.availableAmountCents),
    label: `Cobro de ${formatEur(charged)}`,
  };
}

/** Las columnas de más que se eligieron en este navegador («Columnas»). */
function readColumns(): CobrosColumn[] {
  try {
    return typeof window === 'undefined' ? [] : parseColumns(window.localStorage.getItem(COLUMNS_STORAGE_KEY));
  } catch {
    return [];
  }
}
