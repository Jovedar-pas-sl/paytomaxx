'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { parseEuroCents } from '@nightpay/contracts';
import { io, type Socket } from 'socket.io-client';
import { Button, Card, Input, StatusPill, type PaymentStatus } from '@nightpay/ui';
import {
  cancelPayment,
  createPayment,
  newIdempotencyKey,
  fetchServices,
  fetchTerminals,
  fetchZones,
  getUser,
  wsBase,
  type CreatedPayment,
  type ServiceItem,
  type ZoneOption,
} from '@/lib/api';
import { NewWalletCard } from './NewWalletCard';

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
  onCreated: () => void;
}

type CobroMode = 'qr' | 'wallet' | 'pos';

export function CreatePayment({ onCreated }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [selectedZone, setSelectedZone] = useState<string>('');
  const [amount, setAmount] = useState('');
  // Modo de cobro: QR directo (cliente paga con su móvil), wallet (carga
  // saldo prepago) o POS (camarero cobra con datáfono externo).
  const [mode, setMode] = useState<CobroMode>('qr');
  const [walletIdentifier, setWalletIdentifier] = useState('');
  // Rol del usuario logueado — determina qué categorías puede usar.
  const role = getUser()?.role ?? 'OPERATOR';
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
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [picked, setPicked] = useState<ServiceItem | 'custom' | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  // Fase 1B — propina que eligió el cliente en su página de pago.
  const [paidTipCents, setPaidTipCents] = useState(0);
  const [active, setActive] = useState<CreatedPayment | null>(null);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wsDown, setWsDown] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick global para countdown del QR
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [active]);

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
    fetchServices()
      .then(setServices)
      .catch(() => {
        /* sin carta: se cobra tecleando el importe, como antes */
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    const socket: Socket = io(`${wsBase}/rt`, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setWsDown(false);
      socket.emit('payment:subscribe', { paymentId: active.id });
    });
    socket.on('disconnect', () => setWsDown(true));
    socket.on('connect_error', () => setWsDown(true));
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === active.id) setStatus(e.status);
    });
    socket.on(
      'payment:completed',
      (e: {
        paymentId: string;
        status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' | 'CANCELED';
        tipCents?: number;
      }) => {
        if (e.paymentId === active.id) {
          setStatus(e.status);
          if (e.status === 'AUTHORIZED') {
            setPaidTipCents(e.tipCents ?? 0);
            onCreated();
          }
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [active, onCreated]);

  // La recarga de wallet no sale de la carta: al cambiar a wallet se suelta
  // el servicio elegido para no arrastrar su precio.
  function switchMode(next: CobroMode) {
    if (next === 'wallet') {
      setPicked(null);
      setAmount('');
    }
    setMode(next);
  }

  // Misma clave mientras sea el mismo intento: si se repite (red lenta, doble
  // toque), el API devuelve el cobro ya creado en vez de crear otro. Si cambia
  // lo que se cobra (importe, servicio, zona…), es otro cobro y otra clave.
  const attempt = useRef<{ key: string; what: string } | null>(null);
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
      const cents = service ? service.priceCents : parseEuroCents(amount);
      if (cents === null) throw new Error('Importe inválido');
      if (mode === 'wallet' && !walletIdentifier.trim()) {
        throw new Error('Pon una etiqueta al wallet (Mesa 3, Pulsera azul...) para no confundirlo');
      }
      // Modo POS con zona: el backend resolverá el terminal libre de esa zona.
      // Si no hay zona seleccionada y hay zonas configuradas, exigimos elegir.
      const usingZone = mode === 'pos' && zones.length > 0;
      if (usingZone && !selectedZone) {
        throw new Error('Elige una zona (Barra, Habitaciones, Mesas…)');
      }
      const what = JSON.stringify([cents, mode, usingZone ? selectedZone : null, walletIdentifier.trim(), revCategory, service?.id ?? null]);
      if (attempt.current?.what !== what) attempt.current = { key: newIdempotencyKey(), what };
      const created = await createPayment({
        amountCents: cents,
        // Si pasamos zone, el backend resuelve PAX; si no, fallback al primero.
        zone: usingZone ? selectedZone : undefined,
        terminalExternalId: usingZone ? undefined : terminals[0]?.externalId,
        walletIdentifier: mode === 'wallet' ? walletIdentifier.trim() : undefined,
        captureMethod: mode === 'pos' ? 'POS_EXTERNAL' : undefined,
        revenueCategory: revCategory,
        serviceItemId: service?.id,
        idempotencyKey: attempt.current.key,
      });
      attempt.current = null;
      setActiveLabel(service ? serviceLabel(service) : null);
      setActive(created);
      setStatus(created.status as PaymentStatus);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!active) return;
    setSubmitting(true);
    try {
      await cancelPayment(active.id);
      setActive(null);
      setStatus(null);
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUrl() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.qrUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  function reset() {
    setActive(null);
    setStatus(null);
    setAmount('');
    setPicked(null);
    setActiveLabel(null);
    setPaidTipCents(0);
    setCopied(false);
    setError(null);
    setWalletIdentifier('');
    onCreated();
  }

  if (active) {
    const canCancel = status === 'CREATED' || status === 'AWAITING_CAPTURE';
    // POS_EXTERNAL: el QR no es para el cliente, es para que el camarero vea
    // el cobro pendiente. Mostramos código corto humano-legible.
    const isPosFlow = mode === 'pos';
    const refCode = active.id.slice(-6).toUpperCase();
    // Countdown del QR — solo en estados pre-cobro
    const isPreCobro = !status || status === 'CREATED' || status === 'AWAITING_CAPTURE';
    const expiryMs = new Date(active.qrExpiresAt).getTime();
    const secondsLeft = isPreCobro && Number.isFinite(expiryMs)
      ? Math.max(0, Math.floor((expiryMs - now) / 1000))
      : null;
    const showCountdown = secondsLeft !== null && secondsLeft > 0;
    const countdownUrgent = secondsLeft !== null && secondsLeft < 60;
    return (
      <Card variant="glow" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={kicker}>{isPosFlow ? 'Cobro POS' : 'Importe'}</p>
          <p className="np-num" style={amountBig}>
            {(active.amountCents / 100).toFixed(2)}{' '}
            <span style={{ fontSize: '0.95rem', color: 'var(--np-text-mute)', fontWeight: 500 }}>
              {active.currency}
            </span>
          </p>
          {activeLabel ? (
            <p style={{ margin: '0.25rem 0 0', fontWeight: 700, fontSize: '1.0625rem' }}>{activeLabel}</p>
          ) : null}
          {isPosFlow ? (
            <p style={{
              margin: '0.5rem 0 0',
              fontSize: '0.9rem',
              color: 'var(--np-text-mute)',
            }}>
              Llama al camarero. Código: <strong style={{ fontFamily: 'var(--np-font-mono)', letterSpacing: '0.15em', color: 'var(--np-accent)' }}>#{refCode}</strong>
            </p>
          ) : null}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <StatusPill status={status ?? 'CREATED'} />
        </div>

        {showCountdown ? (
          <p
            style={{
              margin: 0,
              textAlign: 'center',
              fontSize: '0.875rem',
              color: countdownUrgent ? 'var(--np-warning)' : 'var(--np-text-mute)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.02em',
            }}
          >
            QR caduca en {Math.floor(secondsLeft! / 60)}:{(secondsLeft! % 60).toString().padStart(2, '0')}
          </p>
        ) : null}

        {wsDown && isPreCobro ? (
          <p
            role="status"
            style={{
              margin: 0,
              textAlign: 'center',
              fontSize: '0.75rem',
              color: 'var(--np-warning)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.375rem',
            }}
          >
            <span
              aria-hidden
              style={{
                width: '0.5rem',
                height: '0.5rem',
                borderRadius: '50%',
                background: 'var(--np-warning)',
                animation: 'np-blink 1.2s ease-in-out infinite',
              }}
            />
            Reconectando con el servidor…
            <style>{`@keyframes np-blink {0%,100%{opacity:0.4}50%{opacity:1}}`}</style>
          </p>
        ) : null}

        {isPosFlow ? (
          <>
            <div
              style={{
                background: 'white',
                borderRadius: 'var(--np-r-md)',
                padding: '0.75rem',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <img
                src={active.qrPngDataUrl}
                alt="QR del cobro POS"
                style={{ width: '100%', maxWidth: '12rem', height: 'auto', display: 'block' }}
              />
            </div>
            <div style={{
              padding: '1rem',
              background: 'var(--np-surface-2)',
              borderRadius: 'var(--np-r-md)',
              border: '1px dashed var(--np-border)',
              textAlign: 'center',
            }}>
              <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.6 }}>
                <strong>Camarero:</strong> escanea el QR con tu móvil (o usa código <strong style={{ fontFamily: 'var(--np-font-mono)', letterSpacing: '0.15em', color: 'var(--np-accent)' }}>#{refCode}</strong>).<br />
                Cobra <strong>{(active.amountCents / 100).toFixed(2)} €</strong> en el datáfono, luego confirma en tu app.
              </p>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                background: 'white',
                borderRadius: 'var(--np-r-md)',
                padding: '0.75rem',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <img
                src={active.qrPngDataUrl}
                alt="QR del cobro"
                style={{ width: '100%', maxWidth: '20rem', height: 'auto', display: 'block' }}
              />
            </div>
            <Button onClick={copyUrl} variant="ghost" size="md">
              {copied ? '✓ Copiado' : 'Copiar link del cobro'}
            </Button>
          </>
        )}

        {status === 'AUTHORIZED' ? (
          <>
            <p style={{ ...kicker, textAlign: 'center' }}>
              Código de confirmación{' '}
              <strong className="np-num" style={{ fontSize: '1.5rem', color: 'var(--np-text)', letterSpacing: '0.2em' }}>
                {confirmationCode(active.id)}
              </strong>
            </p>
            <p style={{ ...hintStyle, textAlign: 'center' }}>Debe coincidir con el del móvil del cliente.</p>
            {active.walletId ? <NewWalletCard walletId={active.walletId} /> : null}
            {paidTipCents > 0 ? (
              <p className="np-num" style={{ margin: 0, textAlign: 'center', fontWeight: 700, fontSize: '1.25rem', color: 'var(--np-accent)' }}>
                + {formatEur(paidTipCents)} de propina
              </p>
            ) : null}
            <Button onClick={reset} size="lg">
              ✓ Cobrado — nuevo
            </Button>
          </>
        ) : canCancel ? (
          <Button onClick={handleCancel} variant="danger" size="md" loading={submitting}>
            Cancelar cobro
          </Button>
        ) : (
          <Button onClick={reset} variant="ghost" size="md">
            Nuevo cobro
          </Button>
        )}

        {error ? <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem', textAlign: 'center' }}>{error}</p> : null}
      </Card>
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
                setAmount((svc.priceCents / 100).toFixed(2));
                setError(null);
              }}
              style={cartaTileStyle}
            >
              <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{serviceLabel(svc)}</span>
              <span className="np-num" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--np-accent)' }}>
                {formatEur(svc.priceCents)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPicked('custom');
              setAmount('');
              setError(null);
            }}
            style={{ ...cartaTileStyle, borderStyle: 'dashed' }}
          >
            <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>Otro importe</span>
            <span style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>Teclearlo</span>
          </button>
        </div>
        <Button type="button" variant="ghost" onClick={() => switchMode('wallet')}>
          Cargar wallet del cliente
        </Button>
      </Card>
    );
  }

  const headline =
    mode === 'wallet' ? 'Cargar wallet del cliente'
    : mode === 'pos' ? 'Cobro con datáfono'
    : 'Crear nuevo cobro';

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ ...kicker, textAlign: 'center' }}>{headline}</p>

      {/* Toggle 3-way: QR / Wallet / POS */}
      <div style={toggleRowStyle}>
        <button
          type="button"
          onClick={() => setMode('qr')}
          style={{ ...toggleBtnStyle, ...(mode === 'qr' ? toggleBtnActiveStyle : {}) }}
        >
          QR cliente
        </button>
        <button
          type="button"
          onClick={() => switchMode('wallet')}
          style={{ ...toggleBtnStyle, ...(mode === 'wallet' ? toggleBtnActiveStyle : {}) }}
        >
          Wallet
        </button>
        <button
          type="button"
          onClick={() => setMode('pos')}
          style={{ ...toggleBtnStyle, ...(mode === 'pos' ? toggleBtnActiveStyle : {}) }}
        >
          Datáfono
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {usingService ? (
          <div style={pickedStyle}>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 700, fontSize: '1.125rem' }}>{serviceLabel(picked as ServiceItem)}</p>
              <p className="np-num" style={{ margin: 0, fontSize: '2.25rem', fontWeight: 700 }}>
                {formatEur((picked as ServiceItem).priceCents)}
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
        <Input
          label="Importe (€)"
          type="text"
          inputMode="decimal"
          placeholder="50.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          size="lg"
          // autoFocus removed: en iOS abre el teclado inmediatamente, que tapa
          // el selector de modo (QR/Wallet/POS) que la chica AÚN no eligió.
          // La chica toca el input cuando quiera escribir el importe.
          style={{ textAlign: 'center', fontFamily: 'var(--np-font-mono)', height: '5.5rem', fontSize: '2.75rem' }}
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
              El cliente paga una vez. Luego le cobras desde la pestaña Wallet.
            </p>
          </>
        ) : mode === 'pos' ? (
          <>
            {zones.length > 1 ? (
              <div>
                <label
                  htmlFor="zone-select"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    marginBottom: '0.375rem',
                    color: 'var(--np-text)',
                  }}
                >
                  Zona del PAX
                </label>
                <select
                  id="zone-select"
                  value={selectedZone}
                  onChange={(e) => setSelectedZone(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem 1rem',
                    fontSize: '1rem',
                    borderRadius: 'var(--np-r-md)',
                    border: '1px solid var(--np-border)',
                    background: 'var(--np-surface)',
                    color: 'var(--np-text)',
                    fontFamily: 'inherit',
                  }}
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

        <Button type="submit" size="lg" loading={submitting}>
          {mode === 'wallet'
            ? `Cargar ${amount ? `${amount} €` : 'wallet'}`
            : mode === 'pos'
              ? `Generar cobro POS ${amount ? `(${amount} €)` : ''}`
              : amount
                ? `Cobrar ${amount} €`
                : 'Cobrar'}
        </Button>
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem', textAlign: 'center' }}>
            {error}
          </p>
        ) : null}
      </form>
    </Card>
  );
}

