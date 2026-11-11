'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, haptic, Input } from '@nightpay/ui';
import {
  confirmPosPayment,
  fetchPendingPos,
  fetchZones,
  pollErrorText,
  SessionExpiredError,
  type PendingPosPayment,
  type ZoneOption,
} from '@/lib/api';
import { isAlertSoundMuted, playAlertBeep, setAlertSoundMuted } from '@/lib/alert-sound';
import { formatEur, formatEurAmount } from '@/lib/money';
import { posChargeLine, posConfirmBody } from '@/lib/cobro-view';
import { newArrivals } from '@/lib/pending-pos';
import { usePolling } from '@/lib/use-polling';

interface Props {
  onConfirmed: () => void;
  /** Si viene de un deep-link (?pos=<id> tras escanear QR), pre-selecciona ese cobro. */
  focusPaymentId?: string | null;
  /** Ya se abrió el cobro del enlace: "← Lista" no lo vuelve a abrir en el siguiente refresco. */
  onFocusConsumed?: () => void;
}

/**
 * Pantalla para el camarero (rol WAITER/MANAGER/OWNER).
 *
 * Flow:
 *   1. La chica creó un Cobro POS desde su app → quedó en CREATED con
 *      captureMethod=POS_EXTERNAL.
 *   2. El camarero ve aquí la lista de POS pendientes (auto-refresh 5s).
 *   3. La chica le pasa el código verbal "#A4B7E2".
 *   4. El camarero procesa el cobro en el datáfono del bar (Redsys/SumUp/etc).
 *   5. Cliente paga con su tarjeta en el datáfono.
 *   6. Camarero pulsa "Confirmar pagado" → opcionalmente pega ref del recibo
 *      → confirma. NightPay marca AUTHORIZED + crea comisión chica auto.
 *
 * Importante: el camarero NUNCA procesa el cobro en NightPay — el dinero
 * pasa por el PSP del bar (datáfono físico). NightPay solo registra la
 * transacción para repartir comisión a la chica.
 */
