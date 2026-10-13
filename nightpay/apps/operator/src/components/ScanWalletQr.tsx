'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { walletCodeFromQr } from '@/lib/wallet-qr';

interface Props {
  onCode: (code: string) => void;
  onCancel: () => void;
}

/** Lector nativo de Chrome en Android; en iPhone no existe y se usa jsQR. */
interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => NativeBarcodeDetector;
type Decoder = (frame: HTMLCanvasElement) => Promise<string | null>;

const SCAN_EVERY_MS = 200;
const MAX_FRAME_WIDTH = 640;

/**
 * Escanea el QR de la página del saldo del cliente con la cámara trasera.
 * Solo acepta el QR del código (ver walletCodeFromQr); cualquier otro sigue
 * buscando.
 */
export function ScanWalletQr({ onCode, onCancel }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrongQr, setWrongQr] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este móvil no deja usar la cámara aquí. Teclea el código.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        setError('No se pudo abrir la cámara. Dale permiso o teclea el código.');
        return;
      }
      if (stopped || !video.current) {
        stop();
        return;
      }
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      const decode = await makeDecoder();

      const tick = async () => {
        if (stopped) return;
        const frame = grabFrame(video.current, canvas);
        if (frame) {
          const text = await decode(frame).catch(() => null);
          if (stopped) return;
          if (text) {
            const code = walletCodeFromQr(text);
            if (code) {
              stop();
              if ('vibrate' in navigator) navigator.vibrate(30);
              onCode(code);
              return;
            }
            setWrongQr(true);
          }
        }
        timer = setTimeout(() => void tick(), SCAN_EVERY_MS);
      };
      void tick();
    };

    void start();
    return stop;
    // Se abre una vez; onCode/onCancel no reinician la cámara.
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {error ? (
        <p style={errorStyle}>{error}</p>
      ) : (
        <div style={frameStyle}>
          <video ref={video} muted playsInline style={videoStyle} />
          <div style={targetStyle} aria-hidden="true" />
        </div>
      )}
      <p style={hintStyle}>
        {wrongQr ? 'Ese QR no es el del saldo. Apunta al QR de su página de saldo.' : 'Apunta al QR de la página de saldo del cliente.'}
      </p>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Teclear el código
      </Button>
    </div>
  );
}

async function makeDecoder(): Promise<Decoder> {
  const Native = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Native) {
    try {
      const detector = new Native({ formats: ['qr_code'] });
      return async (frame) => (await detector.detect(frame))[0]?.rawValue ?? null;
    } catch {
      // Sin soporte de QR en este navegador: jsQR.
    }
  }
  const { default: jsQR } = await import('jsqr');
  return async (frame) => {
    const ctx = frame.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, frame.width, frame.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

/** Fotograma del vídeo, reducido para que descifrar sea rápido. */
function grabFrame(el: HTMLVideoElement | null, canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  if (!el || el.readyState < 2 || !el.videoWidth) return null;
  const scale = Math.min(1, MAX_FRAME_WIDTH / el.videoWidth);
  canvas.width = Math.round(el.videoWidth * scale);
  canvas.height = Math.round(el.videoHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const frameStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '1 / 1',
  overflow: 'hidden',
  borderRadius: 'var(--np-r-lg)',
  background: '#000',
};

const videoStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const targetStyle: CSSProperties = {
  position: 'absolute',
  inset: '18%',
  border: '3px solid var(--np-accent)',
  borderRadius: 'var(--np-r-lg)',
  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.35)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
  textAlign: 'center',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  color: 'var(--np-danger)',
  textAlign: 'center',
};
