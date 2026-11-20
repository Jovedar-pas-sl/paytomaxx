'use client';

import { useEffect, useState } from 'react';

/** Lo que tarda en fundirse el símbolo (styles.css, .np-splash). */
const FADE_MS = 200;

/**
 * El símbolo de la app al abrirla: centrado sobre el fondo, como mucho ~700 ms
 * (el CSS lo funde solo a los 500 ms) y antes si la app ya está lista (cuando
 * esto se hidrata). Va en el layout raíz, así que solo sale al abrir la app,
 * no al navegar dentro. Nunca recoge toques; con «reducir movimiento» no sale.
 */
export function BrandSplash({ src = '/icons/icon-512.png' }: { src?: string }) {
  const [phase, setPhase] = useState<'show' | 'ready' | 'gone'>('show');
  useEffect(() => {
    setPhase('ready');
    const t = setTimeout(() => setPhase('gone'), FADE_MS);
    return () => clearTimeout(t);
  }, []);
  if (phase === 'gone') return null;
  return (
    <div className="np-splash" data-ready={phase === 'ready' ? '' : undefined} aria-hidden="true">
      <img src={src} alt="" width={112} height={112} decoding="async" />
    </div>
  );
}
