'use client';

import type { CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import type { MyPayout, PayoutAccount } from '@/lib/api';
import { dayLabel, timeLabel } from '@/lib/earnings-view';
import { httpsUrl } from '@/lib/history';
import { formatEur } from '@/lib/money';
import { payoutMethodLabel } from '@/lib/payout-method';
import styles from './money.module.css';

/** Cuántos pagos se enseñan aquí (los últimos); el resto, en «Ver todos los pagos». */
const SHOWN = 10;

interface Props {
  payouts: MyPayout[] | null;
  /** undefined: aún cargando; null: no tiene cuenta de cobro puesta. */
  account: PayoutAccount | null | undefined;
  /** «Ver todos los pagos»: todos, por páginas y con fechas. */
  onAll?: () => void;
}

/** «Pagos recibidos»: los últimos, con fecha, cómo, cuánto y su justificante, y a qué cuenta se le paga. */
export function PayoutsReceived({ payouts, account, onAll }: Props) {
  return (
    <section aria-labelledby="pagos-recibidos" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} data-tour="ganancias-pagos">
      <h2 id="pagos-recibidos" style={sectionTitle}>
        Pagos recibidos
      </h2>
      {account !== undefined ? <AccountLine account={account} /> : null}
      {payouts === null ? (
        <p style={emptyText}>Cargando…</p>
      ) : payouts.length === 0 ? (
        <p style={emptyText}>Aún no te han pagado nada desde la app.</p>
      ) : (
        <PayoutList payouts={payouts.slice(0, SHOWN)} />
      )}
      {onAll && payouts && payouts.length > 0 ? (
        <div>
          <Button variant="ghost" size="md" onClick={onAll}>
            Ver todos los pagos
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Cada pago: el día y la hora, cómo y cuántos cobros, cuánto y, si lo hay, su justificante. */
export function PayoutList({ payouts }: { payouts: readonly MyPayout[] }) {
  return (
    <ul style={listStyle}>
      {payouts.map((p) => {
        const receipt = httpsUrl(p.receiptUrl);
        return (
          <li key={p.id} style={itemStyle}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 500, fontSize: 'var(--np-fs-16)' }}>
                {dayLabel(p.createdAt)} <span style={muted}>· {timeLabel(p.createdAt)}</span>
              </p>
              <p style={metaText}>
                {payoutMethodLabel(p.externalRail)} · {p.earningCount} {p.earningCount === 1 ? 'cobro' : 'cobros'}
                {p.notes ? ` · ${p.notes}` : ''}
              </p>
              {p.externalTxId ? <p style={{ ...metaText, overflowWrap: 'anywhere' }}>Referencia: {p.externalTxId}</p> : null}
              {receipt ? (
                <a href={receipt} target="_blank" rel="noopener noreferrer" className={styles.receipt}>
                  Ver justificante
                </a>
              ) : null}
            </div>
            <span className="np-num" style={amountStyle}>
              {formatEur(p.totalCents, { compact: true })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function AccountLine({ account }: { account: PayoutAccount | null }) {
  if (!account) {
    return (
      <p style={accountStyle}>
        Aún no tienes cuenta de cobro: pídesela al encargado. ¿No tienes cuenta de banco?{' '}
        <a href="/cuenta-basica" style={{ color: 'var(--np-text)', textDecoration: 'underline' }}>
          Cómo abrir una cuenta de pago básica
        </a>
      </p>
    );
  }
  const parts = [payoutMethodLabel(account.method), account.masked, account.label].filter(Boolean);
  return (
    <p style={accountStyle}>
      <span style={muted}>Te pagan a </span>
      <strong style={{ fontWeight: 600 }}>
        {parts.join(' · ')}
      </strong>
    </p>
  );
}

// Grafito: título de bloque 18/600 en t1, sin mayúsculas ni espaciado.
const sectionTitle: CSSProperties = {
  margin: '0.5rem 0 0',
  fontSize: 'var(--np-t-h3)',
  color: 'var(--np-text)',
  fontWeight: 600,
};

// Filete normal: el borde a trazos es, en Grafito, el del saldo y las recargas.
const accountStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  borderTop: '1px solid var(--np-border)',
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.875rem 0.25rem',
  borderBottom: '1px solid var(--np-border)',
};

const amountStyle: CSSProperties = {
  fontSize: 'var(--np-fs-18)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const muted: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 500 };

const metaText: CSSProperties = {
  margin: '0.125rem 0 0',
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-text-mute)',
};

const emptyText: CSSProperties = {
  margin: 0,
  padding: '1rem 0',
  color: 'var(--np-text-mute)',
};
