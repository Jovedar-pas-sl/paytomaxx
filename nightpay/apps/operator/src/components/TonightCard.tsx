'use client';

import type { CSSProperties } from 'react';
import type { MyNight } from '@/lib/api';
import { tonightBreakdown, tonightStatus, type MoneySummary, type TonightTone } from '@/lib/earnings-view';
import { formatEur, formatSignedEur } from '@/lib/money';
import styles from './money.module.css';

interface Props {
  night: MyNight | null;
  summary: MoneySummary;
  /** Días de espera antes de pagar (null: no se sabe). */
  holdDays: number | null;
  /** En Inicio: más pequeña (el botón de cobrar tiene que caber). */
  compact?: boolean;
  /** Toda la tarjeta se toca: a «Ganancias» desde Inicio, a los cobros de la noche desde «Ganancias». */
  onOpen: () => void;
  /** Su nombre, junto a «Esta noche» (en un móvil compartido se ve quién ha entrado). */
  who?: string | null;
}

const TONE_LABEL: Record<TonightTone, string> = {
  open: 'Abierta',
  closed: 'Cerrada',
  paid: 'Pagada',
  none: 'Sin noche',
};

/**
 * «Esta noche»: lo que le pagan al cerrar la noche (comisión + propinas −
 * devoluciones), enorme, y cuándo se lo pagan.
 */
export function TonightCard({ night, summary, holdDays, compact = false, onOpen, who }: Props) {
  const status = night ? tonightStatus(night, summary, holdDays, Date.now()) : null;
  const cents = summary.tonightCents;
  const amount = night ? (cents < 0 ? formatSignedEur(cents, { compact: true }) : formatEur(cents, { compact: true })) : '—';
  const color = !night || cents === 0 ? 'var(--np-text-mute)' : cents < 0 ? 'var(--np-danger)' : 'var(--np-accent)';

  return (
    <button type="button" className={styles.hero} data-compact={compact} onClick={onOpen}>
      <span style={topLine}>
        <span style={kicker}>Esta noche{who ? ` · ${who}` : ''}</span>
        {status ? <TonePill tone={status.tone} /> : null}
      </span>
      <span className="np-num" style={{ ...amountStyle, color, fontSize: fitAmount(amount, compact) }}>
        {amount}
      </span>
      <span style={whenStyle}>{status?.when ?? 'Cargando tu noche…'}</span>
      {!compact && night ? <span style={metaStyle}>{tonightBreakdown(night)}</span> : null}
      {!compact && status ? <span style={metaStyle}>{status.state}</span> : null}
      <Chevron />
    </button>
  );
}

function TonePill({ tone }: { tone: TonightTone }) {
  const live = tone === 'open';
  return (
    <span
      style={{
        ...pill,
        color: tone === 'paid' ? 'var(--np-success)' : live ? 'var(--np-accent)' : 'var(--np-text-mute)',
        background: tone === 'paid' ? 'var(--np-pill-success-bg)' : live ? 'var(--np-pill-cyan-bg)' : 'var(--np-pill-mute-bg)',
      }}
    >
      {live ? <span aria-hidden style={dot} /> : null}
      {tone === 'paid' ? '✓ ' : null}
      {TONE_LABEL[tone]}
    </span>
  );
}

export function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * Unbounded es muy ancha: la cifra cabe en una línea a 320 px (≈0,85 em por
 * carácter) sin pasar del tamaño máximo.
 */
export function fitAmount(text: string, compact: boolean): string {
  const max = compact ? '2.75rem' : '4.5rem';
  const perChar = Math.max(4, text.length) * 0.85;
  return `min(${max}, calc((min(100vw, 32rem) - 7rem) / ${perChar.toFixed(2)}))`;
}

const topLine: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  flexWrap: 'wrap',
};

const kicker: CSSProperties = {
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.125rem 0.625rem',
  borderRadius: 'var(--np-r-pill)',
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  lineHeight: 1.6,
};

const dot: CSSProperties = {
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '50%',
  background: 'currentColor',
};

const amountStyle: CSSProperties = {
  display: 'block',
  margin: '0.125rem 0',
  fontWeight: 700,
  lineHeight: 1.05,
  letterSpacing: '-0.04em',
  whiteSpace: 'nowrap',
};

const whenStyle: CSSProperties = {
  fontSize: '1.0625rem',
  fontWeight: 700,
  color: 'var(--np-text)',
  lineHeight: 1.3,
};

const metaStyle: CSSProperties = {
  fontSize: '0.9375rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};
