'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { staffTokenFrom } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import { onInviteArrived, takePendingInvite } from '@/lib/invite-link';
import { resolveStaffQr } from '@/lib/api-cobro';
import { rejectedQr, shouldResolveQr, statusOf, type RejectedQr } from '@/lib/qr-scan';
import { colorOf, puestoChip, type CobrarContext } from './cobrar-context';
import { IconCheck, IconFlash } from './icons';
import { Chip, ScreenHeader, Stripe } from './ScreenHeader';
import styles from './cobrar.module.css';

/** La chica leída (o elegida): con su QR o con su id, y su nombre. */
export interface Invitada {
  name: string;
  token?: string;
  id?: string;
}

interface Props {
  ctx: CobrarContext;
  who: string;
  /** La invitación de la carta que se cobra («Copa con invitación»). */
  title: string;
  priceCents: number;
  /** Abre el cobro de la invitación: false si no se abrió (sin red, o aún se cancela una de antes). */
  onChica: (chica: Invitada) => Promise<boolean>;
  /** «Elegir de la lista» (solo si el local no pide el QR). */
  onList?: () => void;
  onBack: () => void;
}

/** Lo mínimo de BarcodeDetector (Chrome en Android); en iPhone aún no existe. */
interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const SCAN_EVERY_MS = 250;
/** «Nerea reconocida» se ve un momento antes de pasar al cobro. */
const SEEN_MS = 700;

function detectorCtor(): DetectorCtor | null {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  return (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector ?? null;
}

/**
 * «Escanea el QR de la chica» (maqueta 2.2), al tocar «Copa con invitación»:
 * la cámara del camarero lee el «Mi QR» del móvil de la chica y la reconoce
 * sola; pasa al cobro sin tocar nada. Linterna para la sala oscura y, si el
 * local lo deja, la lista. Un QR rechazado no se vuelve a mandar mientras
 * siga delante de la cámara (lib/qr-scan) y, si se sale antes de pasar al
 * cobro («Atrás»), no se cobra nada. Si el cobro no se abre (sin red), se
 * vuelve a leer.
 */
export function EscanearChica({ ctx, who, title, priceCents, onChica, onList, onBack }: Props) {
  const video = useRef<HTMLVideoElement | null>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const done = useRef(false);
  /** El último QR que no valió: no se vuelve a preguntar por él mientras siga delante. */
  const rejected = useRef<RejectedQr | null>(null);
  /** «Nerea reconocida» → al cobro: se cancela si se sale antes. */
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const supported = detectorCtor() !== null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (leaving.current) clearTimeout(leaving.current);
      leaving.current = null;
    };
  }, []);

  const take = useCallback(
    async (raw: string) => {
      // Uno a la vez (la cámara y el enlace del móvil pueden llegar juntos); reconocida, ya no se lee más.
      if (done.current) return;
      done.current = true;
      const token = staffTokenFrom(raw);
      if (!token) {
        rejected.current = rejectedQr(raw, 400, Date.now());
        setProblem('Ese QR no es el de una chica. Que abra «Mi QR» en su app.');
        done.current = false;
        return;
      }
      try {
        const chica = await resolveStaffQr(token);
        if (!alive.current) return;
        setSeen(chica.name);
        setProblem(null);
        if ('vibrate' in navigator) navigator.vibrate(30);
        leaving.current = setTimeout(() => {
          leaving.current = null;
          if (!alive.current) return;
          void onChica({ name: chica.name, token, id: chica.id }).then((opened) => {
            if (opened || !alive.current) return;
            // Sin cobro: se vuelve a leer (el error lo enseña el cobro), sin repetir este QR enseguida.
            rejected.current = rejectedQr(raw, 0, Date.now());
            setSeen(null);
            done.current = false;
          });
        }, SEEN_MS);
      } catch (err) {
        if (!alive.current) return;
        rejected.current = rejectedQr(raw, statusOf(err), Date.now());
        setProblem((err as Error).message);
        done.current = false;
      }
    },
    [onChica],
  );

  // Leído con la cámara del móvil (abre otra pestaña): llega aquí solo.
  useEffect(() => {
    const pending = takePendingInvite();
    if (pending) void take(pending);
    return onInviteArrived((token) => void take(token));
  }, [take]);

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) return undefined;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const detector = new Ctor({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        track.current = s.getVideoTracks()[0] ?? null;
        const caps = track.current?.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorchOk(Boolean(caps?.torch));
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
              if (first && !done.current && shouldResolveQr(first, rejected.current, Date.now())) void take(first);
            })
            .catch(() => undefined);
        }, SCAN_EVERY_MS);
      })
      .catch(() => setProblem('Sin permiso para la cámara: dale permiso o usa la cámara del móvil.'));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      track.current = null;
    };
  }, [take]);

  async function toggleTorch() {
    const t = track.current;
    if (!t) return;
    const next = !torch;
    try {
      await t.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch(next);
    } catch {
      setTorchOk(false);
    }
  }

  const chip = puestoChip(ctx);
  return (
    <div className={styles.screen}>
      <ScreenHeader
        title={title}
        subtitle={`${who.split(' · ')[0]} · ${formatEur(priceCents, { compact: true })}`}
        onBack={onBack}
        chip={chip ? <Chip colors={[chip.color]}>{chip.label}</Chip> : null}
      />
      <Stripe parts={[{ color: colorOf('VENUE_BAR'), weight: 1 }]} />
      <div className={styles.cam}>
        <h2 className={styles.camTitle}>Escanea el QR de la chica</h2>
        <div className={styles.vf}>
          <i />
          <i />
          <i />
          <i />
          {supported ? (
            <video ref={video} className={styles.vfVideo} muted playsInline aria-label="Cámara para leer el QR de la chica" />
          ) : null}
          {!supported ? (
            <p className={styles.vfHint}>Abre la cámara del móvil y apunta a su QR: la invitación llega aquí sola.</p>
          ) : !ready ? (
            <p className={styles.vfHint}>Abriendo la cámara…</p>
          ) : null}
        </div>
        {seen ? (
          <p className={styles.seen} role="status">
            <IconCheck />
            <b>{seen}</b>
            <span>reconocida</span>
          </p>
        ) : problem ? (
          <p role="alert" className={styles.seen} style={{ background: 'var(--np-outcome-failed)' }}>
            {problem}
          </p>
        ) : null}
      </div>
      <div className={styles.camFoot}>
        <button
          type="button"
          className={styles.torch}
          onClick={() => void toggleTorch()}
          disabled={!torchOk}
          aria-pressed={torch}
          aria-label={torch ? 'Apagar la linterna' : 'Encender la linterna'}
        >
          <IconFlash />
        </button>
        {onList ? (
          <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={onList}>
            Elegir de la lista
          </button>
        ) : (
          <p className={styles.muted} style={{ flex: 1, color: 'var(--np-text-label)', fontSize: '0.9375rem' }}>
            En su app: «Mi QR».
          </p>
        )}
      </div>
    </div>
  );
}
