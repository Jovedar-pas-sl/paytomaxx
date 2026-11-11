'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, Input, useNow } from '@nightpay/ui';
import type { Incident } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { fixTabFor, incidentHeading, incidentHint, incidentKey, kindMeta, type ResolvedIncident } from '@/lib/incident-inbox';
import { formatEur } from '@/lib/money';
import type { PanelTab, TabKey } from '@/lib/roles';
import { UNDO_RESOLVE_MS, resolveNoteOk, undoMsLeft, undoSecondsLeft } from '@/lib/undo-resolve';
import { useIncidents } from '@/lib/use-incidents';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';

interface Props {
  isOwner: boolean;
  /** Pestañas que ve este rol (para «Ir a …»). */
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  /** Abrir un cobro en Pagos (sus devoluciones). */
  onOpenPayment: (paymentId: string) => void;
  /** Tipos que no se enseñan aquí (p. ej. «Por aprobar», que ya sale como tarjeta encima). */
  hiddenKinds?: ReadonlySet<string>;
}

/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar, como un
 * buzón. Arriba las abiertas; el dueño las resuelve de un toque (o con una
 * nota; las de dinero, siempre con nota) y tiene 10 s para deshacerlo (B11).
 * Las que se arreglan en otra pestaña (cobros atascados…) se quitan solas.
 * Debajo, lo resuelto hoy desde este dispositivo.
 */
