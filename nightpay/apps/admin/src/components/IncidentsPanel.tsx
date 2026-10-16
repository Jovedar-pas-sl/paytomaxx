'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { sendTelegramTest, type Incident } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { fixTabFor, incidentHeading, incidentKey, kindMeta, type ResolvedIncident } from '@/lib/incident-inbox';
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
}

/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar, como un
 * buzón. Arriba las abiertas; el dueño las resuelve de un toque (o con una
 * nota). Las que se arreglan en otra pestaña (cobros atascados…) se quitan
 * solas. Debajo, lo resuelto hoy desde este dispositivo.
 */
export function IncidentsPanel({ isOwner, tabs, onNavigate, onOpenPayment }: Props) {
  const feed = useIncidents();
  const openId = useId();
  const doneId = useId();
  const { refresh } = feed;

  // Al abrir la pestaña, lo último (la barra de abajo refresca cada 30 s).
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h2 style={titleStyle}>Incidencias</h2>
        <p style={hintStyle}>
          Lo que hay que mirar: cobros atascados, dobles cobros, descuentos que fallaron y noches cerradas con
          pendientes.
        </p>
      </div>

      {feed.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar las incidencias: {feed.error}
          {feed.open ? ' · se siguen enseñando las últimas.' : ''}
        </Notice>
      ) : null}

      <section aria-labelledby={openId} style={groupStyle}>
        <h3 id={openId} className="np-inbox-head">
          Abiertas <span className="np-inbox-count">{feed.open ? feed.open.length : '…'}</span>
        </h3>
        {feed.open === null ? (
          feed.error ? null : <p style={hintStyle}>Cargando…</p>
        ) : feed.open.length === 0 ? (
          <p className="np-inbox-empty">Todo en orden: no hay nada pendiente.</p>
        ) : (
          <ul className="np-inbox">
            {feed.open.map((i) => (
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

      <TelegramCard enabled={feed.telegram} isOwner={isOwner} />
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
            <Button loading={busy} style={smallBtn} onClick={() => void run(note)}>
              Marcar como resuelta
            </Button>
            <Button variant="ghost" style={smallBtn} onClick={() => setWithNote(false)} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="np-inbox-actions">
          {i.ackable && isOwner ? (
            <>
              <Button loading={busy} style={smallBtn} onClick={() => void run()}>
                Resolver
              </Button>
              <Button variant="ghost" style={smallBtn} onClick={() => setWithNote(true)} disabled={busy}>
                Con nota…
              </Button>
            </>
          ) : null}
          {paymentToOpen ? (
            <Button variant="ghost" style={smallBtn} onClick={() => onOpenPayment(paymentToOpen)}>
              Abrir cobro
            </Button>
          ) : fixTab && fixLabel ? (
            <Button variant="ghost" style={smallBtn} onClick={() => onNavigate(fixTab)}>
              Ir a {fixLabel}
            </Button>
          ) : null}
          {i.ackable && !isOwner ? (
            <span style={hintSmall}>El dueño la marca como resuelta cuando esté hecha.</span>
          ) : null}
          {!i.ackable ? (
            <span style={hintSmall}>
              {kindMeta(i.kind).opensPayment
                ? 'En el cobro: Devoluciones → Resolver. Se quita sola al resolverla.'
                : 'Se quita sola cuando se arregla.'}
            </span>
          ) : null}
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

function TelegramCard({ enabled, isOwner }: { enabled: boolean; isOwner: boolean }) {
  const [testResult, setTestResult] = useState<string | null>(null);

  async function testTelegram() {
    setTestResult(null);
    try {
      const sent = await sendTelegramTest();
      setTestResult(
        sent ? 'Enviado: mira tu Telegram.' : 'No llegó. Revisa en Dokploy el token del bot y el número del chat.',
      );
    } catch (err) {
      setTestResult((err as Error).message);
    }
  }

  return (
    <Card style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Alertas por Telegram: {enabled ? 'activadas' : 'desactivadas'}</p>
      <p style={hintSmall}>
        {enabled
          ? 'Cada incidencia nueva te llega una vez, y a las 9:00 el resumen de la noche de cada local. Un solo chat para todos tus locales.'
          : 'Para activarlas, añade TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Dokploy (nightpay-api → Environment) y vuelve a desplegar.'}
      </p>
      {enabled && isOwner ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Button variant="ghost" style={smallBtn} onClick={() => void testTelegram()}>
            Enviar mensaje de prueba
          </Button>
          {testResult ? <span style={hintSmall}>{testResult}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 700 };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const hintSmall: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const groupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.625rem' };
const smallBtn: CSSProperties = { height: '2.75rem', padding: '0 1.125rem', fontSize: '0.9375rem' };
