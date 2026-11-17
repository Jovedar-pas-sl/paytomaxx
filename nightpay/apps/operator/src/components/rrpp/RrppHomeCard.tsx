'use client';

import { useEffect, useState } from 'react';
import { useOpenCharges } from '@/lib/open-charges';
import { loadHomeUpcoming } from '@/lib/rrpp';
import { RrppHomeLink } from './RrppView';

/**
 * Cuántas reservas suyas vienen (null: no es RRPP, o aún no se sabe). Se usa
 * en Inicio, que sigue montado toda la sesión: la carta se monta de nuevo tras
 * cada cobro y, si preguntara ella, la tarjeta llegaría tarde y movería las
 * losetas bajo el dedo.
 */
export function useRrppUpcoming(): number | null {
  const [upcoming, setUpcoming] = useState<number | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    // Si falla, sin tarjeta: Inicio es para cobrar y la página /rrpp ya dice el error.
    loadHomeUpcoming(ctrl.signal).then(setUpcoming, () => undefined);
    return () => ctrl.abort();
  }, []);
  return upcoming;
}

/**
 * «Tus reservas de RRPP» arriba de la carta, solo a los RRPP de alta. Lleva a
 * otra página (la app se descarga): con un cobro o una recarga abiertos no
 * sale, como la «Guía rápida».
 */
export function RrppHomeCard({ upcoming }: { upcoming: number | null }) {
  const charges = useOpenCharges();
  if (upcoming === null || charges.open) return null;
  return <RrppHomeLink upcoming={upcoming} />;
}
