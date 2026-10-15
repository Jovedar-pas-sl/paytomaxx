'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { ackIncident, fetchIncidents, sendTelegramTest, type Incident } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';

/**
 * Bandeja de incidencias (Fase 1E): lo que el dueño tiene que mirar. Los
 * cobros atascados desaparecen solos al resolverlos en Pagos; el resto se
 * marca como revisado (con nota) cuando ya está hecho.
 */
export function IncidentsPanel({ isOwner }: { isOwner: boolean }) {
  const tz = useVenueTimezone();
  const [items, setItems] = useState<Incident[] | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    fetchIncidents()
      .then((r) => {
        setItems(r.items);
        setTelegram(r.telegram);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function confirmAck(i: Incident) {
    setBusy(true);
    setError(null);
    try {
      await ackIncident({ kind: i.kind, refId: i.refId, ...(note.trim() ? { note: note.trim() } : {}) });
      setAcking(null);
      setNote('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={titleStyle}>Incidencias</h2>
        <p style={hintStyle}>
          Lo que hay que mirar: cobros atascados, dobles cobros, descuentos que fallaron y noches cerradas con
          pendientes.
        </p>
      </div>

      <Card style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>
          Alertas por Telegram: {telegram ? 'activadas' : 'desactivadas'}
        </p>
        <p style={hintSmall}>
          {telegram
            ? 'Cada incidencia nueva te llega una vez, y a las 9:00 el resumen de la noche de cada local. Un solo chat para todos tus locales.'
            : 'Para activarlas, añade TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Dokploy (nightpay-api → Environment) y vuelve a desplegar.'}
        </p>
        {telegram && isOwner ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Button variant="ghost" style={smallBtn} onClick={() => void testTelegram()}>
              Enviar mensaje de prueba
            </Button>
            {testResult ? <span style={hintSmall}>{testResult}</span> : null}
          </div>
        ) : null}
      </Card>

      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudieron cargar las incidencias: {loadError}
        </Notice>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {items === null ? (
        loadError ? null : <p style={hintStyle}>Cargando…</p>
      ) : items.length === 0 ? (
        <Card style={{ padding: '1.25rem' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Todo en orden: no hay nada pendiente.</p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {items.map((i) => {
            const key = `${i.kind}:${i.refId}`;
            return (
              <Card key={key} style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={rowStyle}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>{i.title}</p>
                  <span style={hintSmall}>{formatDateTime(i.occurredAt, tz, 'compact')}</span>
                </div>
                <p style={{ margin: 0 }}>{i.detail}</p>
                {i.ackable && !isOwner ? (
                  <p style={hintSmall}>El dueño la marca como revisada cuando esté resuelta.</p>
                ) : null}
                {i.ackable && isOwner ? (
                  acking === key ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <p style={hintSmall}>Se quita de la bandeja (queda en el registro de actividad).</p>
                      <Input
                        label="Qué has hecho (opcional)"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={300}
                        placeholder="ej: devuelto en BBVA el 14/10"
                      />
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <Button loading={busy} style={smallBtn} onClick={() => void confirmAck(i)}>
                          Marcar como revisada
                        </Button>
                        <Button variant="ghost" style={smallBtn} onClick={() => setAcking(null)}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <Button
                        variant="ghost"
                        style={smallBtn}
                        onClick={() => {
                          setAcking(key);
                          setNote('');
                        }}
                      >
                        Ya está revisada
                      </Button>
                    </div>
                  )
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 700 };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const hintSmall: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
};
const smallBtn: CSSProperties = { height: '2.5rem', padding: '0 1rem', fontSize: '0.875rem' };
