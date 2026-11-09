'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { Incident } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { fixTabFor, incidentHeading, incidentHint, incidentKey, kindMeta, type ResolvedIncident } from '@/lib/incident-inbox';
import { formatEur } from '@/lib/money';
import type { PanelTab, TabKey } from '@/lib/roles';
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
 * nota). Las que se arreglan en otra pestaña (cobros atascados…) se quitan
 * solas. Debajo, lo resuelto hoy desde este dispositivo.
 */
export function IncidentsPanel({ isOwner, tabs, onNavigate, onOpenPayment, hiddenKinds }: Props) {
  const feed = useIncidents();
  const open = feed.open && hiddenKinds ? feed.open.filter((i) => !hiddenKinds.has(i.kind)) : feed.open;
  const openId = useId();
  const doneId = useId();
  const { refresh } = feed;

  // Al abrir la pestaña, lo último (la barra de abajo refresca cada 30 s).
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <h2 style={titleStyle}>Incidencias</h2>

      {feed.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar las incidencias: {feed.error}
          {open ? ' · se siguen enseñando las últimas.' : ''}
        </Notice>
      ) : null}

      <section aria-labelledby={openId} style={groupStyle}>
        <h3 id={openId} className="np-inbox-head">
          Abiertas <span className="np-inbox-count">{open ? open.length : '…'}</span>
        </h3>
        {open === null ? (
          feed.error ? null : <p style={hintStyle}>Cargando…</p>
        ) : open.length === 0 ? (
          <p className="np-inbox-empty">Todo en orden: no hay nada pendiente.</p>
        ) : (
          <ul className="np-inbox">
            {open.map((i) => (
              <OpenItem
                key={incidentKey(i)}
                incident={i}
                isOwner={isOwner}
                tabs={tabs}
                onNavigate={onNavigate}
                onOpenPayment={onOpenPayment}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={doneId} style={groupStyle}>
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
}: {
  incident: Incident;
  isOwner: boolean;
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  onOpenPayment: (paymentId: string) => void;
}) {
  const tz = useVenueTimezone();
  const { resolve } = useIncidents();
  const [withNote, setWithNote] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fixTab = fixTabFor(i.kind, tabs);
  const fixLabel = tabs.find((t) => t.key === fixTab)?.label;
  // Devolución sin confirmar: se resuelve en el propio cobro, no aquí.
  const paymentToOpen = kindMeta(i.kind).opensPayment && fixTab === 'payments' ? i.paymentId : null;
  const hint = incidentHint(i.kind, i.ackable);

  async function run(text?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Si va bien, la incidencia sale de la lista (y este componente se desmonta).
      await resolve(i, text?.trim() || undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
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
          <p style={hintSmall}>Se quita de la bandeja (queda en el registro de actividad).</p>
          <Input
            label="Qué has hecho (opcional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="ej: devuelto en BBVA el 14/10"
          />
          <div className="np-inbox-actions">
            <Button loading={busy} onClick={() => void run(note)}>
              Marcar como resuelta
            </Button>
            <Button variant="ghost" onClick={() => setWithNote(false)} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="np-inbox-actions">
          {i.ackable && isOwner ? (
            <>
              <Button loading={busy} onClick={() => void run()}>
                Resolver
              </Button>
              <Button variant="ghost" onClick={() => setWithNote(true)} disabled={busy}>
                Con nota…
              </Button>
            </>
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

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
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
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const hintSmall: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const groupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.625rem' };