const toggleRowStyle: CSSProperties = {
  display: 'flex',
  background: 'var(--np-surface-2)',
  padding: '0.25rem',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
};

const toggleBtnStyle: CSSProperties = {
  flex: 1,
  // 44px+ touch target — antes 28px rendered (padding 0.5rem + fontSize 0.78rem)
  // era zona de misfire con guantes o vibración nocturna.
  minHeight: '3rem',
  padding: '0.625rem 0.75rem',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text)',
  fontSize: '0.9375rem',
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const toggleBtnActiveStyle: CSSProperties = {
  background: 'var(--np-accent)',
  color: 'var(--np-on-accent)',
};

const fieldLabel: CSSProperties = {
  padding: 0,
  marginBottom: '0.5rem',
  fontSize: '0.8125rem',
  fontWeight: 700,
  color: 'var(--np-text-mute)',
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

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const amountBig: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '2.5rem',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

/** Mismo código que ve el cliente en su pantalla "Pagado" (últimos 3 del id). */
function confirmationCode(paymentId: string): string {
  return paymentId.replace(/-/g, '').slice(-3).toUpperCase();
}

/** Nombre del servicio y, si no lo dice ya el nombre, su duración. */
function serviceLabel(svc: ServiceItem): string {
  return svc.durationMin && !svc.name.includes(String(svc.durationMin))
    ? `${svc.name} · ${svc.durationMin} min`
    : svc.name;
}

function formatEur(cents: number): string {
  return `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} €`;
}

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
