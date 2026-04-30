import type { CSSProperties } from 'react';

interface LogoProps {
  /** Image height in CSS units. Default 2rem. */
  height?: string | number;
  /** Path to the logo image relative to the app's `public/` dir. Default '/brand/logo.png'. */
  src?: string;
  /** Alt text. Default 'dinero sin riesgos'. */
  alt?: string;
  /**
   * If true, wrap the logo in a subtle light backdrop so the dark text
   * inside the logo stays readable on a dark theme. Defaults to true.
   */
  adaptiveBackdrop?: boolean;
}

export function Logo({
  height = '2rem',
  src = '/brand/logo.png',
  alt = 'dinero sin riesgos',
  adaptiveBackdrop = true,
}: LogoProps) {
  const h = typeof height === 'number' ? `${height}px` : height;
  return (
    <span
      className={adaptiveBackdrop ? 'np-logo-bg' : undefined}
      style={{ ...wrap, height: `calc(${h} + 0.75rem)` }}
    >
      <img
        src={src}
        alt={alt}
        style={{ height: h, width: 'auto', display: 'block' }}
        decoding="async"
      />
    </span>
  );
}

const wrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--np-r-md)',
  transition: 'background var(--np-d-base), padding var(--np-d-base)',
  flexShrink: 0,
};
