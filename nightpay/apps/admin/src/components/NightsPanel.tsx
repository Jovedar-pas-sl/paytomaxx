'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  closeNight,
  fetchCurrentNight,
  fetchNight,
  fetchNights,
  openNight,
  type NightListItem,
  type NightSummary,
  type NightView,
} from '@/lib/api';

/**
 * Noche del local (Fase 1D). Se abre al empezar y se cierra al terminar: el
 * cierre congela el informe Z (totales, por tipo y por chica). No se cierra
 * con cobros sin resolver; si nadie la cierra, se cierra sola a las 08:00.
 */
export function NightsPanel({ isOwner }: { isOwner: boolean }) {
  const [current, setCurrent] = useState<NightView | null | undefined>(undefined);
  const [history, setHistory] = useState<NightListItem[]>([]);
  const [detail, setDetail] = useState<NightView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forcing, setForcing] = useState(false);
  const [note, setNote] = useState('');

  const reload = useCallback(() => {
    Promise.all([fetchCurrentNight(), fetchNights()])
      .then(([night, list]) => {
        setCurrent(night);
        setHistory(list);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setForcing(false);
      setNote('');
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function showNight(id: string) {
    setError(null);
    try {
      setDetail(await fetchNight(id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={titleStyle}>Noches</h2>
        <p style={hintStyle}>
          Abre la noche al empezar y ciérrala al terminar: el cierre guarda el informe Z y ya no cambia. Si nadie la
          cierra, se cierra sola a las 08:00.
        </p>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {current === undefined ? (
        <p style={hintStyle}>Cargando…</p>
      ) : current === null ? (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>No hay ninguna noche abierta.</p>
          <Button loading={busy} onClick={() => void run(openNight)}>
            Abrir noche
          </Button>
        </Card>
      ) : (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={rowStyle}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '1.125rem' }}>
              Noche abierta desde las {formatTime(current.openedAt)}
            </p>
            <span style={liveStyle}>En vivo</span>
          </div>
          <ZSummary summary={current.z.summary} />
          {current.pending.length > 0 ? (
            <div style={pendingBox}>
              <p style={{ margin: 0, fontWeight: 700 }}>
                {current.pending.length === 1 ? '1 cobro sin resolver' : `${current.pending.length} cobros sin resolver`}:
                resuélvelos en Pagos antes de cerrar.
                {isOwner ? '' : ' Solo el dueño puede cerrar con cobros pendientes.'}
              </p>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
                {current.pending.slice(0, 8).map((p) => (
                  <li key={p.id} className="np-num">
                    {formatTime(p.createdAt)} · {eur(p.amountCents)} · {pendingLabel(p)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {forcing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Input
                label="Por qué cierras con cobros sin resolver"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                placeholder="ej: BBVA lo confirma mañana"
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <Button
                  loading={busy}
                  onClick={() => void run(() => closeNight(current.id, { force: true, note }))}
                >
                  Cerrar igualmente
                </Button>
                <Button variant="ghost" onClick={() => setForcing(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button loading={busy} onClick={() => void run(() => closeNight(current.id, {}))}>
                Cerrar noche
              </Button>
              {isOwner && current.pending.length > 0 ? (
                <Button variant="ghost" onClick={() => setForcing(true)}>
                  Cerrar con pendientes…
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      )}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Noche</th>
                <th style={thStyle}>Horario</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cobros</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cobrado</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Neto</th>
                <th style={thStyle}>Cierre</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {history.map((n) => (
                <tr key={n.id}>
                  <td style={tdStyle}>{formatDay(n.openedAt)}</td>
                  <td style={tdStyle} className="np-num">
                    {formatTime(n.openedAt)}–{n.closedAt ? formatTime(n.closedAt) : '…'}
                  </td>
                  <td style={numTd}>{n.count ?? '—'}</td>
                  <td style={numTd}>{n.chargedCents === null ? '—' : eur(n.chargedCents)}</td>
                  <td style={numTd}>{n.netCents === null ? '—' : eur(n.netCents)}</td>
                  <td style={tdStyle}>
                    {n.closedAt === null
                      ? 'Abierta'
                      : n.autoClosed
                        ? 'Sola a las 08:00'
                        : 'Cerrada'}
                    {n.pendingAtClose > 0 ? ` · ${n.pendingAtClose} pendientes` : ''}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <Button variant="ghost" style={smallBtn} onClick={() => void showNight(n.id)}>
                      Ver Z
                    </Button>
                  </td>
                </tr>
              ))}
              {history.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: 'var(--np-text-mute)' }}>
                    Aún no hay noches.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `Informe Z · ${formatDay(detail.openedAt)}` : undefined}
        width="44rem"
      >
        {detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={hintStyle}>
              {formatTime(detail.openedAt)} – {detail.closedAt ? formatTime(detail.closedAt) : 'en curso'}
              {detail.autoClosed ? ' · cerrada sola a las 08:00' : ''}
              {detail.pendingAtClose > 0 ? ` · ${detail.pendingAtClose} cobros sin resolver al cerrar` : ''}
              {detail.closeNote ? ` · «${detail.closeNote}»` : ''}
            </p>
            <ZSummary summary={detail.z.summary} />
          </div>
        ) : null}
      </Modal>
    </section>
  );
}

/** Totales de la noche, por tipo y por chica. */
function ZSummary({ summary: s }: { summary: NightSummary }) {
  const totals: Array<[string, number]> = [
    ['Cobrado', s.chargedCents],
    ['Propinas', s.tipsCents],
    ['Devoluciones', -s.refundsCents],
    ['Neto', s.netCents],
    ['Para las chicas', s.chicaNetCents],
    ['Para el local', s.venueNetCents],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={totalsGrid}>
        {totals.map(([label, cents]) => (
          <div key={label} style={totalBox}>
            <span style={hintSmall}>{label}</span>
            <span className="np-num" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {eur(cents)}
            </span>
          </div>
        ))}
      </div>
      <p style={hintSmall}>
        {s.count} cobros
        {s.byType.length > 0 ? ' · ' : ''}
        {s.byType.map((t) => `${t.label}: ${t.count} (${eur(t.chargedCents)})`).join(' · ')}
      </p>
      {s.perChica.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Chica</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cobros</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cobrado</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Comisión</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Propinas</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Para ella</th>
              </tr>
            </thead>
            <tbody>
              {s.perChica.map((c) => (
                <tr key={c.name}>
                  <td style={tdStyle}>{c.name}</td>
                  <td style={numTd}>{c.count}</td>
                  <td style={numTd}>{eur(c.chargedCents)}</td>
                  <td style={numTd}>{eur(c.commissionCents)}</td>
                  <td style={numTd}>{eur(c.tipsCents)}</td>
                  <td style={{ ...numTd, fontWeight: 700 }}>{eur(c.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

function pendingLabel(p: NightView['pending'][number]): string {
  if (p.captureMethod === 'POS_EXTERNAL') return 'datáfono sin confirmar';
  if (p.status === 'ORPHAN') return 'el banco no lo confirmó: búscalo en BBVA';
  return 'esperando al banco';
}

// Horas de Madrid: la noche se cierra sola a las 08:00 de allí, se mire desde donde se mire.
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 700 };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const hintSmall: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' };
const liveStyle: CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--np-accent)',
};
const pendingBox: CSSProperties = {
  border: '2px solid var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem 1rem',
  color: 'var(--np-warning)',
  fontSize: '0.9375rem',
};
const totalsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
  gap: '0.5rem',
};
const totalBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0.625rem 0.875rem',
  fontSize: '0.75rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
  borderBottom: '1px solid var(--np-border)',
};
const tdStyle: CSSProperties = { padding: '0.625rem 0.875rem', borderBottom: '1px solid var(--np-border)' };
const numTd: CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const smallBtn: CSSProperties = { height: '2.25rem', padding: '0 0.875rem', fontSize: '0.8125rem' };
