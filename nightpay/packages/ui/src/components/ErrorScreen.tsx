'use client';

import type { CSSProperties } from 'react';
import { Button } from './Button';

interface Props {
  title: string;
  detail: string;
  /** El único botón: volver a lo que se estaba haciendo (recarga la app ahí). */
  actionLabel: string;
  onAction: () => void;
}

/**
 * La pantalla de fallo (error.tsx y global-error.tsx de cada app): antes, un
 * fallo de pantalla dejaba el mensaje genérico de Next y nadie sabía qué hacer.
 * Un título, qué pasa con lo que estaba a medias y un solo botón.
 */
export function ErrorScreen({ title, detail, actionLabel, onAction }: Props) {
  return (
    <main role="alert" style={wrap}>
      <div style={mark} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 7v6" />
          <path d="M12 17h.01" />
          <circle cx="12" cy="12" r="10" />
        </svg>
      </div>
      <h1 style={titleStyle}>{title}</h1>
      <p style={detailStyle}>{detail}</p>
      <Button size="lg" onClick={onAction} style={{ width: '100%', maxWidth: '22rem' }}>
        {actionLabel}
      </Button>
    </main>
  );
}

const wrap: CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  padding: '1.5rem 1rem',
  textAlign: 'center',
  background: 'var(--np-bg)',
  color: 'var(--np-text)',
};

const mark: CSSProperties = {
  width: '4rem',
  height: '4rem',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 'var(--np-r-pill)',
  boxShadow: 'inset 0 0 0 1px var(--np-border-hi)',
  color: 'var(--np-warning)',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 600 };

const detailStyle: CSSProperties = {
  margin: '0 0 0.5rem',
  maxWidth: '26rem',
  fontSize: '1rem',
  lineHeight: 1.5,
  color: 'var(--np-text-mute)',
};