export function PendingPos({ onConfirmed, focusPaymentId, onFocusConsumed }: Props) {
  const [pending, setPending] = useState<PendingPosPayment[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  // 'all' = sin filtro; canonical zone otherwise. El ref es la zona que vale
  // ahora mismo: una respuesta de otra zona que llega tarde se descarta.
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const zoneRef = useRef('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PendingPosPayment | null>(null);
  // M3: sound + vibrate cuando llega un cobro pendiente nuevo. Sin esto
  // el camarero tiene que mirar la pantalla constantemente.
  // Mute state persiste en localStorage para que cada usuario decida.
  const [muted, setMuted] = useState(isAlertSoundMuted);
  // IDs ya vistos (null: aún no hay primera carga de esta zona).
  const seenIds = useRef<Set<string> | null>(null);

  function alertNew(): void {
    if (muted) return;
    playAlertBeep();
    if ('vibrate' in navigator) navigator.vibrate([100, 50, 150]);
  }

  function toggleMute(): void {
    const next = !muted;
    setMuted(next);
    setAlertSoundMuted(next);
  }

  // Cada vuelta usa el estado de ahora (usePolling): zona, silencio y seleccionado.
  const refresh = usePolling(
    async (signal) => {
      const filter = zoneRef.current;
      try {
        const list = await fetchPendingPos(filter === 'all' ? undefined : filter, signal);
        // Respuesta de la zona anterior: ni se pinta ni quita el "Cargando…".
        if (filter !== zoneRef.current) return;
        const arrivals = newArrivals(seenIds.current, list.map((p) => p.id));
        seenIds.current = arrivals.seen;
        if (arrivals.hasNew) alertNew();
        // El seleccionado que ya no está (cancelado, caducado o confirmado por
        // otro) no se cierra: el camarero puede estar tecleando su código; se avisa.
        setPending(list);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (signal.aborted) return 'slow';
        setError(pollErrorText(err));
        setLoading(false);
        return err instanceof SessionExpiredError ? 'stop' : 'slow';
      }
    },
    { intervalMs: POLL_MS },
  );

  useEffect(() => {
    fetchZones()
      .then((zs) => setZones(zs.filter((z) => z.activeCount > 0)))
      .catch(() => {
        /* zonas opcional */
      });
  }, []);

  // Deep-link: cuando llega un focusPaymentId y la lista ya cargó, pre-selecciona
  // una sola vez. Si todavía no está en la lista (acaba de crearse), en el siguiente refresco.
  useEffect(() => {
    if (!focusPaymentId) return;
    const match = pending.find((p) => p.id === focusPaymentId);
    if (match) {
      setSelected(match);
      onFocusConsumed?.();
    }
  }, [focusPaymentId, pending, onFocusConsumed]);

  function changeZone(z: string): void {
    zoneRef.current = z;
    seenIds.current = null; // lo que ya hay en la otra zona no avisa
    setZoneFilter(z);
    setPending([]);
    setLoading(true);
    refresh();
  }

  if (selected) {
    return (
      <ConfirmForm
        payment={selected}
        gone={!loading && !pending.some((p) => p.id === selected.id)}
        onBack={() => setSelected(null)}
        onConfirmed={() => {
          setSelected(null);
          refresh();
          onConfirmed();
        }}
      />
    );
  }

  return (
    <Card style={{ padding: '1.25rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div style={{ flex: 1 }}>
          <h3 style={titleStyle}>POS pendientes</h3>
          <p style={hintStyle}>
            Cobros que las chicas crearon y esperan que tú los proceses en el datáfono.
            Cuando cobres en el datáfono, vuelve aquí y toca el cobro para confirmar.
          </p>
        </div>
        <Button
          variant="ghost"
          size="md"
          onClick={toggleMute}
          aria-label={muted ? 'Activar sonido de alerta' : 'Silenciar alerta'}
          aria-pressed={muted}
          style={muteBtnStyle}
        >
          <BellIcon muted={muted} />
        </Button>
      </div>

      {zones.length > 1 ? (
        <div style={zoneTabsStyle}>
          <button
            type="button"
            onClick={() => changeZone('all')}
            aria-pressed={zoneFilter === 'all'}
            style={{
              ...zoneTabStyle,
              ...(zoneFilter === 'all' ? zoneTabActiveStyle : {}),
            }}
          >
            Todas
          </button>
          {zones.map((z) => (
            <button
              key={z.zone}
              type="button"
              onClick={() => changeZone(z.zone)}
              aria-pressed={zoneFilter === z.zone}
              style={{
                ...zoneTabStyle,
                ...(zoneFilter === z.zone ? zoneTabActiveStyle : {}),
              }}
            >
              {z.zoneDisplay}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}

      {loading && pending.length === 0 ? (
        <p style={emptyStyle}>Cargando…</p>
      ) : pending.length === 0 ? (
        <div style={emptyStateStyle}>
          <p style={{ margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
            ✓ No hay cobros POS pendientes.
          </p>
        </div>
      ) : (
        <ul style={listStyle}>
          {pending.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p)}
                style={itemStyle}
                type="button"
              >
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <p style={refStyle}>
                    #{p.refCode}
                    {p.zone ? <span style={zoneBadgeStyle}>{zoneToDisplay(p.zone)}</span> : null}
                  </p>
                  <p style={metaStyle}>
                    Chica: {p.createdByName} · {timeAgo(p.createdAt)}
                  </p>
                </div>
                <p className="np-num" style={amountStyle}>
                  {formatEurAmount(p.amountCents)}
                  <span style={{ fontSize: 'var(--np-t-label)', color: 'var(--np-text-mute)' }}> €</span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const POLL_MS = 5000;

function ConfirmForm({
  payment,
  gone,
  onBack,
  onConfirmed,
}: {
  payment: PendingPosPayment;
  /** Ya no está en la lista de pendientes (cancelado, caducado o confirmado por otro). */
  gone: boolean;
  onBack: () => void;
  onConfirmed: () => void;
}) {
  const photoInputId = useId();
  const [posRef, setPosRef] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePhotoCapture(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    // Comprimimos a JPEG ~70% calidad para evitar payloads enormes.
    try {
      const compressed = await compressImage(file, 800, 0.7);
      if (compressed.length > 480_000) {
        setError('Foto demasiado grande tras comprimir. Toma una desde más lejos.');
        return;
      }
      setPhoto(compressed);
      setError(null);
    } catch {
      setError('No se pudo procesar la foto');
    }
  }

  async function handleConfirm(): Promise<void> {
    const ref = posRef.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(ref)) {
      setError('Teclea el código de autorización del ticket: 6 letras o números.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      haptic();
      // Lo cobrado (el total de la lista, con la comisión del servicio): sin ello, el API no confirma.
      await confirmPosPayment(payment.id, posConfirmBody(payment, ref, photo));
      onConfirmed();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ padding: '1.25rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={titleStyle}>Confirmar cobro POS</h3>
          <p style={hintStyle}>#{payment.refCode}</p>
        </div>
        <button onClick={onBack} type="button" style={backBtnStyle}>← Lista</button>
      </div>

      {gone ? (
        <p role="alert" style={goneStyle}>
          Este cobro ya no está pendiente. Si ya lo cobraste en el datáfono, avisa al encargado.
        </p>
      ) : null}

      <div style={confirmPillStyle}>
        <span style={kickerStyle}>⚠️ Teclea EXACTAMENTE en el datáfono</span>
        <p className="np-num" style={amountBigStyle}>
          {formatEurAmount(payment.amountCents)} <span style={currStyle}>EUR</span>
        </p>
        <p style={amountDigitsStyle}>
          {/* Importe deletreado dígito-a-dígito para evitar typos visuales en el IM30 */}
          {(payment.amountCents / 100)
            .toFixed(2)
            .split('')
            .map((c) => (c === '.' ? '·' : c))
            .join(' ')}
        </p>
        {payment.serviceFeeCents ? (
          <p style={{ margin: '0.25rem 0 0', fontSize: 'var(--np-t-label)', color: 'var(--np-text-mute)' }}>
            {posChargeLine(payment)}
          </p>
        ) : null}
        <p style={{ margin: '0.25rem 0 0', fontSize: 'var(--np-t-label)', color: 'var(--np-text-mute)' }}>
          Chica: {payment.createdByName}
        </p>
      </div>

      <div style={stepsBox}>
        <p style={{ margin: 0, fontSize: 'var(--np-fs-14)', fontWeight: 500, marginBottom: '0.5rem' }}>
          Pasos:
        </p>
        <ol style={stepsListStyle}>
          <li>{payment.serviceFeeCents ? posChargeLine(payment) : `Cobra ${formatEur(payment.amountCents)}`} en el datáfono del bar.</li>
          <li>Cliente paga con su tarjeta.</li>
          <li><strong>Teclea el código de autorización</strong> del ticket (6 caracteres, pone "AUT" o "Nº autorización").</li>
          <li>Foto del ticket (opcional pero recomendado).</li>
          <li>Toca "Confirmar pagado" abajo.</li>
        </ol>
      </div>

      <Input
        label="Código de autorización del ticket *"
        value={posRef}
        onChange={(e) => setPosRef(e.target.value)}
        placeholder="ej: 047215"
        maxLength={8}
        autoCapitalize="characters"
        disabled={submitting}
        required
      />

      <div>
        <label
          htmlFor={photoInputId}
          style={{
            display: 'block',
            fontSize: 'var(--np-fs-14)',
            fontWeight: 500,
            marginBottom: '0.375rem',
            color: 'var(--np-text)',
          }}
        >
          Foto del ticket (opcional)
        </label>
        <input
          id={photoInputId}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhotoCapture}
          disabled={submitting}
          style={{ fontSize: 'var(--np-fs-14)' }}
        />
        {photo ? (
          <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <img
              src={photo}
              alt="ticket"
              style={{
                width: '80px',
                height: '80px',
                objectFit: 'cover',
                borderRadius: 'var(--np-r-sm)',
                border: '1px solid var(--np-border)',
              }}
            />
            <button
              type="button"
              onClick={() => setPhoto(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--np-text-mute)',
                cursor: 'pointer',
                fontSize: 'var(--np-fs-14)',
              }}
            >
              Quitar
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}

      <Button onClick={handleConfirm} loading={submitting} size="lg">
        ✓ Confirmar pagado en el datáfono
      </Button>

      <p style={{ ...hintStyle, textAlign: 'center', marginTop: 0 }}>
        Solo confirma si el datáfono dio aprobación. Si rechazó, vuelve atrás y
        avisa a la chica para que cancele.
      </p>
    </Card>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `hace ${hrs}h ${mins % 60}m`;
}

/**
 * Comprime una imagen a JPEG con max dimension `maxW` y calidad `quality` (0-1).
 * Devuelve un data URL. Funciona offline (canvas browser, no server).
 */
async function compressImage(file: File, maxW: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // La foto original en memoria se suelta en cuanto se ha leído.
    const src = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(src);
      const ratio = Math.min(maxW / img.width, maxW / img.height, 1);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas not supported'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('image load failed'));
    };
    img.src = src;
  });
}

function zoneToDisplay(zone: string): string {
  if (zone.startsWith('OTRO/')) {
    const c = zone.slice('OTRO/'.length);
    return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
  }
  return zone.charAt(0).toUpperCase() + zone.slice(1).toLowerCase();
}

const zoneTabsStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.375rem',
  padding: '0.375rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
};

const zoneTabStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: '4rem',
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text-mute)',
  fontSize: 'var(--np-fs-14)',
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const zoneTabActiveStyle: CSSProperties = {
  background: 'var(--np-chosen)',
  color: 'var(--np-on-chosen)',
  fontWeight: 600,
};

const zoneBadgeStyle: CSSProperties = {
  marginLeft: '0.5rem',
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
  fontSize: 'var(--np-t-label)',
  fontWeight: 500,
  fontFamily: 'var(--np-font-sans)',
  letterSpacing: '0.02em',
  verticalAlign: 'middle',
};

const goneStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 0.875rem',
  border: '1px solid var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-warning)',
  fontWeight: 600,
  fontSize: 'var(--np-fs-16)',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-16)',
  fontWeight: 600,
};

const hintStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-danger)',
};

const emptyStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
  textAlign: 'center',
};

const emptyStateStyle: CSSProperties = {
  padding: '1.5rem 1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px dashed var(--np-border)',
  textAlign: 'center',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const itemStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.875rem 1rem',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: 'var(--np-text)',
};

const refStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-18)',
  fontWeight: 700,
  fontFamily: 'var(--np-font-mono, monospace)',
  letterSpacing: '0.1em',
  color: 'var(--np-text)',
};

const metaStyle: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const amountStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-22)',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

// 44 px de alto para el dedo, 14 px como mínimo (personal).
const backBtnStyle: CSSProperties = {
  minHeight: '2.75rem',
  padding: '0 0.75rem',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text-mute)',
  fontSize: 'var(--np-fs-14)',
  fontWeight: 500,
  cursor: 'pointer',
};

const amountDigitsStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-fs-16)',
  fontFamily: 'var(--np-font-mono)',
  letterSpacing: '0.3em',
  color: 'var(--np-warning, #b45309)',
  textAlign: 'center' as const,
  fontWeight: 600,
};

// La campana: un botón secundario cuadrado de 48 px (Button md en táctil), sin emoji.
const muteBtnStyle: CSSProperties = {
  width: '3rem',
  padding: 0,
  flexShrink: 0,
};

/** La campana (con una raya, silenciada): SVG que hereda el color del botón. */
function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 004 0" />
      {muted ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

const confirmPillStyle: CSSProperties = {
  padding: '1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
  alignItems: 'center',
};

const kickerStyle: CSSProperties = {
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

const amountBigStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-40)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

const currStyle: CSSProperties = {
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
};

const stepsBox: CSSProperties = {
  padding: '0.75rem 1rem',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};

const stepsListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  fontSize: 'var(--np-fs-14)',
  lineHeight: 1.6,
};
