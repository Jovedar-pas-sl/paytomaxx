'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  consumeWallet,
  fetchActiveWallets,
  type ActiveWallet,
  type ConsumeWalletResult,
} from '@/lib/api';

interface Props {
  onConsumed: () => void;
}

const CATEGORIES = [
  { value: 'time', label: 'Tiempo / Servicio' },
  { value: 'bar', label: 'Barra (bebidas)' },
  { value: 'room', label: 'Habitación' },
  { value: 'service', label: 'Otro servicio' },
  { value: 'other', label: 'Otro' },
];

/**
 * Pantalla "Cobrar a wallet" — flow correcto sin molestar al cliente:
 *
 *   1. La chica ve la LISTA de wallets activos del venue (etiquetados por
 *      identifier — Mesa 3, Pulsera azul, etc. — al momento del top-up).
 *   2. Click en uno → form de cobro (importe + categoría).
 *   3. Confirmar → backend cobra atómico + genera su comisión.
 *
 * Cero interacción con el móvil del cliente. El cliente paga UNA vez al
 * entrar al venue desde el QR de top-up; el resto es invisible para él.
 */
export function ChargeWallet({ onConsumed }: Props) {
  const [wallets, setWallets] = useState<ActiveWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ActiveWallet | null>(null);
  const [search, setSearch] = useState('');

  async function reload() {
    setLoading(true);
    try {
      const list = await fetchActiveWallets();
      setWallets(list);
      // Si el wallet seleccionado se quedó atrás (refresh tras cobro), recógelo.
      if (selected) {
        const fresh = list.find((w) => w.id === selected.id);
        if (fresh) setSelected(fresh);
        else setSelected(null);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    const id = setInterval(reload, 8000); // refrescar lista cada 8s
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (selected) {
    return (
      <ChargeForm
        wallet={selected}
        onBack={() => setSelected(null)}
        onConsumed={() => {
          reload();
          onConsumed();
        }}
      />
    );
  }

  const filtered = wallets.filter((w) =>
    !search.trim()
      ? true
      : (w.identifier ?? '').toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Card style={{ padding: '1.25rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <h3 style={titleStyle}>Wallets activos</h3>
        <p style={hintStyle}>
          Toca el wallet del cliente que estás atendiendo. La etiqueta la pusiste cuando
          cargó el saldo.
        </p>
      </div>

      <Input
        type="text"
        placeholder="Buscar por etiqueta..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {error ? <p style={errorStyle}>{error}</p> : null}

      {loading && wallets.length === 0 ? (
        <p style={emptyStyle}>Cargando wallets...</p>
      ) : filtered.length === 0 ? (
        <div style={emptyStateStyle}>
          <p style={{ ...emptyStyle, marginBottom: '0.5rem' }}>
            {wallets.length === 0
              ? 'No hay wallets activos todavía.'
              : `No coincide con "${search}".`}
          </p>
          {wallets.length === 0 ? (
            <p style={{ fontSize: '0.78rem', color: 'var(--np-text-dim)', margin: 0 }}>
              Para cargar uno: tab <strong>Inicio</strong> → toggle "Cargar wallet" → pon etiqueta
              (Mesa 3, Pulsera azul...) y el cliente paga UNA vez por QR.
            </p>
          ) : null}
        </div>
      ) : (
        <ul style={walletListStyle}>
          {filtered.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => setSelected(w)}
                style={walletItemStyle}
                type="button"
              >
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <p style={walletLabelStyle}>
                    {w.identifier ?? <em style={{ color: 'var(--np-text-dim)' }}>sin etiqueta</em>}
                  </p>
                  <p style={walletMetaStyle}>
                    {w.consumptionCount} consumo{w.consumptionCount === 1 ? '' : 's'} ·{' '}
                    {timeAgo(w.createdAt)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p className="np-num" style={walletBalanceStyle}>
                    {(w.balanceCents / 100).toFixed(2)}
                    <span style={{ fontSize: '0.7rem', color: 'var(--np-text-mute)' }}> €</span>
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChargeForm({
  wallet,
  onBack,
  onConsumed,
}: {
  wallet: ActiveWallet;
  onBack: () => void;
  onConsumed: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('time');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<ConsumeWalletResult | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(Number(amount.replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (cents > wallet.balanceCents) {
        throw new Error(
          `Saldo insuficiente. Disponible: ${(wallet.balanceCents / 100).toFixed(2)} €`,
        );
      }
      if ('vibrate' in navigator) navigator.vibrate(10);
      const result = await consumeWallet({
        walletId: wallet.id,
        amountCents: cents,
        category,
        notes: notes.trim() || undefined,
      });
      setLast(result);
      setAmount('');
      setNotes('');
      onConsumed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ padding: '1.25rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={titleStyle}>{wallet.identifier ?? 'Wallet sin etiqueta'}</h3>
          <p style={hintStyle}>Wallet activo</p>
        </div>
        <button
          onClick={onBack}
          type="button"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--np-text-mute)',
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          ← Lista
        </button>
      </div>

      <div style={balancePillStyle}>
        <span style={kickerStyle}>Saldo disponible</span>
        <p className="np-num" style={balanceNumStyle}>
          {(wallet.balanceCents / 100).toFixed(2)} <span style={currStyle}>EUR</span>
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Input
          label="Importe a cobrar (€)"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
          placeholder="50"
          disabled={submitting}
          inputMode="decimal"
          autoFocus
        />
        <div>
          <label style={selectLabelStyle}>Categoría</label>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={submitting}
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="ej: 30 min · habitación 3"
          disabled={submitting}
        />
        {error ? <p style={errorStyle}>{error}</p> : null}
        {last ? (
          <Card style={{ padding: '0.875rem', background: 'var(--np-surface-2)' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-success)', fontWeight: 600 }}>
              ✓ Cobro registrado
            </p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
              Nuevo saldo: {(last.newBalanceCents / 100).toFixed(2)} €
            </p>
            {last.earningCreated ? (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
                Tu comisión: +{((last.earningCommissionCents ?? 0) / 100).toFixed(2)} €
              </p>
            ) : null}
          </Card>
        ) : null}
        <Button type="submit" loading={submitting} disabled={!amount.trim()}>
          Cobrar {amount ? `${amount} €` : ''}
        </Button>
      </form>
    </Card>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `hace ${hrs}h ${mins % 60}m`;
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
};

const hintStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.78rem',
  color: 'var(--np-text-mute)',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'var(--np-danger)',
};

const emptyStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
  textAlign: 'center',
};

const emptyStateStyle: CSSProperties = {
  padding: '1.5rem 1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px dashed var(--np-border)',
  textAlign: 'center',
};

const walletListStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const walletItemStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.875rem 1rem',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: 'var(--np-text)',
};

const walletLabelStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  fontWeight: 600,
};

const walletMetaStyle: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: '0.72rem',
  color: 'var(--np-text-mute)',
};

const walletBalanceStyle: CSSProperties = {
  margin: 0,
  fontSize: '1.1rem',
  fontWeight: 600,
  color: 'var(--np-success)',
  fontVariantNumeric: 'tabular-nums',
};

const balancePillStyle: CSSProperties = {
  padding: '0.75rem 1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  alignItems: 'center',
};

const kickerStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

const balanceNumStyle: CSSProperties = {
  margin: 0,
  fontSize: '2rem',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--np-success)',
};

const currStyle: CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
};

const selectLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  marginBottom: '0.375rem',
};
