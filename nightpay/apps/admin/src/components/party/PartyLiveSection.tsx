'use client';

import { useEffect, useState } from 'react';
import type { PartyLive } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { fetchPartyLive } from '@/lib/endpoints/party';
import {
  IDLE_OPTIONS,
  IDLE_STORAGE_KEY,
  alertViews,
  deskRows,
  eventSubtitle,
  hourBars,
  hoursAria,
  idleFromStorage,
  kpisOf,
  liveBadge,
  nightChoices,
  stallRows,
  type AlertView,
  type LiveSelection,
} from '@/lib/party-live';
import type { TabKey } from '@/lib/roles';
import { usePolling } from '@/lib/use-polling';
import { useVenue } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { Pill } from '../Pill';
import { Skel } from '../Skeleton';

/** Cada cuánto se pide el directo (con la pestaña a la vista). */
const LIVE_POLL_MS = 30_000;
const DESKS_ID = 'np-party-desks';

/**
 * OxioParty · En directo (maqueta Panel): lo cargado, lo vendido, lo que
 * queda en las pulseras y las pulseras activas; las ventas por hora; los
 * avisos con su acción; las casetas por lo vendido, con su % y si llevan rato
 * sin cobrar; y de dónde entra el dinero (taquillas y móvil). Se refresca
 * cada 30 s.
 */
export function PartyLiveSection({ onNavigate }: { onNavigate: (tab: TabKey) => void }) {
  const venue = useVenue();
  const [selection, setSelection] = useState<LiveSelection>({ scope: 'night' });
  const [idleMinutes, setIdleMinutes] = useIdleMinutes();
  const [live, setLive] = useState<PartyLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const night = selection.scope === 'night' ? selection.night : undefined;

  const refresh = usePolling(
    async (signal) => {
      try {
        const data = await fetchPartyLive({ scope: selection.scope, night, idleMin: idleMinutes }, signal);
        if (signal.aborted) return true;
        setLive(data);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: LIVE_POLL_MS },
    [selection.scope, night, idleMinutes],
  );

  return (
    <PartyLiveView
      live={live}
      error={error}
      eventName={venue.name}
      timeZone={venue.timezone}
      now={new Date()}
      selection={selection}
      onSelect={setSelection}
      idleMinutes={idleMinutes}
      onIdleMinutes={setIdleMinutes}
      onRetry={refresh}
      onNavigate={onNavigate}
    />
  );
}

/** El aviso de N minutos, recordado en este navegador (si no se puede, 15). */
function useIdleMinutes(): [number, (n: number) => void] {
  const [value, setValue] = useState(() => idleFromStorage(readStorage(IDLE_STORAGE_KEY)));
  useEffect(() => {
    try {
      window.localStorage.setItem(IDLE_STORAGE_KEY, String(value));
    } catch {
      // Sin almacenamiento (privado): vale para esta visita.
    }
  }, [value]);
  return [value, setValue];
}

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export interface PartyLiveViewProps {
  live: PartyLive | null;
  error: string | null;
  eventName: string | null;
  timeZone: string;
  now: Date;
  selection: LiveSelection;
  onSelect: (s: LiveSelection) => void;
  idleMinutes: number;
  onIdleMinutes: (n: number) => void;
  onRetry: () => void;
  onNavigate: (tab: TabKey) => void;
}

export function PartyLiveView(p: PartyLiveViewProps) {
  const { live, timeZone } = p;
  const badge = live ? liveBadge(live, timeZone) : null;
  return (
    <div className="np-party" aria-busy={live ? undefined : 'true'}>
      <div className="np-party-head">
        <div className="np-party-head-text">
          <h2 className="np-party-title">{live?.event.name ?? p.eventName ?? 'La fiesta'}</h2>
          <p className="np-party-sub">{live ? eventSubtitle(live, timeZone) : 'Cargando…'}</p>
        </div>
        <div className="np-party-tools">
          <div className="np-party-seg" role="group" aria-label="Qué noche ver">
            {nightChoices(live?.event.nights ?? [], p.selection, timeZone).map((c) => (
              <button key={c.key} type="button" aria-pressed={c.pressed} title={c.title} onClick={() => p.onSelect(c.selection)}>
                {c.label}
              </button>
            ))}
          </div>
          {badge ? (
            <span className="np-party-live" data-on={badge.on}>
              {badge.text}
            </span>
          ) : null}
        </div>
      </div>

      {p.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: p.onRetry }}>
          No se pudo cargar el directo: {p.error}
        </Notice>
      ) : null}

      {live ? <LiveBody {...p} live={live} /> : <LiveSkeleton />}
    </div>
  );
}

function LiveSkeleton() {
  return (
    <div className="np-party-kpis">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="np-party-kpi">
          <Skel width="7rem" height="1rem" />
          <Skel width="10rem" height="2rem" />
          <span className="np-sr-only">{i === 0 ? 'Cargando el directo' : ''}</span>
        </div>
      ))}
    </div>
  );
}

