'use client';

import { useEffect, useState } from 'react';
import { useOpenCharges } from '@/lib/open-charges';
import { fetchMyPromoter } from '@/lib/rrpp';
import { RrppHomeLink } from './RrppView';

/**
 * «Tus reservas de RRPP» arriba de la carta, solo a los RRPP de alta. Lleva a
 * otra página (la app se descarga): con un cobro o una recarga abiertos no
 * sale, como la «Guía rápida».
 */
export function RrppHomeCard() {
  const [upcoming, setUpcoming] = useState<number | null>(null);
  const charges = useOpenCharges();

  useEffect(() => {
    const ctrl = new AbortController();
    // Si falla, sin tarjeta: Inicio es para cobrar y la página /rrpp ya dice el error.
    fetchMyPromoter(ctrl.signal).then(
      (view) => setUpcoming(view ? view.upcoming.length : null),
      () => undefined,
    );
    return () => ctrl.abort();
  }, []);

  if (upcoming === null || charges.open) return null;
  return <RrppHomeLink upcoming={upcoming} />;
}
