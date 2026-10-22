'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@nightpay/ui';
import s from './desk.module.css';

/** Margen blanco alrededor (la norma pide 4 módulos para que se lea bien). */
const QUIET_ZONE = 4;

/**
 * Un QR de un enlace nuestro (el API da solo el enlace): negro sobre blanco
 * también en el tema oscuro, en la caja blanca de 4.7. `small`: el de
 * «Activar Face ID» en CARGADO.
 */
export function QrBox({ value, label, small = false }: { value: string; label: string; small?: boolean }) {
  const qr = useMemo(() => encodeQr(value), [value]);
  if (!qr) return null;
  const side = qr.size + QUIET_ZONE * 2;
  return (
    <div className={`${s.qr} ${small ? s.qrSmall : ''}`}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" width="100%" height="100%">
        <rect width={side} height={side} fill="#ffffff" />
        <path d={qrSvgPath(qr, QUIET_ZONE)} fill="#0b0b0b" />
      </svg>
    </div>
  );
}
