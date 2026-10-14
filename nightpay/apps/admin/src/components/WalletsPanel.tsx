'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal, Select } from '@nightpay/ui';
import {
  fetchWalletsList,
  fetchWalletsStats,
  lookupWalletCode,
  payoutWallet,
  relinkWallet,
  resetWalletPin,
  unlockWalletPin,
  type WalletAdminRow,
  type WalletPayoutMethod,
  type WalletsAdminStats,
} from '@/lib/api';

/** Saldo a devolver: de la lista o encontrado por el código del cliente. */
interface PayoutTarget {
  walletId: string;
  code: string | null;
  balanceCents: number;
  label: string | null;
  /** Cargado en este local: solo desde aquí se apunta la devolución a la tarjeta. */
  isHomeVenue: boolean;
  /** El cliente pulsó "Me voy" (sin eso, solo el dueño devuelve). */
  closeRequested: boolean;
}

const STATUS_FILTERS: Array<{ value: '' | WalletAdminRow['status']; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'ACTIVE', label: '🟢 Activas' },
  { value: 'DEPLETED', label: '⚪ Agotadas' },
  { value: 'REFUNDED', label: '🔵 Reembolsadas' },
  { value: 'EXPIRED', label: '🔴 Expiradas' },
];

interface Props {
  isOwner: boolean;
}