export function IncidentsPanel({ isOwner, tabs, onNavigate, onOpenPayment, hiddenKinds }: Props) {
  const feed = useIncidents();
  const open = feed.open && hiddenKinds ? feed.open.filter((i) => !hiddenKinds.has(i.kind)) : feed.open;
  const openId = useId();
  const doneId = useId();
  const { refresh } = feed;
  const pendingUntil = new Map(feed.pending.map((p) => [p.key, p.until] as const));
  const openCount = open ? open.filter((i) => !pendingUntil.has(incidentKey(i))).length : null;

  // Al abrir la pestaña, lo último (la barra de abajo refresca cada 30 s).
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <h2 style={titleStyle}>Avisos</h2>

      {feed.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar los avisos: {feed.error}
          {open ? ' · se siguen enseñando las últimas.' : ''}
        </Notice>
      ) : null}

      <section aria-labelledby={openId} style={groupStyle} data-tour="avisos-abiertos">
        <h3 id={openId} className="np-inbox-head">
          Abiertas <span className="np-inbox-count">{openCount ?? '…'}</span>
        </h3>
        {open === null ? (
          feed.error ? null : <p style={hintStyle}>Cargando…</p>
        ) : open.length === 0 ? (
          <p className="np-inbox-empty">Todo en orden: no hay nada pendiente.</p>
        ) : (
          <ul className="np-inbox">
            {open.map((i) => {
              const key = incidentKey(i);
              const until = pendingUntil.get(key);
              return until !== undefined ? (
                <UndoItem key={key} incident={i} until={until} onUndo={() => feed.undo(key)} />
              ) : (
                <OpenItem
                  key={key}
                  incident={i}
                  isOwner={isOwner}
                  tabs={tabs}
                  onNavigate={onNavigate}
                  onOpenPayment={onOpenPayment}
                  failed={feed.failed[key] ?? null}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby={doneId} style={groupStyle} data-tour="avisos-resueltos">
        <h3 id={doneId} className="np-inbox-head">
          Resueltas hoy <span className="np-inbox-count">{feed.resolved.length}</span>
        </h3>
        {feed.resolved.length === 0 ? (
          <p className="np-inbox-empty">Aún nada hoy. Lo que se resuelva aparecerá aquí.</p>
        ) : (
          <ul className="np-inbox">
            {feed.resolved.map((r) => (
              <ResolvedItem key={r.key} item={r} />
            ))}
          </ul>
        )}
        <p style={hintSmall}>
          Lo resuelto hoy desde este dispositivo y lo que se quitó solo. El registro completo queda en la actividad.
        </p>
      </section>
    </section>
  );
}

function OpenItem({
  incident: i,
  isOwner,
  tabs,
  onNavigate,
  onOpenPayment,
  failed,
}: {
  incident: Incident;
  isOwner: boolean;
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  onOpenPayment: (paymentId: string) => void;
  /** No se pudo marcar como resuelta (el API contestó con este error). */
  failed: string | null;
}) {
  const tz = useVenueTimezone();
  const { resolve } = useIncidents();
  // Aviso de dinero (B11): se cierra escribiendo qué se hizo.
  const noteRequired = i.noteRequired === true;
  const [withNote, setWithNote] = useState(false);
  const [note, setNote] = useState('');
  const fixTab = fixTabFor(i.kind, tabs);
  const fixLabel = tabs.find((t) => t.key === fixTab)?.label;
  // Devolución sin confirmar: se resuelve en el propio cobro, no aquí.
  const paymentToOpen = kindMeta(i.kind).opensPayment && fixTab === 'payments' ? i.paymentId : null;
  const hint = incidentHint(i.kind, i.ackable);
  const noteOk = resolveNoteOk(noteRequired, note);

  // Pasa a «Deshacer» durante 10 s; después se manda (y sale de la lista).
  function run(text?: string): void {
    resolve(i, text?.trim() || undefined);
  }

  return (
    <li className="np-inbox-item" data-state="open">
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">{kindMeta(i.kind).group}</span>
        <span>{formatDateTime(i.occurredAt, tz, 'compact')}</span>
        {i.amountCents !== null ? <span className="np-num">{formatEur(i.amountCents)}</span> : null}
      </p>
      <h4 className="np-inbox-title">{incidentHeading(i)}</h4>
      <p className="np-inbox-detail">{i.detail}</p>

      {withNote ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={hintSmall}>
            {noteRequired
              ? 'Es un aviso de dinero: escribe qué has hecho para cerrarlo. Queda en el registro de actividad.'
              : 'Se quita de la bandeja (queda en el registro de actividad).'}
          </p>
          <Input
            label={noteRequired ? 'Qué has hecho' : 'Qué has hecho (opcional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="ej: devuelto en BBVA el 14/10"
            required={noteRequired}
            autoFocus
          />
          <div className="np-inbox-actions">
            <Button onClick={() => run(note)} disabled={!noteOk}>
              Marcar como resuelta
            </Button>
            <Button variant="ghost" onClick={() => setWithNote(false)}>
              Volver
            </Button>
          </div>
        </div>
      ) : (
        <div className="np-inbox-actions">
          {i.ackable && isOwner ? (
            noteRequired ? (
              <Button onClick={() => setWithNote(true)}>Resolver con nota…</Button>
            ) : (
              <>
                <Button onClick={() => run()}>Resolver</Button>
                <Button variant="ghost" onClick={() => setWithNote(true)}>
                  Con nota…
                </Button>
              </>
            )
          ) : null}
          {paymentToOpen ? (
            <Button variant="ghost" onClick={() => onOpenPayment(paymentToOpen)}>
              Abrir cobro
            </Button>
          ) : fixTab && fixLabel ? (
            <Button variant="ghost" onClick={() => onNavigate(fixTab)}>
              Ir a {fixLabel}
            </Button>
          ) : null}
          {i.ackable && !isOwner ? (
            <span style={hintSmall}>El dueño la marca como resuelta cuando esté hecha.</span>
          ) : null}
          {hint ? <span style={hintSmall}>{hint}</span> : null}
        </div>
      )}

      {failed ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          No se marcó como resuelta: {failed}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Recién marcada (B11): 10 s para deshacerlo antes de que se mande. Si el
 * foco se quedó sin sitio (el botón que se pulsó ya no está), va a «Deshacer».
 */
function UndoItem({ incident: i, until, onUndo }: { incident: Incident; until: number; onUndo: () => void }) {
  const now = useNow();
  const actions = useRef<HTMLDivElement>(null);
  // Lo que queda al aparecer: la barra se vacía sola en ese tiempo (CSS), sin repintar cada segundo.
  const [startMs] = useState(() => undoMsLeft(until, Date.now()));
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) actions.current?.querySelector('button')?.focus();
  }, []);
  return (
    <li className="np-inbox-item" data-state="undo">
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">Resuelta</span>
        <span>{kindMeta(i.kind).group}</span>
      </p>
      <h4 className="np-inbox-title">{incidentHeading(i)}</h4>
      <div className="np-inbox-actions" ref={actions}>
        <Button variant="ghost" onClick={onUndo}>
          Deshacer
        </Button>
        <span style={hintSmall}>Se quita de la bandeja en {undoSecondsLeft(until, now)} s.</span>
      </div>
      {/* La barra se vacía en 10 s. Con «reducir movimiento» no se anima: se queda donde toca y el texto cuenta los segundos. */}
      <div className="np-drain" aria-hidden="true">
        <i style={{ animationDuration: `${startMs}ms`, transform: `scaleX(${undoMsLeft(until, now) / UNDO_RESOLVE_MS})` }} />
      </div>
    </li>
  );
}

function ResolvedItem({ item }: { item: ResolvedIncident }) {
  const tz = useVenueTimezone();
  return (
    <li className="np-inbox-item" data-state="done">
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">Resuelta</span>
        <span>{formatDateTime(item.resolvedAt, tz, 'time')}</span>
        <span>· {item.how === 'ack' ? 'marcada aquí' : 'se quitó sola'}</span>
        <span>· {kindMeta(item.kind).group}</span>
      </p>
      <h4 className="np-inbox-title">{item.title}</h4>
      {item.note ? <p className="np-inbox-detail">«{item.note}»</p> : null}
    </li>
  );
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 600 };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '1rem' };
const hintSmall: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const groupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.625rem' };
