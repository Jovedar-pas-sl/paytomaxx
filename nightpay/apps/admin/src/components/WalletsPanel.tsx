'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card, Select } from '@nightpay/ui';
import {
  blockWalletCard,
  fetchWalletsList,
  fetchWalletsStats,
  resetWalletPin,
  unlockWalletPin,
  type WalletAdminRow,
  type WalletsAdminStats,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { sectionPaint } from '@/lib/money-map-view';
import { usePolling } from '@/lib/use-polling';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { useFichas } from './fichas/fichas-context';
import { SectionChip } from './fichas/SectionChip';
import { Notice } from './Notice';
import { PendingTopUps } from './PendingTopUps';
import { Pill, type Tone } from './Pill';
import { RecentCashTopUps } from './RecentCashTopUps';
import { ChargeWithoutFaceIdModal, CodeSearch, PayoutModal, RelinkModal, type PayoutTarget } from './WalletModals';

const POLL_MS = 15_000;
/** Tope de `limit` en GET /v1/admin/wallets (no pagina: para otras, el buscador por código). */
const WALLETS_LIMIT = 200;

const STATUS_FILTERS: Array<{ value: '' | WalletAdminRow['status']; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'ACTIVE', label: 'Activas' },
  { value: 'DEPLETED', label: 'Agotadas' },
  { value: 'REFUNDED', label: 'Reembolsadas' },
  { value: 'EXPIRED', label: 'Expiradas' },
];

const STATUS_BADGES: Record<WalletAdminRow['status'], { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Activa', tone: 'success' },
  DEPLETED: { label: 'Agotada', tone: 'neutral' },
  REFUNDED: { label: 'Reembolsada', tone: 'info' },
  EXPIRED: { label: 'Expirada', tone: 'danger' },
};

interface Props {
  isOwner: boolean;
}

/**
 * Saldos de clientes. Un fallo al refrescar ya no sustituye el panel entero
 * por una tarjeta roja: se avisa encima y se siguen viendo los últimos datos,
 * y los modales abiertos (p. ej. el QR de un enlace nuevo) no desaparecen.
 */