export function WalletsPanel({ isOwner }: Props) {
  const [stats, setStats] = useState<WalletsAdminStats | null>(null);
  const [rows, setRows] = useState<WalletAdminRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | WalletAdminRow['status']>('ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const [payoutFor, setPayoutFor] = useState<PayoutTarget | null>(null);
  const [relinkFor, setRelinkFor] = useState<PayoutTarget | null>(null);

  /** Desbloquear o borrar el PIN de un cliente; luego se recarga la lista. */
  async function pinAction(w: WalletAdminRow, action: 'unlock' | 'reset') {
    const question =
      action === 'unlock'
        ? `¿Desbloquear el PIN del saldo ${w.code ?? ''}? El cliente podrá volver a pagar.`
        : `¿Borrar el PIN del saldo ${w.code ?? ''}? El cliente elegirá uno nuevo la próxima vez que pague.`;
    if (!window.confirm(question)) return;
    try {
      if (action === 'unlock') await unlockWalletPin(w.id);
      else await resetWalletPin(w.id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reload() {
    try {
      const [s, list] = await Promise.all([
        fetchWalletsStats(),
        fetchWalletsList({
          status: statusFilter === '' ? undefined : statusFilter,
        }),
      ]);
      setStats(s);
      setRows(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [statusFilter]);

  if (error) {
    return (
      <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
        <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p>
      </Card>
    );
  }
  if (!stats) return <p style={loadingStyle}>Cargando wallets…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Tiles de stats */}
      <section style={tilesGrid}>
        <Tile
          title="Wallets activas"
          value={String(stats.activeCount)}
          subtitle={`${(stats.totalBalanceCents / 100).toFixed(2)} € total`}
        />
        <Tile
          title="Top-ups hoy"
          value={(stats.todayTopUpsCents / 100).toFixed(2)}
          unit="EUR"
        />
        <Tile
          title="Consumido hoy"
          value={(stats.todayConsumptionsCents / 100).toFixed(2)}
          unit="EUR"
        />
        <Tile
          title="Reembolsos hoy"
          value={(stats.todayRefundsCents / 100).toFixed(2)}
          unit="EUR"
        />
      </section>

      {/* Split por categoría */}
      {Object.keys(stats.byCategory).length > 0 ? (
        <Card style={{ padding: '1rem' }}>
          <h3 style={sectionTitle}>Consumos por categoría (hoy)</h3>
          <ul style={categoryList}>
            {Object.entries(stats.byCategory).map(([cat, cents]) => (
              <li key={cat} style={categoryItem}>
                <span style={{ textTransform: 'capitalize' }}>{cat}</span>
                <span className="np-num" style={{ fontWeight: 600 }}>
                  {(cents / 100).toFixed(2)} €
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <CodeSearch onFound={setPayoutFor} />

      {/* Lista de wallets */}
      <Card style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={sectionTitle}>Lista de wallets</h3>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | WalletAdminRow['status'])}
            style={{ width: '12rem' }}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </div>

        {rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--np-text-dim)' }}>
            Sin wallets para este filtro.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={th}>Código</th>
                <th style={th}>Cliente</th>
                <th style={th}>Estado</th>
                <th style={thRight}>Saldo</th>
                <th style={thRight}>Consumos</th>
                <th style={th}>Creada</th>
                <th style={th}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {closeRequestsFirst(rows).map((w) => (
                <tr key={w.id} style={trStyle}>
                  <td style={td}>
                    <span className="np-num" style={{ fontWeight: 700, letterSpacing: '0.08em' }}>{w.code ?? '—'}</span>
                  </td>
                  <td style={td}>{w.identifier ?? <em style={{ color: 'var(--np-text-dim)' }}>anónimo</em>}</td>
                  <td style={td}>
                    <StatusBadge status={w.status} />
                    {w.status === 'ACTIVE' && w.closeRequestedAt ? (
                      <span style={closeBadgeStyle}>Pide devolución</span>
                    ) : null}
                    {w.pinLocked ? <span style={lockedBadgeStyle}>PIN bloqueado</span> : null}
                    {!w.hasPin && w.status === 'ACTIVE' ? <span style={dimBadgeStyle}>sin PIN</span> : null}
                    {w.hasTag ? <span style={dimBadgeStyle}>NFC</span> : null}
                  </td>
                  <td style={tdRight}>
                    <span className="np-num">{(w.balanceCents / 100).toFixed(2)} €</span>
                  </td>
                  <td style={tdRight}>{w.consumptionCount}</td>
                  <td style={td}>
                    {new Date(w.createdAt).toLocaleString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td style={td}>
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
                      {w.pinLocked ? (
                        <Button variant="primary" onClick={() => void pinAction(w, 'unlock')}>
                          Desbloquear PIN
                        </Button>
                      ) : null}
                      {w.hasPin ? (
                        <Button variant="ghost" onClick={() => void pinAction(w, 'reset')}>
                          PIN nuevo
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
    </div>
  );
}

function StatusBadge({ status }: { status: WalletAdminRow['status'] }) {
  const map: Record<WalletAdminRow['status'], { label: string; color: string }> = {
    ACTIVE: { label: '🟢 Activa', color: 'var(--np-success)' },
    DEPLETED: { label: '⚪ Agotada', color: 'var(--np-text-mute)' },
    REFUNDED: { label: '🔵 Reembolsada', color: 'var(--np-accent)' },
    EXPIRED: { label: '🔴 Expirada', color: 'var(--np-danger)' },
  };
  const d = map[status];
  return <span style={{ color: d.color, fontSize: '0.8rem', fontWeight: 500 }}>{d.label}</span>;
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

/** El cliente de otro local del grupo: se le encuentra por su código. */
function CodeSearch({ onFound }: { onFound: (target: PayoutTarget) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const found = await lookupWalletCode(code);
      onFound({
        walletId: found.walletId,
        code: found.code,
        balanceCents: found.balanceCents,
        label: found.label,
        isHomeVenue: found.isHomeVenue,
        closeRequested: found.closeRequested,
      });
      setCode('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1rem' }}>
      <h3 style={sectionTitle}>Devolver el saldo a un cliente que se va</h3>
      <p style={{ margin: '0.25rem 0 0.75rem', fontSize: '0.8rem', color: 'var(--np-text-mute)' }}>
        Pon el código que sale en su página de saldo (vale aunque cargara en otro local).
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <Input
          aria-label="Código del cliente"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          placeholder="K7Q4M2"
          autoComplete="off"
          spellCheck={false}
          style={{ letterSpacing: '0.2em', fontWeight: 700 }}
        />
        <Button type="submit" loading={busy} disabled={code.length !== 6}>
          Buscar
        </Button>
      </form>
      {error ? <p style={{ color: 'var(--np-danger)', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>{error}</p> : null}
    </Card>
  );
}

function PayoutModal({
  target,
  isOwner,
  onRelink,
  onClose,
}: {
  target: PayoutTarget;
  isOwner: boolean;
  /** Solo el dueño: el cliente perdió el enlace de su saldo. */
  onRelink?: () => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<WalletPayoutMethod>('CASH');
  const canCard = isOwner && target.isHomeVenue;
  // Sin el "Me voy" del cliente, solo el dueño puede devolver.
  const canPay = isOwner || target.closeRequested;
  const [bankReference, setBankReference] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const amount = eur(target.balanceCents);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await payoutWallet(target.walletId, {
        method,
        bankReference: method === 'CARD' ? bankReference.trim() || undefined : undefined,
        note: note.trim() || undefined,
      });
      setDone(
        `Apuntado: ${eur(res.refundedCents)} devueltos ${res.method === 'CASH' ? 'en efectivo' : 'a la tarjeta'}. Saldo cerrado.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Devolver saldo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo a devolver: <strong className="np-num">{amount}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>

        {onRelink && !done ? (
          <button type="button" onClick={onRelink} style={linkStyle}>
            ¿El cliente perdió el enlace de su saldo? Darle uno nuevo
          </button>
        ) : null}

        {done ? (
          <>
            <p style={{ margin: 0, color: 'var(--np-success)', fontWeight: 600 }}>{done}</p>
            <Button onClick={onClose}>Cerrar</Button>
          </>
        ) : (
          <>
            <div role="radiogroup" aria-label="Cómo se devuelve" style={methodRowStyle}>
              <MethodOption
                active={method === 'CASH'}
                title="Efectivo"
                text="Se lo das ahora, de la caja de este local."
                onClick={() => setMethod('CASH')}
              />
              <MethodOption
                active={method === 'CARD'}
                disabled={!canCard}
                title="A su tarjeta"
                text={
                  !isOwner
                    ? 'Solo el dueño.'
                    : canCard
                      ? 'Lo devuelves en el portal de BBVA.'
                      : 'Desde el local donde cargó el saldo.'
                }
                onClick={() => setMethod('CARD')}
              />
            </div>

            {canPay ? null : (
              <p style={{ ...helpStyle, color: 'var(--np-warning)' }}>
                El cliente aún no ha pulsado «Me voy» en su página de saldo. Pídeselo, o que lo devuelva el dueño.
              </p>
            )}

            {method === 'CASH' ? (
              <p style={helpStyle}>Dale {amount} al cliente y confirma. El saldo queda cerrado.</p>
            ) : (
              <>
                <p style={helpStyle}>
                  1. En el portal de BBVA, devuelve {amount} a las recargas de saldo del cliente (la más reciente
                  primero). 2. Pon la referencia de la devolución y confirma: aquí se apunta igual, repartido entre
                  sus recargas.
                </p>
                <Input
                  label="Referencia de la devolución en BBVA"
                  value={bankReference}
                  onChange={(e) => setBankReference(e.target.value)}
                  maxLength={60}
                />
              </>
            )}

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Nota (opcional)"
              rows={2}
              maxLength={300}
              style={textareaStyle}
            />
            {error ? <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p> : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={submitting}>
                Cancelar
              </Button>
              <Button onClick={handleSubmit} loading={submitting} disabled={!canPay}>
                Devolver {amount}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Enlace nuevo del saldo: el cliente escanea el QR con su móvil. */
function RelinkModal({ target, onClose }: { target: PayoutTarget; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; qrDataUrl: string } | null>(null);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      setLink(await relinkWallet(target.walletId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Enlace nuevo del saldo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={summaryStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo: <strong className="np-num">{eur(target.balanceCents)}</strong>
          </p>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            {[target.code, target.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        {link ? (
          <>
            <p style={helpStyle}>Que el cliente escanee este QR con su móvil y guarde la página. Es su saldo.</p>
            <img
              src={link.qrDataUrl}
              alt="QR del enlace del saldo"
              width={240}
              height={240}
              style={{ alignSelf: 'center', borderRadius: 'var(--np-r-md)' }}
            />
            <p style={{ ...helpStyle, wordBreak: 'break-all', fontSize: '0.72rem' }}>{link.url}</p>
            <Button onClick={onClose}>Hecho</Button>
          </>
        ) : (
          <>
            <p style={helpStyle}>
              Para el cliente que ya no encuentra su página de saldo. El enlace que tenía deja de funcionar y se le da
              uno nuevo con un QR.
            </p>
            {error ? <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p> : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} loading={busy}>
                Crear enlace nuevo
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function MethodOption({
  active,
  disabled = false,
  title,
  text,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...methodStyle,
        borderColor: active ? 'var(--np-accent)' : 'var(--np-border)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>{text}</span>
    </button>
  );
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

function Tile({
  title,
  value,
  unit,
  subtitle,
}: {
  title: string;
  value: string;
  unit?: string;
  subtitle?: string;
}) {
  return (
    <Card style={{ padding: '1rem' }}>
      <p style={kicker}>{title}</p>
      <p className="np-num" style={tileNumber}>
        {value}
        {unit ? <span style={tileUnit}> {unit}</span> : null}
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
  justifyContent: 'space-between',
  padding: '0.45rem 0.7rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  fontSize: '0.85rem',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const theadRow: CSSProperties = {
  borderBottom: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
};

const th: CSSProperties = {
  padding: '0.5rem 0.6rem',
  textAlign: 'left',
  fontSize: '0.72rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const thRight: CSSProperties = { ...th, textAlign: 'right' };

const trStyle: CSSProperties = {
  borderBottom: '1px solid var(--np-border)',
};

const td: CSSProperties = {
  padding: '0.55rem 0.6rem',
};

const tdRight: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

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

const tileUnit: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.05em',
};

const tileSub: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const closeBadgeStyle: CSSProperties = {
  marginLeft: '0.5rem',
  padding: '0.1rem 0.45rem',
  borderRadius: '999px',
  border: '1px solid var(--np-warning)',
  color: 'var(--np-warning)',
  fontSize: '0.72rem',
  fontWeight: 600,
};

const lockedBadgeStyle: CSSProperties = {
  ...closeBadgeStyle,
  border: '1px solid var(--np-danger)',
  color: 'var(--np-danger)',
};

const dimBadgeStyle: CSSProperties = {
  ...closeBadgeStyle,
  border: '1px solid var(--np-border)',
  color: 'var(--np-text-dim)',
};

const summaryStyle: CSSProperties = {
  padding: '0.75rem 1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
};

const methodRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.5rem',
};

const methodStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.25rem',
  padding: '0.75rem',
  textAlign: 'left',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
};

const linkStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--np-accent)',
  fontSize: '0.8rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const helpStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.82rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.45,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.625rem 0.875rem',
  fontSize: '0.875rem',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  resize: 'vertical',
};

const loadingStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
};
