'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@nightpay/ui';

/**
 * El QR del cobro en vector (SVG), dibujado aquí a partir de su enlace de
 * pago: nítido a cualquier tamaño (el PNG de 320 px del API se veía borroso
 * al agrandarlo). Negro sobre blanco también a oscuras. El margen claro lo
 * pone la placa blanca de alrededor o, si es estrecha, `quiet` (en módulos,
 * dentro del dibujo). Si el enlace no cabe en un QR (no debería), el PNG del API.
 */
export function CobroQr({
  value,
  fallbackPng,
  label,
  quiet = 0,
}: {
  value: string | null;
  fallbackPng: string | null;
  label: string;
  quiet?: number;
}) {
  const qr = useMemo(() => (value ? encodeQr(value) : null), [value]);
  if (!qr) return fallbackPng ? <img src={fallbackPng} alt={label} style={{ display: 'block', width: '100%' }} /> : null;
  const side = qr.size + quiet * 2;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} width="100%" shapeRendering="crispEdges">
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrSvgPath(qr, quiet)} fill="#0b0b0b" />
    </svg>
  );
}
