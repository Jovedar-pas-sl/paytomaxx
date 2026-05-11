'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Card, Stage } from '@nightpay/ui';
import { fetchWalletByToken, type WalletPublicView } from '@/lib/api';

interface Props {
  initial: WalletPublicView;
  token: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  bar: 'Barra',
  room: 'Habitación',
  time: 'Tiempo / Servicio',
  service: 'Servicio',
  other: 'Otro',
};

const STATUS_LABELS: Record<WalletPublicView['status'], { label: string; color: string }> = {
  ACTIVE: { label: 'Activa', color: 'var(--np-success)' },
  EXPIRED: { label: 'Expirada', color: 'var(--np-danger)' },
  REFUNDED: { label: 'Reembolsada', color: 'var(--np-text-mute)' },
  DEPLETED: { label: 'Agotada', color: 'var(--np-warning, #f59e0b)' },
};

export function WalletClient({ initial, token }: Props) {
  const [wallet, setWallet] = useState<WalletPublicView>(initial);
  const [refreshing, setRefreshing] = useState(false);

  // Polling cada 5s — el saldo cambia cuando el staff cobra contra el wallet.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const fresh = await fetchWalletByToken(token);
        setWallet(fresh);
      } catch {
        // silencio — refresh manual mostraría el error
      }
    }, 5000);
    return () => clearInterval(id);
  }, [token]);

  async function manualRefresh() {
    setRefreshing(true);
    try {
      const fresh = await fetchWalletByToken(token);
      setWallet(fresh);
    } finally {
      setRefreshing(false);
    }
  }

  const totalConsumed = wallet.consumptions.reduce((sum, c) => sum + c.amountCents, 0);
  const statusDisplay = STATUS_LABELS[wallet.status];

  return (
    <Stage>
      <div style={{ width: '100%', maxWidth: '28rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Status banner */}
        <div style={{ ...statusBanner, color: statusDisplay.color }}>
          {statusDisplay.label}
        </div>

        {/* Balance card — el destacado */}
        <Card variant="glow" style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
          <p style={kicker}>Tu saldo</p>
          <p className="np-num" style={balanceBig}>
            {(wallet.balanceCents / 100).toFixed(2)}
            <span style={curr}> EUR</span>
          </p>
          {wallet.expiresAt ? (
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
              Expira: {new Date(wallet.expiresAt).toLocaleString('es-ES')}
            </p>
          ) : null}
        </Card>

        {/* Consumos */}
        <Card style={{ padding: '1.25rem 1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>
              Consumos esta noche
            </h3>
            <button
              onClick={manualRefresh}
              disabled={refreshing}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--np-text-mute)',
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              {refreshing ? '...' : '↻'}
            </button>
          </div>

          {wallet.consumptions.length === 0 ? (
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--np-text-dim)', textAlign: 'center', padding: '0.75rem 0' }}>
              Aún no has consumido nada. Disfruta la noche.
            </p>
          ) : (
            <>
              <ul style={consumptionList}>
                {wallet.consumptions.map((c) => (
                  <li key={c.id} style={consumptionItem}>
                    <div>
                      <p style={consumptionCategory}>
                        {CATEGORY_LABELS[c.category] ?? c.category}
                      </p>
                      <p style={consumptionMeta}>
                        {c.providedByName ?? 'staff'} · {new Date(c.createdAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <p className="np-num" style={consumptionAmount}>
                      -{(c.amountCents / 100).toFixed(2)} €
                    </p>
                  </li>
                ))}
              </ul>
              <div style={totalRow}>
                <span>Total consumido</span>
                <span className="np-num">
                  {(totalConsumed / 100).toFixed(2)} €
                </span>
              </div>
            </>
          )}
        </Card>

        {/* Help footer */}
        <p style={footerHint}>
          Si quieres reembolso del saldo restante, pídeselo al staff al salir.
        </p>
      </div>
    </Stage>
  );
}

const statusBanner: CSSProperties = {
  textAlign: 'center',
  fontSize: '0.78rem',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const kicker: CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const balanceBig: CSSProperties = {
  margin: '0.25rem 0 0.5rem',
  fontSize: 'clamp(2.75rem, 13vw, 4.25rem)',
  fontWeight: 600,
  letterSpacing: '-0.04em',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--np-success)',
};

const curr: CSSProperties = {
  fontSize: '1rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.05em',
};

const consumptionList: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const consumptionItem: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.625rem 0.75rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
};

const consumptionCategory: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 500,
};

const consumptionMeta: CSSProperties = {
  margin: '0.15rem 0 0',
  fontSize: '0.72rem',
  color: 'var(--np-text-mute)',
};

const consumptionAmount: CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const totalRow: CSSProperties = {
  marginTop: '0.875rem',
  paddingTop: '0.75rem',
  borderTop: '1px dashed var(--np-border)',
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
};

const footerHint: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
};
