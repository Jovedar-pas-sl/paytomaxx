'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, EmptyState, Etiqueta, FormError, Sheet, Skeleton, formatDateTime, useToast } from '@nightpay/ui';
import type { PartnerConnectionView, PartnerLoadAdminView, PartnerOwnerStatement } from '@nightpay/contracts';
import { fetchPartnerLoads, fetchPartnerStatement } from '@/lib/endpoints/partner-connections';
import { formatEur } from '@/lib/money';
import {
  COUNT_CASH_TEXT,
  LOAD_VOIDED_NOTICE,
  NIGHT_WINDOW_TEXT,
  NO_LOADS_TEXT,
  canVoidLoad,
  deviceLabel,
  loadState,
  nightNav,
  statementTotals,
} from '@/lib/partner-connections';
import { currentNight, nightLabel } from '@/lib/reservations';
import { VoidLoadSheet } from './VoidLoadSheet';

const messageOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'No se pudo cargar.');

/**
 * «Movimientos» de una conexión (dueño y encargado, también de una anulada):
 * las cargas de sus cajeros en una noche (de 08:00 a 08:00), sus totales y
 * los de cada cajero, para contar por la mañana el efectivo de cada uno.
 * «Anular carga» en las de menos de 36 h; lo decide el servidor.
 */
export function MovementsSheet({
  connection,
  timezone,
  onClose,
}: {
  connection: PartnerConnectionView;
  timezone: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [day, setDay] = useState(() => currentNight());
  const [statement, setStatement] = useState<PartnerOwnerStatement | null>(null);
  const [loads, setLoads] = useState<PartnerLoadAdminView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<PartnerLoadAdminView | null>(null);
  /** La noche que se está viendo: una página que llega tarde de otra noche no se pinta. */
  const shown = useRef(day);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    shown.current = day;
    setStatement(null);
    setLoads([]);
    setNextCursor(null);
    setError(null);
    setMoreError(null);
    Promise.all([
      fetchPartnerStatement(connection.id, day, controller.signal),
      fetchPartnerLoads(connection.id, { businessDate: day }, controller.signal),
    ])
      .then(([st, page]) => {
        if (controller.signal.aborted) return;
        setStatement(st);
        setLoads(page.loads);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(err));
      });
    return () => controller.abort();
  }, [connection.id, day, attempt]);

  async function more(): Promise<void> {
    if (!nextCursor || moreBusy) return;
    const forDay = day;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await fetchPartnerLoads(connection.id, { businessDate: forDay, cursor: nextCursor });
      if (shown.current !== forDay) return;
      setLoads((prev) => [...prev, ...page.loads]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (shown.current === forDay) setMoreError(messageOf(err));
    } finally {
      setMoreBusy(false);
    }
  }

  const today = currentNight();
  const nav = nightNav(day, today);
  const nowMs = Date.now();
  const loading = !statement && !error;

  return (
    <>
      <Sheet
        open={voiding === null}
        title={`Movimientos de ${connection.partnerName}`}
        onClose={onClose}
        full
        width="48rem"
        footer={
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        }
      >
        <div className="np-ptn-mv">
          <div className="np-ptn-mv-night">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDay(nav.previous)} disabled={loading}>
              Noche anterior
            </Button>
            <p className="np-ptn-mv-day">
              <strong>{nightLabel(day)}</strong>
              <span className="np-ptn-help">{NIGHT_WINDOW_TEXT}</span>
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => (nav.next ? setDay(nav.next) : undefined)}
              disabled={loading || nav.next === null}
            >
              Noche siguiente
            </Button>
          </div>

          {error ? (
            <Banner tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
              No se pudieron cargar los movimientos: {error}
            </Banner>
          ) : !statement ? (
            <div className="np-ptn-mv-loading" aria-busy="true">
              <Skeleton height="4.5rem" />
              <Skeleton lines={4} />
            </div>
          ) : (
            <>
              <dl className="np-ptn-mv-totals">
                {statementTotals(statement).map((t) => (
                  <div key={t.key} className="np-ptn-mv-total" data-key={t.key}>
                    <dt>{t.count === null ? t.label : `${t.label} (${t.count})`}</dt>
                    <dd className="np-num">{formatEur(t.cents)}</dd>
                  </div>
                ))}
              </dl>
              <p className="np-ptn-help">{COUNT_CASH_TEXT}</p>

              {statement.byDevice.length > 0 ? (
                <section className="np-ptn-mv-section" aria-label="Por cajero">
                  <h3 className="np-ptn-label">Por cajero</h3>
                  <ul className="np-ptn-mv-devices">
                    {statement.byDevice.map((d) => (
                      <li key={d.device ?? ''}>
                        <span className="np-ptn-mv-device">{deviceLabel(d.device)}</span>
                        <span className="np-ptn-mv-count">
                          {d.loadsCount} {d.loadsCount === 1 ? 'carga' : 'cargas'}
                          {d.voidsCount > 0 ? ` · ${d.voidsCount} ${d.voidsCount === 1 ? 'anulada' : 'anuladas'}` : ''}
                        </span>
                        <span className="np-num">{formatEur(d.netCents)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {loads.length === 0 ? (
                <EmptyState icon="cash" title={NO_LOADS_TEXT} compact />
              ) : (
                <ul className="np-ptn-mv-loads" aria-label="Cargas">
                  {loads.map((l) => (
                    <LoadRow key={l.id} load={l} timezone={timezone} canVoid={canVoidLoad(l, nowMs)} onVoid={() => setVoiding(l)} />
                  ))}
                </ul>
              )}

              {moreError ? <FormError>{moreError}</FormError> : null}
              {nextCursor ? (
                <div className="np-ptn-mv-more">
                  <Button type="button" variant="ghost" onClick={() => void more()} loading={moreBusy}>
                    Ver más
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Sheet>
      {voiding ? (
        <VoidLoadSheet
          connectionId={connection.id}
          load={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            toast.show(LOAD_VOIDED_NOTICE, { tone: 'success' });
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function LoadRow({
  load,
  timezone,
  canVoid,
  onVoid,
}: {
  load: PartnerLoadAdminView;
  timezone: string;
  canVoid: boolean;
  onVoid: () => void;
}) {
  const state = loadState(load);
  return (
    <li className="np-ptn-mv-load" data-state={load.status}>
      <span className="np-ptn-mv-time">{formatDateTime(load.createdAt, timezone, 'time')}</span>
      <span className="np-ptn-mv-amount np-num">{formatEur(load.amountCents)}</span>
      <span className="np-ptn-mv-device">{deviceLabel(load.device)}</span>
      <span className="np-ptn-mv-desc">
        {load.description}
        <span className="np-ptn-help">Saldo {load.codeHint}</span>
        {state ? (
          <span className="np-ptn-mv-state">
            <Etiqueta tone="neutral">{state.label}</Etiqueta>
            {state.reason ? <span className="np-ptn-help">«{state.reason}»</span> : null}
          </span>
        ) : null}
      </span>
      <span className="np-ptn-mv-act">
        {canVoid ? (
          <Button type="button" size="sm" variant="danger-outline" onClick={onVoid}>
            Anular carga
          </Button>
        ) : null}
      </span>
    </li>
  );
}
