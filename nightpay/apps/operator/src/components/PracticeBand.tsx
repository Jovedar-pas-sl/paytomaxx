'use client';

import type { CSSProperties } from 'react';
import { PRACTICE_BAND_TEXT, usePractice } from '@/lib/practice';

/** Lo que mide la franja (sin la muesca de arriba): el contenido y los overlays se bajan esto. */
const BAND_CSS = ':root{--np-practice-h:calc(2.5rem + env(safe-area-inset-top,0px))}body{padding-top:var(--np-practice-h)}';

/** La franja fija de arriba mientras se practica. Solo se pinta con `on`. */
export function PracticeBandView({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <>
      {/* Baja todo el contenido lo que mide la franja: no tapa ningún botón. */}
      <style>{BAND_CSS}</style>
      <div role="status" style={band} data-practice-band="">
        {PRACTICE_BAND_TEXT}
      </div>
    </>
  );
}

/** En el layout: la franja según el estado de la práctica de este móvil. */
export function PracticeBand() {
  return <PracticeBandView on={usePractice()} />;
}

// Ámbar de aviso (nunca lima, que es la marca): la letra con el fondo de la app para contrastar en claro y oscuro.
const band: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 1000,
  boxSizing: 'border-box',
  height: 'var(--np-practice-h)',
  paddingTop: 'env(safe-area-inset-top, 0px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--np-warning)',
  color: 'var(--np-bg)',
  font: '700 0.9375rem/1.2 var(--np-font-sans)',
  letterSpacing: '0.02em',
  textAlign: 'center',
  paddingInline: '0.75rem',
};
