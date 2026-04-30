import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

type CardVariant = 'default' | 'elevated' | 'glow';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  children: ReactNode;
}

export function Card({ variant = 'default', children, style, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      data-variant={variant}
      style={{ ...base, ...variantStyles[variant], ...style }}
    >
      {variant === 'glow' ? <GlowBorder /> : null}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}

const base: CSSProperties = {
  position: 'relative',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-lg)',
  padding: 'var(--np-s-5)',
  isolation: 'isolate',
};

const variantStyles: Record<CardVariant, CSSProperties> = {
  default: {},
  elevated: {
    background: 'var(--np-surface-2)',
    borderColor: 'var(--np-border-hi)',
  },
  glow: {
    background: 'var(--np-surface)',
    borderColor: 'transparent',
  },
};

function GlowBorder() {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        padding: '1px',
        background:
          'linear-gradient(135deg, var(--np-glow), transparent 45%, var(--np-border) 100%)',
        WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
        WebkitMaskComposite: 'xor',
        maskComposite: 'exclude',
        pointerEvents: 'none',
      }}
    />
  );
}
