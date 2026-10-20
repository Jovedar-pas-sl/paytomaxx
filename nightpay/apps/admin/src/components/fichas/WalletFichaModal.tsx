'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Modal } from '@nightpay/ui';
import type { WalletFicha } from '@nightpay/contracts';
import { fetchWalletFicha } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { Pill } from '../Pill';
import { CobrosTable } from './CobrosTable';

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo',
  DEPLETED: 'Gastado',
  REFUNDED: 'Devuelto',
  EXPIRED: 'Caducado',
};

/**
 * Ficha del saldo: lo que tiene, sus recargas (cómo y quién cobró), lo que
 * gastó (referencia, chica, sección y servicio) y lo que se le devolvió.
 */
export function WalletFichaModal({ walletId, onClose }: { walletId: string; onClose: () => void }) {
  const tz = useVenueTimezone();
  const [ficha, setFicha] = useState<WalletFicha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchWalletFicha(walletId)
      .then((f) => {
        if (!cancelled) setFicha(f);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [walletId, attempt]);

  const w = ficha?.wallet;
  const title = w ? `Saldo ${w.code ?? ''}`.trim() : 'Saldo';
  const many = new Set(ficha?.consumptions.map((c) => c.venueName)).size > 1;

  return (
    <Modal open onClose={onClose} title={title} width="56rem">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {error ? (
          <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
            {error}
          </Notice>
        ) : null}
        {!ficha ? (
          error ? null : <p style={dim}>Cargando…</p>
        ) : (
          <>
            <div style={head}>
              <div>
                <p style={kicker}>Le queda</p>
                <p className="np-num" style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>
                  {formatEur(w!.balanceCents)}
                </p>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <Pill tone={w!.status === 'ACTIVE' ? 'success' : 'neutral'}>{STATUS_LABEL[w!.status] ?? w!.status}</Pill>
                {w!.label ? <Pill tone="info">{w!.label}</Pill> : null}
                {w!.hasCard ? <Pill tone="info">Ficha NFC</Pill> : null}
                {w!.hasPin ? <Pill tone="info">PIN</Pill> : null}
                {w!.hasFaceId ? <Pill tone="info">Face ID</Pill> : null}
              </div>
              <p style={{ ...dim, flexBasis: '100%' }}>
                De {w!.homeVenueName} · desde {formatDateTime(w!.createdAt, tz, 'short')}
              </p>
            </div>

            <section>
              <h3 style={h3}>Recargas</h3>
              {ficha.topUps.length === 0 ? (
                <p style={dim}>Sin recargas pagadas.</p>
              ) : (
                <ul style={list}>
                  {ficha.topUps.map((t) => (
                    <li key={`${t.kind}-${t.id}`} style={item}>
                      <span className="np-num" style={{ fontWeight: 700, color: t.amountCents < 0 ? 'var(--np-danger)' : undefined }}>
                        {t.amountCents < 0 ? '−' : '+'}
                        {formatEur(Math.abs(t.amountCents))}
                      </span>
                      <span>{t.methodLabel}</span>
                      <span style={dim}>
                        {[t.by?.name ?? t.terminalLabel, t.ref, many ? t.venueName : null, formatDateTime(t.at, tz, 'short')]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {t.note ? <span style={dim}>«{t.note}»</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 style={h3}>Consumos</h3>
              <div className="np-table-host" style={tableHost}>
                <CobrosTable
                  rows={ficha.consumptions}
                  empty="Aún no ha gastado nada."
                  extra={many ? { label: 'Local', cell: (r) => (r as (typeof ficha.consumptions)[number]).venueName } : undefined}
                />
              </div>
            </section>

            <section>
              <h3 style={h3}>Devoluciones</h3>
              {ficha.refunds.length === 0 ? (
                <p style={dim}>Ninguna.</p>
              ) : (
                <ul style={list}>
                  {ficha.refunds.map((r) => (
                    <li key={r.id} style={item}>
                      <span className="np-num" style={{ fontWeight: 700 }}>
                        −{formatEur(r.amountCents)}
                      </span>
                      <span>{r.method === 'CASH' ? 'En efectivo' : 'A la tarjeta'}</span>
                      {r.status === 'PENDING' ? <Pill tone="warning">Apuntándose en el banco</Pill> : null}
                      <span style={dim}>
                        {[r.by?.name, r.bankReference ? `ref. ${r.bankReference}` : null, formatDateTime(r.at, tz, 'short')]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

const dim: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};
const head: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: '0.75rem' };
const h3: CSSProperties = { margin: '0 0 0.5rem', fontSize: '1rem', fontWeight: 700 };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.375rem' };
const item: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  columnGap: '0.75rem',
  rowGap: '0.125rem',
  padding: '0.5rem 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
const tableHost: CSSProperties = { border: '1px solid var(--np-border)', borderRadius: 'var(--np-r-md)', overflow: 'hidden' };