export function WalletsPanel({ isOwner }: Props) {
  const tz = useVenueTimezone();
  const fichas = useFichas();
  const { sections } = useSections();
  const [stats, setStats] = useState<WalletsAdminStats | null>(null);
  /** null = cargando la lista de este filtro. */
  const [rows, setRows] = useState<WalletAdminRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | WalletAdminRow['status']>('ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [payoutFor, setPayoutFor] = useState<PayoutTarget | null>(null);
  const [relinkFor, setRelinkFor] = useState<PayoutTarget | null>(null);
  const [chargeFor, setChargeFor] = useState<PayoutTarget | null>(null);

  const reload = usePolling(
    async (signal) => {
      try {
        const [s, list] = await Promise.all([
          fetchWalletsStats(),
          fetchWalletsList({ status: statusFilter === '' ? undefined : statusFilter, limit: WALLETS_LIMIT }),
        ]);
        if (signal.aborted) return true;
        setStats((prev) => keepIfSame(prev, s));
        setRows((prev) => keepIfSame(prev, list));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS },
    [statusFilter],
  );

  function changeFilter(value: '' | WalletAdminRow['status']): void {
    setRows(null);
    setStatusFilter(value);
  }

  async function runAction(question: string, action: () => Promise<void>): Promise<void> {
    if (!window.confirm(question)) return;
    setActionError(null);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  function blockCard(w: WalletAdminRow) {
    void runAction(
      `¿Bloquear la ficha de ${w.code ?? 'este saldo'}? Ya no servirá para pagar (el saldo sigue).`,
      () => blockWalletCard(w.id),
    );
  }

  function pinAction(w: WalletAdminRow, kind: 'unlock' | 'reset') {
    void runAction(
      kind === 'unlock'
        ? `¿Desbloquear el PIN de ${w.code ?? 'este saldo'}? Comprueba antes que el cliente está delante.`
        : `¿Borrar el PIN de ${w.code ?? 'este saldo'}? El cliente elegirá uno nuevo contigo.`,
      () => (kind === 'unlock' ? unlockWalletPin(w.id) : resetWalletPin(w.id)),
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          {error}
          {stats ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}

      {stats ? (
        <>
          <section style={tilesGrid}>
            <Tile
              title="Saldos activos"
              value={String(stats.activeCount)}
              subtitle={`${formatEur(stats.totalBalanceCents)} en total`}
            />
            <Tile title="Recargas hoy" value={formatEur(stats.todayTopUpsCents)} />
            <Tile title="Consumido hoy" value={formatEur(stats.todayConsumptionsCents)} />
            <Tile title="Reembolsos hoy" value={formatEur(stats.todayRefundsCents)} />
          </section>

          {Object.keys(stats.byCategory).length > 0 ? (
            <Card style={{ padding: '1rem' }}>
              <h3 style={sectionTitle}>Consumos por sección (hoy)</h3>
              <ul style={categoryList}>
                {/* Con el nombre y el color de cada sección en este local (nunca «CHICA_SERVICE»); la suma, por código. */}
                {Object.entries(stats.byCategory).map(([cat, cents]) => {
                  const paint = sectionPaint(sections, cat);
                  return (
                    <li key={cat} style={categoryItem}>
                      <SectionChip view={{ label: paint.label, color: paint.color, title: null }} />
                      <span className="np-num" style={{ fontWeight: 600 }}>
                        {formatEur(cents)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </>
      ) : error ? null : (
        <p style={loadingStyle}>Cargando saldos…</p>
      )}

      <CodeSearch onFound={setPayoutFor} />

      <PendingTopUps />

      <RecentCashTopUps />

      <Card className="np-table-host" style={{ padding: '1rem' }}>
        <div style={listHeader}>
          <h3 style={sectionTitle}>Lista de saldos</h3>
          <Select
            aria-label="Filtrar por estado"
            value={statusFilter}
            onChange={(e) => changeFilter(e.target.value as '' | WalletAdminRow['status'])}
            style={{ width: '12rem' }}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>

        {rows === null ? (
          <p style={mutedText}>{error ? 'No se pudo cargar la lista.' : 'Cargando…'}</p>
        ) : rows.length === 0 ? (
          <p style={mutedText}>Sin saldos para este filtro.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="np-table">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th style={alignRight}>Saldo</th>
                  <th style={alignRight}>Consumos</th>
                  <th>Creada</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {closeRequestsFirst(rows).map((w) => (
                  <tr key={w.id}>
                    <td data-label="Código" data-card="title">
                      {/* Su ficha: recargas, consumos y devoluciones. */}
                      {fichas ? (
                        <button type="button" onClick={() => fichas.openWallet(w.id)} style={codeLink} title="Ver la ficha del saldo">
                          {w.code ?? '—'}
                        </button>
                      ) : (
                        <span className="np-num" style={{ fontWeight: 700, letterSpacing: '0.08em' }}>
                          {w.code ?? '—'}
                        </span>
                      )}
                    </td>
                    <td data-label="Cliente">
                      {w.identifier ?? <em style={{ color: 'var(--np-text-dim)' }}>anónimo</em>}
                    </td>
                    <td data-label="Estado">
                      <div style={badgeRow}>
                        <Pill tone={STATUS_BADGES[w.status].tone}>{STATUS_BADGES[w.status].label}</Pill>
                        {w.status === 'ACTIVE' && w.closeRequestedAt ? <Pill tone="warning">Pide devolución</Pill> : null}
                        {w.hasFaceId ? <Pill tone="success">Face ID</Pill> : null}
                        {w.hasCard ? <Pill tone="success">Ficha</Pill> : null}
                        {w.pinLocked ? (
                          <Pill tone="warning">PIN bloqueado</Pill>
                        ) : w.hasPin ? (
                          <Pill tone="success">PIN</Pill>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Saldo" data-card="amount" style={numTd}>
                      <span className="np-num">{formatEur(w.balanceCents)}</span>
                    </td>
                    <td data-label="Consumos" style={numTd}>
                      {w.consumptionCount}
                    </td>
                    <td data-label="Creada" data-card="top">
                      {formatDateTime(w.createdAt, tz, 'short')}
                    </td>
                    <td data-label="Acciones" data-card="actions">
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {w.status === 'ACTIVE' && w.balanceCents > 0 ? (
                          <Button
                            variant={w.closeRequestedAt ? 'primary' : 'ghost'}
                            onClick={() => setPayoutFor(rowTarget(w))}
                          >
                            Devolver saldo
                          </Button>
                        ) : null}
                        {isOwner && w.status === 'ACTIVE' ? (
                          <Button variant="ghost" onClick={() => setRelinkFor(rowTarget(w))}>
                            Enlace nuevo
                          </Button>
                        ) : null}
                        {w.status === 'ACTIVE' && w.balanceCents > 0 ? (
                          <Button variant="ghost" onClick={() => setChargeFor(rowTarget(w))}>
                            Cobrar sin Face ID
                          </Button>
                        ) : null}
                        {w.pinLocked ? (
                          <Button variant="primary" onClick={() => pinAction(w, 'unlock')}>
                            Desbloquear PIN
                          </Button>
                        ) : null}
                        {w.hasPin ? (
                          <Button variant="ghost" onClick={() => pinAction(w, 'reset')}>
                            Borrar PIN
                          </Button>
                        ) : null}
                        {w.hasCard ? (
                          <Button variant="ghost" onClick={() => blockCard(w)}>
                            Bloquear ficha
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length >= WALLETS_LIMIT ? (
              <p style={{ ...mutedText, marginTop: '0.75rem' }}>
                Se ven las {WALLETS_LIMIT} más recientes. Para otra, búscala por su código arriba.
              </p>
            ) : null}
          </div>
        )}
      </Card>

      {payoutFor ? (
        <PayoutModal
          target={payoutFor}
          isOwner={isOwner}
          onRelink={
            isOwner
              ? () => {
                  setRelinkFor(payoutFor);
                  setPayoutFor(null);
                }
              : undefined
          }
          onClose={() => {
            setPayoutFor(null);
            reload();
          }}
        />
      ) : null}

      {relinkFor ? <RelinkModal target={relinkFor} onClose={() => setRelinkFor(null)} /> : null}
      {chargeFor ? (
        <ChargeWithoutFaceIdModal
          target={chargeFor}
          onClose={() => setChargeFor(null)}
          onDone={() => {
            setChargeFor(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function rowTarget(w: WalletAdminRow): PayoutTarget {
  return {
    walletId: w.id,
    code: w.code,
    balanceCents: w.balanceCents,
    label: w.identifier,
    isHomeVenue: true,
    closeRequested: w.closeRequestedAt !== null,
  };
}

/** Lo que el cliente pidió devolver va primero. */
function closeRequestsFirst(rows: WalletAdminRow[]): WalletAdminRow[] {
  const asks = (w: WalletAdminRow) => (w.status === 'ACTIVE' && w.closeRequestedAt ? 0 : 1);
  return [...rows].sort((x, y) => asks(x) - asks(y));
}

function Tile({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <Card style={{ padding: '1rem' }}>
      <p style={kicker}>{title}</p>
      <p className="np-num" style={tileNumber}>
        {value}
      </p>
      {subtitle ? <p style={tileSub}>{subtitle}</p> : null}
    </Card>
  );
}

const tilesGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.75rem',
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const listHeader: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  marginBottom: '0.75rem',
};

const categoryList: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
  gap: '0.5rem',
};

const categoryItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.45rem 0.7rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  fontSize: '0.85rem',
};

const alignRight: CSSProperties = { textAlign: 'right' };

const numTd: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const badgeRow: CSSProperties = { display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' };

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const tileNumber: CSSProperties = {
  margin: '0.3rem 0 0',
  fontSize: '1.4rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
};

const tileSub: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const mutedText: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-text-dim)' };

const loadingStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
};

const codeLink: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontFamily: 'var(--np-font-mono)',
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: 'var(--np-text)',
  textDecoration: 'underline',
  textUnderlineOffset: '0.15em',
  cursor: 'pointer',
};
