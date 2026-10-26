'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  fetchCurrentNight,
  fetchNight,
  fetchNights,
  openNight,
  type CobrosFilters,
  type NightAdjustments,
  type NightListItem,
  type NightSummary,
  type NightView,
} from '@/lib/api';
import { cobradoNote, zCobradoParts } from '@/lib/cobrado';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { diffLabel, parseCashInput } from '@/lib/night-close';
import type { PanelTab, TabKey } from '@/lib/roles';
import { useVenueTimezone } from '@/lib/venue-context';
import { Z_NET_LABEL, zNetLabel, zTypeLabel } from '@/lib/z-labels';
import { NightMoneyMap } from './money-map/NightMoneyMap';
import { NightCajaBlock } from './NightCajaBlock';
import { NightCloseScreen } from './NightCloseScreen';
import { Notice } from './Notice';

/**
 * Noche del local (Fase 1D). Se abre al empezar (con el fondo de caja) y se
 * cierra al terminar en pasos: cobros, datáfonos, saldo, arqueo de caja,
 * chicas e incidencias; al final se congela el informe Z con su caja. Si
 * nadie la cierra, se cierra sola a las 08:00 (con la caja sin contar).
 */
export function NightsPanel({
  tabs,
  onNavigate,
  isOwner,
  onOpenCobros,
}: {
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  isOwner: boolean;
  /** Desde el mapa del dinero de un Z: los cobros que explican una cifra. */
  onOpenCobros?: (filter: CobrosFilters) => void;
}) {
  const tz = useVenueTimezone();
  /** undefined = cargando; null = no hay noche abierta. */
  const [current, setCurrent] = useState<NightView | null | undefined>(undefined);
  const [history, setHistory] = useState<NightListItem[] | null>(null);
  const [detail, setDetail] = useState<NightView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** La pantalla de cierre en pasos está abierta. */
  const [closing, setClosing] = useState(false);
  /** Fondo de caja al abrir (opcional). */
  const [floatText, setFloatText] = useState('');
  const generation = useRef(0);

  const reload = useCallback(() => {
    const gen = ++generation.current;
    setLoadError(null);
    Promise.all([fetchCurrentNight(), fetchNights()])
      .then(([night, list]) => {
        if (gen !== generation.current) return;
        setCurrent(night);
        setHistory(list);
      })
      .catch((err: Error) => {
        if (gen === generation.current) setLoadError(err.message);
      });
  }, []);

  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setFloatText('');
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

  const time = (iso: string) => formatDateTime(iso, tz, 'time');
  const day = (iso: string) => formatDateTime(iso, tz, 'weekday');
  const float = parseCashInput(floatText);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={titleStyle}>Noches</h2>
        <p style={hintStyle}>
          Abre la noche al empezar y ciérrala al terminar: el cierre repasa lo pendiente, cuenta la caja y guarda el
          informe Z, que ya no cambia. Si nadie la cierra, se cierra sola a las 08:00.
        </p>
      </div>

      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudieron cargar las noches: {loadError}
        </Notice>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {current === undefined ? (
        loadError ? null : <p style={hintStyle}>Cargando…</p>
      ) : current === null ? (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>No hay ninguna noche abierta.</p>
          <Input
            label="Fondo de caja (opcional)"
            value={floatText}
            onChange={(e) => setFloatText(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            maxLength={12}
            error={float === null ? 'Escribe un importe, p. ej. 150 o 150,50.' : undefined}
            hint="El efectivo con el que empieza la caja. Si no lo pones ahora, se pide al cerrar si hay efectivo."
          />
          <Button
            loading={busy}
            disabled={float === null}
            onClick={() => void run(() => openNight(typeof float === 'number' ? { openingFloatCents: float } : {}))}
            // Del ancho del texto, como siempre (la tarjeta en columna estiraría el botón).
            style={{ alignSelf: 'flex-start' }}
          >
            Abrir noche
          </Button>
        </Card>
      ) : (
        <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={rowStyle}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '1.125rem' }}>
              Noche abierta desde las {time(current.openedAt)}
            </p>
            <span style={liveStyle}>En vivo</span>
          </div>
          {typeof current.openingFloatCents === 'number' ? (
            <p style={hintSmall}>Fondo de caja: {formatEur(current.openingFloatCents)}</p>
          ) : null}
          <ZSummary summary={current.z.summary} />
          <AdjustmentsBox adjustments={current.z.adjustments} />
          {current.pending.length > 0 ? (
            <div style={pendingBox}>
              <p style={{ margin: 0, fontWeight: 700 }}>
                {current.pending.length === 1 ? '1 cobro sin resolver' : `${current.pending.length} cobros sin resolver`}:
                resuélvelos en Pagos antes de cerrar.
              </p>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
                {current.pending.slice(0, 8).map((p) => (
                  <li key={p.id} className="np-num">
                    {time(p.createdAt)} · {formatEur(p.amountCents)} · {pendingLabel(p)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button onClick={() => setClosing(true)}>Cerrar noche</Button>
          </div>
        </Card>
      )}

      <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Noche</th>
                <th>Horario</th>
                <th style={numHead}>Pagos con tarjeta</th>
                <th style={numHead}>Cobrado</th>
                <th style={numHead}>{Z_NET_LABEL}</th>
                <th>Cierre</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {(history ?? []).map((n) => (
                <tr key={n.id}>
                  <td data-label="Noche" data-card="title">
                    {day(n.openedAt)}
                  </td>
                  <td data-label="Horario" data-card="top" className="np-num">
                    {time(n.openedAt)}–{n.closedAt ? time(n.closedAt) : '…'}
                  </td>
                  <td data-label="Pagos con tarjeta" style={numTd}>
                    {n.count ?? '—'}
                  </td>
                  <td data-label="Cobrado" data-card="amount" style={numTd}>
                    {n.chargedCents === null ? '—' : formatEur(n.chargedCents)}
                  </td>
                  <td data-label={Z_NET_LABEL} style={numTd}>
                    {n.netCents === null ? '—' : formatEur(n.netCents)}
                  </td>
                  <td data-label="Cierre">
                    {n.closedAt === null ? 'Abierta' : n.autoClosed ? 'Sola a las 08:00' : 'Cerrada'}
                    {n.pendingAtClose > 0 ? ` · ${n.pendingAtClose} pendientes` : ''}
                    {n.cashDiffCents ? ` · caja: ${diffLabel(n.cashDiffCents).toLowerCase()}` : ''}
                  </td>
                  <td data-label="Acciones" data-card="actions" style={{ textAlign: 'right' }}>
                    <Button variant="ghost" style={smallBtn} onClick={() => void showNight(n.id)}>
                      Ver Z
                    </Button>
                  </td>
                </tr>
              ))}
              {history === null || history.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--np-text-mute)' }}>
                    {history === null ? (loadError ? 'Sin datos.' : 'Cargando…') : 'Aún no hay noches.'}
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
        title={detail ? `Informe Z · ${day(detail.openedAt)}` : undefined}
        width="44rem"
      >
        {detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p style={hintStyle}>
              {time(detail.openedAt)} – {detail.closedAt ? time(detail.closedAt) : 'en curso'}
              {detail.autoClosed ? ' · cerrada sola a las 08:00' : ''}
              {detail.pendingAtClose > 0 ? ` · ${detail.pendingAtClose} cobros sin resolver al cerrar` : ''}
              {detail.closeNote ? ` · «${detail.closeNote}»` : ''}
            </p>
            {detail.closedAt ? <NightMoneyMap nightId={detail.id} onOpenCobros={onOpenCobros} /> : null}
            {detail.z.caja ? <NightCajaBlock caja={detail.z.caja} /> : null}
            <ZSummary summary={detail.z.summary} />
            <AdjustmentsBox adjustments={detail.z.adjustments} />
          </div>
        ) : null}
      </Modal>

      {closing && current ? (
        <NightCloseScreen
          night={current}
          isOwner={isOwner}
          tabs={tabs}
          onNavigate={onNavigate}
          onClose={() => {
            setClosing(false);
            reload();
          }}
          onClosed={() => {
            setClosing(false);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

/** Totales de la noche, por tipo y por chica. */
function ZSummary({ summary: s }: { summary: NightSummary }) {
  const totals: Array<[string, number]> = [
    ['Cobrado', s.chargedCents],
    ['Propinas', s.tipsCents],
    ['Devoluciones', -s.refundsCents],
    // API nuevo: el saldo devuelto en efectivo resta del neto (los Z antiguos no lo traen).
    ...(s.walletCashPayoutsCents ? ([['Saldo devuelto en efectivo', -s.walletCashPayoutsCents]] as Array<[string, number]>) : []),
    // Lo cobrado menos lo devuelto; no es el «Neto sin el personal» de abajo (ni el del resumen de las 9:00).
    [Z_NET_LABEL, s.netCents],
    ['Para las chicas', s.chicaNetCents],
    // Solo si el local da parte a los camareros de las copas con invitación (de fábrica, nada).
    ...(s.camareroNetCents ? ([['Para los camareros', s.camareroNetCents]] as Array<[string, number]>) : []),
    // No es «Para el local» del mapa (el reparto de lo vendido): lleva las recargas y no resta comisiones.
    [zNetLabel(s), s.venueNetCents],
  ];
  const charged = cobradoNote(zCobradoParts(s), formatEur);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={totalsGrid}>
        {totals.map(([label, cents]) => (
          <div key={label} style={totalBox}>
            <span style={hintSmall}>{label}</span>
            <span className="np-num" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
              {formatEur(cents)}
            </span>
          </div>
        ))}
      </div>
      {charged ? (
        <p style={hintSmall}>
          Cobrado = {charged}. Las recargas son saldo de los clientes, no ventas, y aquí no se restan comisiones: lo
          que le toca al local de lo vendido es «Para el local» del mapa del dinero.
        </p>
      ) : null}
      <p style={hintSmall}>
        {s.count} pagos con tarjeta
        {s.byType.length > 0 ? ' · ' : ''}
        {s.byType.map((t) => `${zTypeLabel(t.label)}: ${t.count} (${formatEur(t.chargedCents)})`).join(' · ')}
      </p>
      <SaldoLine summary={s} />
      {s.perChica.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Chica</th>
                <th style={numHead}>Cobros</th>
                <th style={numHead}>Cobrado</th>
                <th style={numHead}>Comisión</th>
                <th style={numHead}>Propinas</th>
                <th style={numHead}>Para ella</th>
              </tr>
            </thead>
            <tbody>
              {s.perChica.map((c) => (
                <tr key={c.name}>
                  <td data-label="Chica" data-card="title">
                    {c.name}
                  </td>
                  <td data-label="Cobros" style={numTd}>
                    {c.count}
                  </td>
                  <td data-label="Cobrado" style={numTd}>
                    {formatEur(c.chargedCents)}
                  </td>
                  <td data-label="Comisión" style={numTd}>
                    {formatEur(c.commissionCents)}
                  </td>
                  <td data-label="Propinas" style={numTd}>
                    {formatEur(c.tipsCents)}
                  </td>
                  <td data-label="Para ella" data-card="amount" style={{ ...numTd, fontWeight: 700 }}>
                    {formatEur(c.netCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Consumos del saldo y saldo devuelto (API nuevo; los Z congelados antes no los traen). */
function SaldoLine({ summary: s }: { summary: NightSummary }) {
  const parts: string[] = [];
  if (s.consumptionsCount) {
    const byType = (s.saldoByType ?? []).map((t) => `${t.label}: ${t.count} (${formatEur(t.chargedCents)})`);
    parts.push(
      `Consumos del saldo: ${s.consumptionsCount} (${formatEur(s.consumptionsCents ?? 0)})${
        byType.length > 0 ? ` · ${byType.join(' · ')}` : ''
      }`,
    );
  }
  if (s.walletCardPayoutsCents) {
    parts.push(`Saldo devuelto a la tarjeta: ${formatEur(s.walletCardPayoutsCents)} (ya está en devoluciones)`);
  }
  if (parts.length === 0) return null;
  return <p style={hintSmall}>{parts.join(' · ')}</p>;
}

/**
 * Ajustes de noches anteriores: lo apuntado tarde con fecha de una noche ya
 * cerrada (cobro confirmado tarde, devolución con fecha del banco, consumo
 * anulado). Esos Z no cambian: los ajustes van en el siguiente.
 */
function AdjustmentsBox({ adjustments: a }: { adjustments?: NightAdjustments }) {
  if (!a || a.count === 0) return null;
  const s = a.summary;
  const totals: Array<[string, number]> = [
    ['Cobrado', s.chargedCents],
    ['Devoluciones', -s.refundsCents],
    [Z_NET_LABEL, s.netCents],
    ['Para las chicas', s.chicaNetCents],
    ...(s.camareroNetCents ? ([['Para los camareros', s.camareroNetCents]] as Array<[string, number]>) : []),
    [zNetLabel(s), s.venueNetCents],
  ];
  return (
    <div style={adjustBox}>
      <p style={{ margin: 0, fontWeight: 700 }}>Ajustes de noches anteriores ({a.count})</p>
      <p style={hintSmall}>
        Apuntado después con fecha de noches ya cerradas: cobros que el banco confirmó tarde, devoluciones con la
        fecha del banco o consumos anulados. Aquellos Z no cambian; van aquí.
      </p>
      <div style={totalsGrid}>
        {totals.map(([label, cents]) => (
          <div key={label} style={totalBox}>
            <span style={hintSmall}>{label}</span>
            <span className="np-num" style={{ fontWeight: 700 }}>
              {formatEur(cents)}
            </span>
          </div>
        ))}
      </div>
      {a.reversedConsumptionsCount > 0 ? (
        <p style={hintSmall}>
          Consumos del saldo anulados: {a.reversedConsumptionsCount} ({formatEur(a.reversedConsumptionsCents)}); la
          parte de las chicas que se descuenta: {formatEur(a.reversedConsumptionsChicaCents)}.
        </p>
      ) : null}
    </div>
  );
}

function pendingLabel(p: NightView['pending'][number]): string {
  if (p.captureMethod === 'POS_EXTERNAL') return 'datáfono sin confirmar';
  if (p.status === 'ORPHAN') return 'el banco no lo confirmó: búscalo en BBVA';
  return 'esperando al banco';
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
  // «En vivo» es un estado: en verde (el lima es para la acción y el «pagado»).
  color: 'var(--np-success)',
};
const pendingBox: CSSProperties = {
  border: '2px solid var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem 1rem',
  color: 'var(--np-warning)',
  fontSize: '0.9375rem',
};
const adjustBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
  padding: '0.875rem 1rem',
  border: '1px dashed var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
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
const numHead: CSSProperties = { textAlign: 'right' };
const numTd: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const smallBtn: CSSProperties = { height: '2.25rem', padding: '0 0.875rem', fontSize: '0.8125rem' };
