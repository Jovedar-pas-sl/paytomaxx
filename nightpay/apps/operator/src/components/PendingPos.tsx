'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import {
  confirmPosPayment,
  fetchPendingPos,
  fetchZones,
  type PendingPosPayment,
  type ZoneOption,
} from '@/lib/api';

interface Props {
  onConfirmed: () => void;
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
export function PendingPos({ onConfirmed }: Props) {
  const [pending, setPending] = useState<PendingPosPayment[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  // 'all' = sin filtro; canonical zone otherwise.
  const [zoneFilter, setZoneFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PendingPosPayment | null>(null);

  async function reload(zoneArg?: string) {
    try {
      const filter = zoneArg ?? zoneFilter;
      const list = await fetchPendingPos(filter === 'all' ? undefined : filter);
      setPending(list);
      // Si el seleccionado ya no está (alguien lo confirmó), reset.
      if (selected && !list.find((p) => p.id === selected.id)) {
        setSelected(null);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchZones()
      .then((zs) => setZones(zs.filter((z) => z.activeCount > 0)))
      .catch(() => {
        /* zonas opcional */
      });
    reload();
    const id = setInterval(() => reload(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeZone(z: string): void {
    setZoneFilter(z);
    setLoading(true);
    reload(z);
  }

  if (selected) {
    return (
      <ConfirmForm
        payment={selected}
        onBack={() => setSelected(null)}
        onConfirmed={() => {
          setSelected(null);
          reload();
          onConfirmed();
        }}
      />
    );
  }

  return (
    <Card style={{ padding: '1.25rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div>
        <h3 style={titleStyle}>POS pendientes</h3>
        <p style={hintStyle}>
          Cobros que las chicas crearon y esperan que tú los proceses en el datáfono.
          Cuando cobres en el datáfono, vuelve aquí y toca el cobro para confirmar.
        </p>
      </div>

      {zones.length > 1 ? (
        <div style={zoneTabsStyle}>
          <button
            type="button"
            onClick={() => changeZone('all')}
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

      {error ? <p style={errorStyle}>{error}</p> : null}

      {loading && pending.length === 0 ? (
        <p style={emptyStyle}>Cargando…</p>
      ) : pending.length === 0 ? (
        <div style={emptyStateStyle}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--np-text-mute)' }}>
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
                  {(p.amountCents / 100).toFixed(2)}
                  <span style={{ fontSize: '0.7rem', color: 'var(--np-text-mute)' }}> €</span>
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConfirmForm({
  payment,
  onBack,
  onConfirmed,
}: {
  payment: PendingPosPayment;
  onBack: () => void;
  onConfirmed: () => void;
}) {
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
    const ref = posRef.trim();
    if (ref.length < 3) {
      setError('Pega o teclea el nº de recibo del datáfono (mín 3 chars)');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      await confirmPosPayment(payment.id, {
        posReceiptRef: ref,
        posReceiptPhoto: photo ?? undefined,
      });
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

      <div style={confirmPillStyle}>
        <span style={kickerStyle}>Importe a cobrar en el datáfono</span>
        <p className="np-num" style={amountBigStyle}>
          {(payment.amountCents / 100).toFixed(2)} <span style={currStyle}>EUR</span>
        </p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
          Chica: {payment.createdByName}
        </p>
      </div>

      <div style={stepsBox}>
        <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 500, marginBottom: '0.5rem' }}>
          Pasos:
        </p>
        <ol style={stepsListStyle}>
          <li>Cobra {(payment.amountCents / 100).toFixed(2)} € en el datáfono del bar.</li>
          <li>Cliente paga con su tarjeta.</li>
          <li><strong>Teclea el nº de recibo</strong> (obligatorio).</li>
          <li>Foto del ticket (opcional pero recomendado).</li>
          <li>Toca "Confirmar pagado" abajo.</li>
        </ol>
      </div>

      <Input
        label="Nº recibo del datáfono *"
        value={posRef}
        onChange={(e) => setPosRef(e.target.value)}
        placeholder="ej: 047215 · A4FC32"
        disabled={submitting}
        required
      />

      <div>
        <label
          style={{
            display: 'block',
            fontSize: '0.875rem',
            fontWeight: 500,
            marginBottom: '0.375rem',
            color: 'var(--np-text)',
          }}
        >
          Foto del ticket (opcional)
        </label>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handlePhotoCapture}
          disabled={submitting}
          style={{ fontSize: '0.875rem' }}
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
                fontSize: '0.85rem',
              }}
            >
              Quitar
            </button>
          </div>
        ) : null}
      </div>

      {error ? <p style={errorStyle}>{error}</p> : null}

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
    img.onload = () => {
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
    img.onerror = () => reject(new Error('image load failed'));
    img.src = URL.createObjectURL(file);
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
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const zoneTabActiveStyle: CSSProperties = {
  background: 'var(--np-surface)',
  color: 'var(--np-accent)',
  boxShadow: 'var(--np-shadow-sm)',
};

const zoneBadgeStyle: CSSProperties = {
  marginLeft: '0.5rem',
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
  fontSize: '0.7rem',
  fontWeight: 500,
  fontFamily: 'var(--np-font-sans)',
  letterSpacing: '0.02em',
  verticalAlign: 'middle',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
};

const hintStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.78rem',
  color: 'var(--np-text-mute)',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'var(--np-danger)',
};

const emptyStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
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
  fontSize: '1.1rem',
  fontWeight: 700,
  fontFamily: 'var(--np-font-mono, monospace)',
  letterSpacing: '0.1em',
  color: 'var(--np-accent)',
};

const metaStyle: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: '0.72rem',
  color: 'var(--np-text-mute)',
};

const amountStyle: CSSProperties = {
  margin: 0,
  fontSize: '1.3rem',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const backBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text-mute)',
  fontSize: '0.85rem',
  cursor: 'pointer',
};

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
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

const amountBigStyle: CSSProperties = {
  margin: 0,
  fontSize: '2.25rem',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

const currStyle: CSSProperties = {
  fontSize: '0.9rem',
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
  fontSize: '0.85rem',
  lineHeight: 1.6,
};
