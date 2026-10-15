import type { CSSProperties } from 'react';
import { amountParts } from '../format';
import type { PaymentStatus } from './StatusPill';

interface AmountDisplayProps {
  amountCents: number;
  currency: string;
  status?: PaymentStatus;
}

export function AmountDisplay({ amountCents, currency, status = 'CREATED' }: AmountDisplayProps) {
  const amount = amountParts(amountCents, currency);

  const isAuthorizing = status === 'AUTHORIZING' || status === 'ORPHAN';
  const isFinal = status === 'AUTHORIZED';
  const isFailed = status === 'FAILED' || status === 'EXPIRED';

  const accent = isFinal
    ? 'var(--np-success)'
    : isFailed
      ? 'var(--np-danger)'
      : 'var(--np-text)';

  return (
    <div
      data-status={status}
      style={{
        ...wrap,
        transform: isFinal ? 'scale(0.92)' : 'scale(1)',
      }}
    >
      <div
        aria-hidden
        style={{
          ...halo,
          opacity: isAuthorizing ? 0.9 : isFinal ? 0.6 : 0.35,
          background: isFinal
            ? 'radial-gradient(circle, oklch(74% 0.18 145 / 0.45), transparent 60%)'
            : isFailed
              ? 'radial-gradient(circle, oklch(68% 0.22 25 / 0.4), transparent 60%)'
              : 'radial-gradient(circle, var(--np-glow), transparent 60%)',
        }}
      />

      {/* El lector de pantalla lee "48,50 €" de una vez, no los trozos. */}
      <span className="np-sr-only">{amount.text}</span>
      <div
        className="np-num"
        aria-hidden
        style={{
          ...amountWrap,
          color: accent,
          animation: isAuthorizing ? 'np-amount-breathe 1.6s ease-in-out infinite' : 'none',
        }}
      >
        <span style={{ fontSize: 'var(--np-t-amount)', fontWeight: 600, letterSpacing: '-0.04em' }}>
          {amount.whole}
        </span>
        {amount.fraction ? (
          <>
            <span style={separator}>{amount.decimal}</span>
            <span style={cents}>{amount.fraction}</span>
          </>
        ) : null}
        <span style={curr}>{amount.code}</span>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--np-s-6) 0',
  transition: 'transform var(--np-d-slow) var(--np-ease)',
};

const halo: CSSProperties = {
  position: 'absolute',
  inset: '-30%',
  pointerEvents: 'none',
  transition: 'opacity var(--np-d-slow) var(--np-ease), background var(--np-d-slow)',
  filter: 'blur(40px)',
  zIndex: 0,
};

const amountWrap: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.05em',
  fontFeatureSettings: '"tnum"',
  fontVariantNumeric: 'tabular-nums',
  transition: 'color var(--np-d-base)',
};

const separator: CSSProperties = {
  fontSize: 'calc(var(--np-t-amount) * 0.55)',
  fontWeight: 600,
  color: 'var(--np-text-dim)',
  margin: '0 0.05em',
};

const cents: CSSProperties = {
  fontSize: 'calc(var(--np-t-amount) * 0.45)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
};

const curr: CSSProperties = {
  fontSize: 'calc(var(--np-t-amount) * 0.22)',
  fontWeight: 500,
  marginLeft: '0.5em',
  color: 'var(--np-text-mute)',
  fontFamily: 'var(--np-font-sans)',
  letterSpacing: '0.05em',
};
