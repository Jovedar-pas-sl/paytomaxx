'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { AmountKeypad, Button, Card, Input } from '@nightpay/ui';
import {
  createPayment,
  newIdempotencyKey,
  fetchTerminals,
  fetchZones,
  type CreatedPayment,
  type OperatorUser,
  type ServiceItem,
  type ZoneOption,
} from '@/lib/api';
import { formatEur } from '@/lib/money';
import { ActivePayment } from './ActivePayment';
import { CartaRetry, serviceLabel, useCarta } from './carta';
import { STICKY_ACTION_BOTTOM } from './layout';
import { cobroModeAllowed, useVenueMethods, type CobroMode } from '@/lib/venue-methods';

/**
 * Categorías de ingreso visibles al crear cobro.
 *   CHICA_SERVICE → "Mi servicio" (solo OPERATOR; le da su comisión configurada)
 *   VENUE_BAR     → "Bar / Bebida" (ingreso del local)
 *   VENUE_ROOM    → "Habitación"   (ingreso del local)
 *   VENUE_FOOD    → "Comida"        (ingreso del local)
 *   EXTRA         → "Otro"          (mixto / sin categorizar)
 */
type RevCat = 'CHICA_SERVICE' | 'VENUE_BAR' | 'VENUE_ROOM' | 'VENUE_FOOD' | 'EXTRA';
const REV_CAT_LABEL: Record<RevCat, string> = {
  CHICA_SERVICE: 'Mi servicio',
  VENUE_BAR: 'Bar / Bebida',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  EXTRA: 'Otro',
};

interface Props {
  /** Quién cobra: la chica solo sus servicios; el resto, barra, habitación, comida. */
  role: OperatorUser['role'];
  /** Cobro pagado (o vuelta al formulario): refrescar el saldo. */
  onCreated: () => void;
}

// Cortos: los tres caben en una línea a 320 px (el título de arriba ya dice el modo entero).
const MODES: ReadonlyArray<{ mode: CobroMode; label: string }> = [
  { mode: 'qr', label: 'QR' },
  { mode: 'wallet', label: 'Wallet' },
  { mode: 'pos', label: 'Datáfono' },
];

/** Lo que se pide al API para crear el cobro (sin la clave de idempotencia). */
type ChargeRequest = Omit<Parameters<typeof createPayment>[0], 'idempotencyKey'>;

/** El cobro en pantalla, cómo se creó y lo que se pidió (para repetirlo igual). */
interface Active {
  payment: CreatedPayment;
  isPos: boolean;
  label: string | null;
  request: ChargeRequest;
}

