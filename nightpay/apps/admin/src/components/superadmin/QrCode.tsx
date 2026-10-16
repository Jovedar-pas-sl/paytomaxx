'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@/lib/superadmin/qr';

/** Margen blanco alrededor (la norma pide 4 módulos para que se lea bien). */
const QUIET_ZONE = 4;

/**
 * QR en SVG: negro sobre blanco en los dos temas (un QR claro sobre oscuro no
 * lo leen todos los móviles).
 */
export function QrCode({ value, label, size = 240 }: { value: string; label: string; size?: number }) {
  const qr = useMemo(() => encodeQr(value), [value]);
  if (!qr) return null;
  const side = qr.size + QUIET_ZONE * 2;
  return (
    <svg
      className="np-sa-qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrSvgPath(qr, QUIET_ZONE)} fill="#0b0b0b" />
    </svg>
  );
}
