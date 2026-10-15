'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import { fetchMyNight, type MyNight } from '@/lib/api';
import { formatEur } from '@/lib/money';

/**
 * Fase 1D — "Esta noche": cuántos cobros lleva la chica y cuánto es suyo
 * (comisión + propinas − devoluciones). La noche abierta; recién cerrada,
 * esa noche; si el local no la abre, desde las 08:00.
 */
export function MyNightCard() {
  const [night, setNight] = useState<MyNight | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyNight()
      .then((n) => !cancelled && setNight(n))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
        <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.9rem' }}>{error}</p>
      </Card>
    );
  }
  if (!night) return null;

  return (
    <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p style={kicker}>
        {night.to
          ? `Última noche · ${formatTime(night.from)}–${formatTime(night.to)}`
          : `Esta noche · desde las ${formatTime(night.from)}`}
      </p>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
        <span style={{ fontSize: '1.0625rem', fontWeight: 600 }}>Tu parte</span>
        <span className="np-num" style={{ fontSize: '2.25rem', fontWeight: 700, color: 'var(--np-accent)' }}>
          {formatEur(night.netCents, { compact: true })}
        </span>
      </div>
      <p style={meta}>
        {night.count} {night.count === 1 ? 'cobro' : 'cobros'} · {formatEur(night.chargedCents, { compact: true })} cobrado
        {night.tipsCents > 0 ? ` · ${formatEur(night.tipsCents, { compact: true })} de propinas` : ''}
        {night.reversedCents > 0 ? ` · −${formatEur(night.reversedCents, { compact: true })} por devoluciones` : ''}
      </p>
    </Card>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
}

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const meta: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
