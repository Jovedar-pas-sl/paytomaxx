'use client';

import type { CSSProperties } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

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
    <main style={wrap}>
      <div role="alert" style={alertBox}>
      <div style={mark} aria-hidden="true">
        <Icon name="alert" size={28} />
      </div>
      <h1 style={titleStyle}>{title}</h1>
      <p style={detailStyle}>{detail}</p>
      </div>
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

// Lo que se anuncia (marca, título y qué pasa), en su caja: el lector no lee el botón como aviso.
const alertBox: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' };

const mark: CSSProperties = {
  width: '4rem',
  height: '4rem',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 'var(--np-r-pill)',
  boxShadow: 'inset 0 0 0 1px var(--np-border-hi)',
  color: 'var(--np-warning)',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 600 };

const detailStyle: CSSProperties = {
  margin: '0 0 0.5rem',
  maxWidth: '26rem',
  fontSize: 'var(--np-fs-16)',
  lineHeight: 1.5,
  color: 'var(--np-text-mute)',
};
