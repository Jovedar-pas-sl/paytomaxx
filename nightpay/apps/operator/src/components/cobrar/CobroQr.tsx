'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@nightpay/ui';

/**
 * El QR del cobro en vector (SVG), dibujado aquí a partir de su enlace de
 * pago: nítido a cualquier tamaño (el PNG de 320 px del API se veía borroso
 * al agrandarlo). Negro sobre blanco también a oscuras; el margen claro lo
 * pone la placa blanca de alrededor. Si el enlace no cabe en un QR (no
 * debería), el PNG del API.
 */
export function CobroQr({ value, fallbackPng, label }: { value: string | null; fallbackPng: string | null; label: string }) {
  const qr = useMemo(() => (value ? encodeQr(value) : null), [value]);
  if (!qr) return fallbackPng ? <img src={fallbackPng} alt={label} /> : null;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qrSvgPath(qr, 0)} fill="#0b0b0b" />
    </svg>
  );
}
