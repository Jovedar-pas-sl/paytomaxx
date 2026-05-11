'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  consumeWallet,
  fetchWalletPublic,
  type ConsumeWalletResult,
  type WalletPublicView,
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
 * Pantalla "Cobrar a wallet" para la chica.
 *
 * Flow:
 *   1. Pega el qrToken del cliente (lo lee con la cámara o pega manualmente).
 *   2. Carga el wallet → muestra balance + últimos consumos.
 *   3. Introduce importe + categoría → confirmar.
 *   4. Backend descuenta del balance + crea earning automático.
 */
export function ChargeWallet({ onConsumed }: Props) {
  const [qrToken, setQrToken] = useState('');
  const [wallet, setWallet] = useState<WalletPublicView | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('time');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<ConsumeWalletResult | null>(null);

  async function handleLoadWallet(e: FormEvent) {
    e.preventDefault();
    setLoadingWallet(true);
    setError(null);
    setWallet(null);
    try {
      const w = await fetchWalletPublic(qrToken.trim());
      setWallet(w);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingWallet(false);
    }
  }

  async function handleConsume(e: FormEvent) {
    e.preventDefault();
    if (!wallet) return;
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(Number(amount.replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        throw new Error('Importe inválido');
      }
      if (cents > wallet.balanceCents) {
        throw new Error(
          `Balance insuficiente. Tiene ${(wallet.balanceCents / 100).toFixed(2)} €`,
        );
      }
      const result = await consumeWallet({
        walletId: wallet.id,
        amountCents: cents,
        category,
        notes: notes.trim() || undefined,
      });
      setLast(result);
      setAmount('');
      setNotes('');
      // refresca el wallet para mostrar el nuevo balance
      const refreshed = await fetchWalletPublic(qrToken.trim());
      setWallet(refreshed);
      onConsumed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setWallet(null);
    setQrToken('');
    setAmount('');
    setNotes('');
    setError(null);
    setLast(null);
  }

  if (!wallet) {
    return (
      <Card style={cardStyle}>
        <h3 style={titleStyle}>Cobrar a wallet del cliente</h3>
        <p style={hintStyle}>
          Pídele al cliente que te muestre su QR de wallet, escanéalo o pega el código aquí.
        </p>
        <form onSubmit={handleLoadWallet} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Input
            label="Código QR del cliente"
            value={qrToken}
            onChange={(e) => setQrToken(e.target.value)}
            placeholder="Pega o escanea aquí"
            disabled={loadingWallet}
            autoFocus
          />
          {error ? <p style={errorStyle}>{error}</p> : null}
          <Button type="submit" loading={loadingWallet} disabled={!qrToken.trim()}>
            Cargar wallet
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={titleStyle}>Wallet del cliente</h3>
          <p style={hintStyle}>Status: {wallet.status}</p>
        </div>
        <button
          onClick={reset}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--np-text-mute)',
            fontSize: '0.85rem',
            cursor: 'pointer',
          }}
        >
          ← Cambiar
        </button>
      </div>

      <div style={balancePillStyle}>
        <span style={{ fontSize: '0.7rem', color: 'var(--np-text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Saldo disponible
        </span>
        <p className="np-num" style={balanceNumStyle}>
          {(wallet.balanceCents / 100).toFixed(2)} <span style={currStyle}>EUR</span>
        </p>
      </div>

      <form onSubmit={handleConsume} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Input
          label="Importe a cobrar (€)"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
          placeholder="50"
          disabled={submitting || wallet.status !== 'ACTIVE'}
          inputMode="decimal"
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
        <Button type="submit" loading={submitting} disabled={!amount.trim() || wallet.status !== 'ACTIVE'}>
          Cobrar {amount ? `${amount} €` : ''}
        </Button>
      </form>

      {wallet.consumptions.length > 0 ? (
        <details style={{ marginTop: '0.75rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--np-text-mute)' }}>
            Últimos consumos ({wallet.consumptions.length})
          </summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {wallet.consumptions.slice(0, 10).map((c) => (
              <li key={c.id} style={consumptionItemStyle}>
                <span>
                  {c.category} {c.providedByName ? `· ${c.providedByName}` : ''}
                </span>
                <span className="np-num">-{(c.amountCents / 100).toFixed(2)} €</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: '1.25rem 1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.875rem',
};

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

const consumptionItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.78rem',
  padding: '0.35rem 0.6rem',
  background: 'var(--np-bg)',
  borderRadius: 'var(--np-r-sm)',
  border: '1px solid var(--np-border)',
};