function LiveBody(p: PartyLiveViewProps & { live: PartyLive }) {
  const { live, timeZone, now } = p;
  const bars = hourBars(live.hourly, timeZone);
  const alerts = alertViews(live.alerts, timeZone, now);
  const stalls = stallRows(live, timeZone, now);
  const desks = deskRows(live);
  const watching = live.scope === 'night' && live.live && !live.event.ended;
  return (
    <>
      <div className="np-party-kpis">
        {kpisOf(live).map((k) => (
          <div key={k.key} className="np-party-kpi" data-dark={k.dark}>
            <p className="np-party-kpi-label">{k.label}</p>
            <p className="np-party-kpi-value">{k.value}</p>
            <p className="np-party-kpi-hint">{k.hint}</p>
          </div>
        ))}
      </div>

      <div className="np-party-row">
        <section className="np-party-card" data-wide="true" aria-labelledby="np-party-h-hours">
          <div className="np-party-card-head">
            <h3 id="np-party-h-hours" className="np-party-card-title">
              Ventas por hora
            </h3>
            <span className="np-party-legend" aria-hidden="true">
              <span>
                <i />
                Cerrada
              </span>
              <span>
                <i data-open="true" />
                En curso
              </span>
            </span>
          </div>
          {bars.length === 0 ? (
            <p className="np-party-empty">Aún no hay ventas.</p>
          ) : (
            <div className="np-party-chart">
              <div className="np-party-bars" role="img" aria-label={hoursAria(bars, live.hourly)}>
                {bars.map((b) => (
                  <div key={b.key} className="np-party-bar" data-open={b.open}>
                    <span className="np-party-bar-label">{b.label}</span>
                    <div className="np-party-bar-fill" style={{ height: `${Math.max(1, Math.round(b.pct * 0.8))}%` }} />
                  </div>
                ))}
              </div>
              <div className="np-party-hours" aria-hidden="true">
                {bars.map((b) => (
                  <span key={b.key}>
                    {b.hour}
                    {b.day ? <b>{b.day}</b> : null}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="np-party-card" data-side="true" aria-labelledby="np-party-h-alerts">
          <div className="np-party-card-head">
            <h3 id="np-party-h-alerts" className="np-party-card-title">
              Avisos
            </h3>
            {alerts.length > 0 ? (
              <span className="np-party-count" aria-label={`${alerts.length} avisos`}>
                {alerts.length}
              </span>
            ) : null}
          </div>
          {alerts.length === 0 ? (
            <p className="np-party-empty">
              {watching ? 'Todo en orden: ninguna caja pasa del umbral y las casetas cobran.' : 'Los avisos salen en la noche en curso.'}
            </p>
          ) : (
            alerts.map((a) => <AlertCard key={a.key} alert={a} onNavigate={p.onNavigate} />)
          )}
          <label className="np-party-inline np-party-card-note">
            Avisar si una caseta lleva
            <select
              className="np-party-select"
              value={p.idleMinutes}
              onChange={(e) => p.onIdleMinutes(Number(e.target.value))}
              aria-label="Minutos sin cobros para avisar"
            >
              {IDLE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            sin cobros
          </label>
        </section>
      </div>

      <div className="np-party-row">
        <section className="np-party-card" data-wide="true" aria-labelledby="np-party-h-stalls">
          <div className="np-party-card-head">
            <h3 id="np-party-h-stalls" className="np-party-card-title">
              Casetas
            </h3>
            <span className="np-party-card-note">Vendido · % del total · parte del organizador</span>
          </div>
          {stalls.length === 0 ? (
            <div className="np-party-inline">
              <p className="np-party-empty">Aún no hay casetas.</p>
              <Button size="sm" variant="ghost" onClick={() => p.onNavigate('stalls')}>
                Dar de alta las casetas
              </Button>
            </div>
          ) : (
            <div className="np-party-stalls">
              {stalls.map((s) => (
                <div key={s.key} className="np-party-stall">
                  <span className="np-party-rank">{s.rank}</span>
                  <div>
                    <p className="np-party-stall-name">{s.name}</p>
                    <p className="np-party-stall-meta">{s.meta}</p>
                  </div>
                  <div className="np-party-share">
                    <span className="np-party-track" aria-hidden="true">
                      <span style={{ width: `${s.barPct}%` }} />
                    </span>
                    <small>{s.share}</small>
                  </div>
                  <p className="np-party-amount">{s.sold}</p>
                  {s.organizer ? <span className="np-party-chip">{s.organizer}</span> : <span />}
                  {s.status ? (
                    <Pill tone={s.status.tone} dot>
                      {s.status.text}
                    </Pill>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="np-party-card" data-side="true" aria-labelledby="np-party-h-desks" id={DESKS_ID} tabIndex={-1}>
          <h3 id="np-party-h-desks" className="np-party-card-title">
            De dónde entra el dinero
          </h3>
          {desks.length === 0 ? (
            <p className="np-party-empty">Aún no hay recargas.</p>
          ) : (
            desks.map((d) => (
              <div key={d.key} className="np-party-desk" data-over={d.over}>
                <div>
                  <p className="np-party-desk-name">{d.name}</p>
                  <p className="np-party-desk-detail">{d.detail}</p>
                </div>
                <p className="np-party-amount">{d.total}</p>
              </div>
            ))
          )}
        </section>
      </div>
    </>
  );
}

function AlertCard({ alert, onNavigate }: { alert: AlertView; onNavigate: (tab: TabKey) => void }) {
  return (
    <div className="np-party-alert" data-tone={alert.tone}>
      <div className="np-party-alert-body">
        <AlertIcon kind={alert.icon} />
        <div>
          <p className="np-party-alert-title">{alert.title}</p>
          <p className="np-party-alert-text">{alert.text}</p>
        </div>
      </div>
      <div className="np-party-alert-actions">
        {alert.action.kind === 'call' ? (
          <a className="np-party-linkbtn" href={alert.action.href}>
            {alert.action.label}
          </a>
        ) : alert.action.kind === 'desks' ? (
          <Button size="sm" variant="ghost" onClick={focusDesks}>
            {alert.action.label}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => onNavigate('stalls')}>
            {alert.action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

function focusDesks(): void {
  const el = document.getElementById(DESKS_ID);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

function AlertIcon({ kind }: { kind: AlertView['icon'] }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'cash' ? (
        <>
          <rect x="2.5" y="6" width="19" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      )}
    </svg>
  );
}
