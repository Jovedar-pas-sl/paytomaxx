'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@nightpay/ui';
import s from './desk.module.css';

/** Margen blanco alrededor (la norma pide 4 módulos para que se lea bien). */
const QUIET_ZONE = 4;

interface Props {
  value: string;
  label: string;
  small?: boolean;
  /** El PNG que da el API, por si el enlace no cupiera en un QR (no pasa con los nuestros). */
  fallbackSrc?: string;
}

/**
 * Un QR de un enlace nuestro, en vector (nítido a cualquier tamaño, también
 * el del cobro de la recarga): negro sobre blanco también en el tema oscuro,
 * en la caja blanca de 4.7. `small`: el de «Activar Face ID» en CARGADO.
 */
export function QrBox({ value, label, small = false, fallbackSrc }: Props) {
  const qr = useMemo(() => encodeQr(value), [value]);
  const box = `${s.qr} ${small ? s.qrSmall : ''}`;
  if (!qr) {
    return fallbackSrc ? (
      <div className={box}>
        <img src={fallbackSrc} alt={label} />
      </div>
    ) : null;
  }
  const side = qr.size + QUIET_ZONE * 2;
  return (
    <div className={box}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" width="100%" height="100%">
        <rect width={side} height={side} fill="#ffffff" />
        <path d={qrSvgPath(qr, QUIET_ZONE)} fill="#0b0b0b" />
      </svg>
    </div>
  );
}
