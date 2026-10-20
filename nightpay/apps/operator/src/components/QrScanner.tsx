'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** Lo mínimo de BarcodeDetector (Chrome en Android); en iPhone aún no existe. */
interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

export function qrScanSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

const SCAN_EVERY_MS = 250;

/** La cámara de atrás leyendo QR (BarcodeDetector). Llama a onScan con el primero que lee. */
export function QrScanner({ onScan, onError }: { onScan: (text: string) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const done = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      onError('Este móvil no lee QR desde la app: usa la cámara del móvil.');
      return undefined;
    }
    const detector = new Ctor({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play();
        setReady(true);
        timer = setInterval(() => {
          if (done.current || !video.current) return;
          detector
            .detect(video.current)
            .then((codes) => {
              const first = codes[0]?.rawValue;
              if (first && !done.current) {
                done.current = true;
                onScan(first);
              }
            })
            .catch(() => undefined);
        }, SCAN_EVERY_MS);
      })
      .catch(() => onError('Sin permiso para la cámara: dale permiso o usa la cámara del móvil.'));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan, onError]);

  return (
    <div style={box}>
      <video ref={video} muted playsInline style={videoStyle} aria-label="Cámara para leer el QR" />
      {!ready ? <p style={hint}>Abriendo la cámara…</p> : null}
    </div>
  );
}

const box: CSSProperties = { position: 'relative', borderRadius: 'var(--np-r-lg)', overflow: 'hidden', background: '#000' };
const videoStyle: CSSProperties = { display: 'block', width: '100%', maxHeight: '50vh', objectFit: 'cover' };
const hint: CSSProperties = {
  position: 'absolute',
  inset: 0,
  margin: 0,
  display: 'grid',
  placeItems: 'center',
  color: '#fff',
  fontWeight: 600,
};