export function CreatePayment({ role, onCreated }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [selectedZone, setSelectedZone] = useState<string>('');
  // Importe tecleado en el teclado propio, en céntimos (0: aún nada).
  const [amountCents, setAmountCents] = useState(0);
  // Modo de cobro: QR directo (cliente paga con su móvil), wallet (carga
  // saldo prepago) o POS (camarero cobra con datáfono externo).
  const [mode, setMode] = useState<CobroMode>('qr');
  const [walletIdentifier, setWalletIdentifier] = useState('');
  // Categorías permitidas: la chica solo cobra sus servicios (el servidor lo
  // exige); barra, habitación y comida las cobra el camarero.
  const categoryOptions: RevCat[] =
    role === 'OPERATOR'
      ? ['CHICA_SERVICE']
      : ['VENUE_BAR', 'VENUE_ROOM', 'VENUE_FOOD', 'EXTRA'];
  // Default sensato por rol.
  const [revCategory, setRevCategory] = useState<RevCat>(
    role === 'OPERATOR' ? 'CHICA_SERVICE' : 'VENUE_BAR',
  );
  // Fase 1A — carta del local. La chica toca un servicio en vez de teclear
  // el importe; "Otro importe" sigue disponible (con el tope del local).
  const { services, failed: cartaFailed, retry: retryCarta } = useCarta();
  const [picked, setPicked] = useState<ServiceItem | 'custom' | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // El botón de cobrar vive fuera de la tarjeta (pegado abajo): se une al formulario por su id.
  const formId = useId();

  useEffect(() => {
    fetchTerminals()
      .then(setTerminals)
      .catch((err) => setError((err as Error).message));
    // Carga zonas en paralelo — se usan cuando modo === 'pos'.
    fetchZones()
      .then((zs) => {
        const activeZones = zs.filter((z) => z.activeCount > 0);
        setZones(activeZones);
        // Auto-select primera zona si hay solo una.
        if (activeZones.length === 1) {
          setSelectedZone(activeZones[0]!.zone);
        }
      })
      .catch(() => {
        /* zonas opcional — backwards compat fallback */
      });
  }, []);

  // Formas de cobro del local: lo apagado por el dueño no sale (el API lo rechazaría).
  const methods = useVenueMethods();
  const modes = MODES.filter((m) => cobroModeAllowed(m.mode, methods));
  useEffect(() => {
    const first = modes[0];
    if (first && !modes.some((m) => m.mode === mode)) setMode(first.mode);
  }, [modes, mode]);

  // La recarga de wallet no sale de la carta: al cambiar a wallet se suelta
  // el servicio elegido para no arrastrar su precio.
  function switchMode(next: CobroMode) {
    if (next === 'wallet') {
      setPicked(null);
      setAmountCents(0);
    }
    setMode(next);
  }

  // Misma clave mientras sea el mismo intento: si se repite (red lenta, doble
  // toque), el API devuelve el cobro ya creado en vez de crear otro. Si cambia
  // lo que se cobra (importe, servicio, zona…), es otro cobro y otra clave.
  const attempt = useRef<{ key: string; what: string } | null>(null);
  // «Otro QR · mismo importe»: una clave por cobro que se repite (dos toques, un cobro).
  const retryAttempt = useRef<{ from: string; key: string } | null>(null);
  const inFlight = useRef(false);

  // La carta aplica a cobros por QR o datáfono; la recarga de wallet es libre.
  const usingService = mode !== 'wallet' && picked !== null && picked !== 'custom';
  const showCarta = mode !== 'wallet' && services.length > 0 && picked === null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Un doble toque antes de que se pinte "enviando" no crea otro cobro.
    if (inFlight.current) return;
    if (terminals.length === 0 && zones.length === 0) {
      setError('No hay terminales configurados en el local');
      return;
    }
    if ('vibrate' in navigator) navigator.vibrate(10);
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const service = usingService ? (picked as ServiceItem) : null;
      const cents = service ? service.priceCents : amountCents;
      if (cents <= 0) throw new Error('Pon el importe');
      if (mode === 'wallet' && !walletIdentifier.trim()) {
        throw new Error('Pon una etiqueta al wallet (Mesa 3, Pulsera azul...) para no confundirlo');
      }
      // Modo POS con zona: el backend resolverá el terminal libre de esa zona.
      // Si no hay zona seleccionada y hay zonas configuradas, exigimos elegir.
      const usingZone = mode === 'pos' && zones.length > 0;
      if (usingZone && !selectedZone) {
        throw new Error('Elige una zona (Barra, Habitaciones, Mesas…)');
      }
      const request: ChargeRequest = {
        amountCents: cents,
        // Si pasamos zone, el backend resuelve PAX; si no, fallback al primero.
        zone: usingZone ? selectedZone : undefined,
        terminalExternalId: usingZone ? undefined : terminals[0]?.externalId,
        walletIdentifier: mode === 'wallet' ? walletIdentifier.trim() : undefined,
        captureMethod: mode === 'pos' ? 'POS_EXTERNAL' : undefined,
        revenueCategory: revCategory,
        serviceItemId: service?.id,
      };
      const what = JSON.stringify([cents, mode, usingZone ? selectedZone : null, walletIdentifier.trim(), revCategory, service?.id ?? null]);
      if (attempt.current?.what !== what) attempt.current = { key: newIdempotencyKey(), what };
      const created = await createPayment({ ...request, idempotencyKey: attempt.current.key });
      attempt.current = null;
      setActive({ payment: created, isPos: mode === 'pos', label: service ? serviceLabel(service) : null, request });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /** Rechazado o caducado: otro cobro con lo mismo (importe, servicio, zona…), sin teclear. */
  async function retrySame() {
    if (!active || inFlight.current) return;
    const from = active.payment.id;
    if (retryAttempt.current?.from !== from) retryAttempt.current = { from, key: newIdempotencyKey() };
    inFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      const created = await createPayment({ ...active.request, idempotencyKey: retryAttempt.current.key });
      setActive({ ...active, payment: created });
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      inFlight.current = false;
      setRetrying(false);
    }
  }

  function reset() {
    setActive(null);
    setAmountCents(0);
    setPicked(null);
    setError(null);
    setRetryError(null);
    setWalletIdentifier('');
    onCreated();
  }

  if (active) {
    return (
      <ActivePayment
        key={active.payment.id}
        payment={active.payment}
        isPos={active.isPos}
        label={active.label}
        onPaid={onCreated}
        onClose={reset}
        onRetry={() => void retrySame()}
        retrying={retrying}
        retryError={retryError}
      />
    );
  }

  if (showCarta) {
    return (
      <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ ...kicker, textAlign: 'center' }}>¿Qué cobras?</p>
        <div style={cartaGridStyle}>
          {services.map((svc) => (
            <button
              key={svc.id}
              type="button"
              onClick={() => {
                setPicked(svc);
                setError(null);
              }}
              style={cartaTileStyle}
            >
              <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{serviceLabel(svc)}</span>
              <span className="np-num" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--np-accent)' }}>
                {formatEur(svc.priceCents, { compact: true })}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPicked('custom');
              setAmountCents(0);
              setError(null);
            }}
            style={{ ...cartaTileStyle, borderStyle: 'dashed' }}
          >
            <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>Otro importe</span>
            <span style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>Teclearlo</span>
          </button>
        </div>
        {cobroModeAllowed('wallet', methods) ? (
          <Button type="button" variant="ghost" onClick={() => switchMode('wallet')}>
            Cargar wallet del cliente
          </Button>
        ) : null}
      </Card>
    );
  }

  const headline =
    mode === 'wallet' ? 'Cargar wallet del cliente'
    : mode === 'pos' ? 'Cobro con datáfono'
    : 'Crear nuevo cobro';
  const cents = usingService ? (picked as ServiceItem).priceCents : amountCents;
  const amountLabel = cents > 0 ? formatEur(cents, { compact: true }) : null;

  return (
    <>
      <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ ...kicker, textAlign: 'center' }}>{headline}</p>

        {cartaFailed && mode !== 'wallet' ? <CartaRetry onRetry={retryCarta} /> : null}

        <form id={formId} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {usingService ? (
            <div style={pickedStyle}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700, fontSize: '1.125rem' }}>{serviceLabel(picked as ServiceItem)}</p>
                <p className="np-num" style={{ margin: 0, fontSize: '2.25rem', fontWeight: 700 }}>
                  {formatEur((picked as ServiceItem).priceCents, { compact: true })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPicked(null)}
                style={{ height: '2.75rem', padding: '0 1rem' }}
              >
                Cambiar
              </Button>
            </div>
          ) : (
            // Teclado propio: el del sistema tapaba media pantalla (y el botón).
            <AmountKeypad
              valueCents={amountCents}
              onChange={setAmountCents}
              maxCents={MAX_TYPED_AMOUNT_CENTS}
              label={mode === 'wallet' ? 'Importe a cargar' : 'Importe'}
              disabled={submitting}
            />
          )}
          {picked === 'custom' && mode !== 'wallet' && services.length > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setPicked(null)}>
              Volver a la carta
            </Button>
          ) : null}

          {/* Categoría — separa cobros de chica vs cobros del local. La chica
              ve "Mi servicio" + opciones del local; camarero solo ve las del local.
              Botones de un toque en vez de desplegable. */}
          {categoryOptions.length > 1 ? (
          <fieldset style={{ margin: 0, padding: 0, border: 'none' }}>
            <legend style={fieldLabel}>¿Qué cobras?</legend>
            <div style={catGridStyle}>
              {categoryOptions.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={revCategory === c}
                  onClick={() => setRevCategory(c)}
                  style={{ ...catBtnStyle, ...(revCategory === c ? catBtnActiveStyle : {}) }}
                >
                  {REV_CAT_LABEL[c]}
                </button>
              ))}
            </div>
            <p style={{ ...hintStyle, marginTop: '0.5rem' }}>
              {revCategory === 'CHICA_SERVICE'
                ? 'Va a tus ganancias.'
                : revCategory === 'EXTRA'
                  ? 'Cobro sin categoría.'
                  : 'Va al local.'}
            </p>
          </fieldset>
          ) : null}

          {mode === 'wallet' ? (
            <>
              <Input
                label="Etiqueta del wallet"
                type="text"
                placeholder="Ej: Mesa 3, Pulsera azul, Camisa roja"
                value={walletIdentifier}
                onChange={(e) => setWalletIdentifier(e.target.value)}
                required
              />
              <p style={hintStyle}>
                El cliente paga una vez. Luego le cobras desde la pestaña Saldo.
              </p>
            </>
          ) : mode === 'pos' ? (
            <>
              {zones.length > 1 ? (
                <div>
                  <label htmlFor="zone-select" style={zoneLabelStyle}>
                    Zona del PAX
                  </label>
                  <select
                    id="zone-select"
                    value={selectedZone}
                    onChange={(e) => setSelectedZone(e.target.value)}
                    required
                    style={zoneSelectStyle}
                  >
                    <option value="">Elige zona…</option>
                    {zones.map((z) => (
                      <option key={z.zone} value={z.zone}>
                        {z.zoneDisplay} ({z.activeCount} PAX)
                      </option>
                    ))}
                  </select>
                </div>
              ) : zones.length === 1 ? (
                <p style={{ ...hintStyle, textAlign: 'center' }}>
                  Zona: <strong>{zones[0]!.zoneDisplay}</strong> ({zones[0]!.activeCount} PAX disponibles)
                </p>
              ) : null}
              <p style={hintStyle}>
                El camarero lo cobra con el datáfono del bar y lo confirma en su app.
              </p>
            </>
          ) : null}

        </form>
      </Card>
      {/* Abajo y a mano (encima de las pestañas): cómo paga y el botón de cobrar.
          Fuera de la tarjeta para que se pegue abajo aunque la tarjeta empiece
          muy abajo (pantallas bajas, con el aviso de conexión abierto). */}
      <div className="np-sticky-action" style={stickyStyle}>
        <div className="np-seg" role="group" aria-label="Cómo paga el cliente">
          {modes.map(({ mode: m, label }) => (
            <button
              key={m}
              type="button"
              className="np-seg-btn"
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button type="submit" form={formId} size="lg" loading={submitting} disabled={cents <= 0}>
          {submitLabel(mode, amountLabel)}
        </Button>
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

// Sobre el fondo de la página (no el de la tarjeta).
const stickyStyle = { bottom: STICKY_ACTION_BOTTOM, '--np-sticky-bg': 'var(--np-bg)' } as CSSProperties;

/** «Cobrar 50 €», «Cargar 20 €», «Generar cobro POS (30 €)». */
function submitLabel(mode: CobroMode, amount: string | null): string {
  if (mode === 'wallet') return `Cargar ${amount ?? 'wallet'}`;
  if (mode === 'pos') return `Generar cobro POS${amount ? ` (${amount})` : ''}`;
  return amount ? `Cobrar ${amount}` : 'Cobrar';
}

const fieldLabel: CSSProperties = {
  padding: 0,
  marginBottom: '0.5rem',
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  color: 'var(--np-text-label)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const catGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '0.5rem',
};

const catBtnStyle: CSSProperties = {
  minHeight: '3.25rem',
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  border: '2px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-text)',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const catBtnActiveStyle: CSSProperties = {
  background: 'var(--np-pill-cyan-bg)',
  borderColor: 'var(--np-accent)',
  fontWeight: 700,
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const errorStyle: CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  fontSize: '0.9375rem',
  fontWeight: 600,
  textAlign: 'center',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const zoneLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.875rem',
  fontWeight: 500,
  marginBottom: '0.375rem',
  color: 'var(--np-text)',
};

const zoneSelectStyle: CSSProperties = {
  width: '100%',
  padding: '0.75rem 1rem',
  fontSize: '1rem',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  background: 'var(--np-surface)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
};

const cartaGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '0.625rem',
};

const cartaTileStyle: CSSProperties = {
  minHeight: '6rem',
  padding: '0.875rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  textAlign: 'left',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-lg)',
  color: 'var(--np-text)',
  cursor: 'pointer',
};

const pickedStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem',
  border: '2px solid var(--np-accent)',
  borderRadius: 'var(--np-r-lg)',
  background: 'var(--np-pill-cyan-bg)',
};
