'use client';

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { MAX_TYPED_AMOUNT_CENTS, type SectionCode } from '@nightpay/contracts';
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
import { CartaRetry, CartaTile, serviceLabel, tileStyle, useCarta } from './carta';
import { InviteStep } from './InviteStep';
import { invitationsFirst } from '@/lib/invite-link';
import { STICKY_ACTION_BOTTOM } from './layout';
import { cobroModeAllowed, useVenueMethods, type CobroMode } from '@/lib/venue-methods';
import { initialSection, offeredSections, sectionColor, useMySections } from '@/lib/sections';
import { SectionPicker } from './SectionPicker';

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

export function CreatePayment({ role: _role, onCreated }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [selectedZone, setSelectedZone] = useState<string>('');
  // Importe tecleado en el teclado propio, en céntimos (0: aún nada).
  const [amountCents, setAmountCents] = useState(0);
  // Modo de cobro: QR directo (cliente paga con su móvil), wallet (carga
  // saldo prepago) o POS (camarero cobra con datáfono externo).
  const [mode, setMode] = useState<CobroMode>('qr');
  const [walletIdentifier, setWalletIdentifier] = useState('');
  // El mapa del dinero: «Otro importe» pide la sección (botones de su color),
  // con la del puesto de quien cobra ya marcada. Nunca «Otros».
  const mySections = useMySections();
  const sectionChoices = offeredSections(mySections.sections, mySections.allowed);
  const [pickedSection, setPickedSection] = useState<SectionCode | null>(null);
  const revCategory = pickedSection ?? initialSection(sectionChoices, mySections.defaultCategory);
  // Fase 1A — carta del local. La chica toca un servicio en vez de teclear
  // el importe; "Otro importe" sigue disponible (con el tope del local).
  const { services, failed: cartaFailed, retry: retryCarta } = useCarta();
  const [picked, setPicked] = useState<ServiceItem | 'custom' | null>(null);
  // «Invitar a una copa»: el QR de la chica invitada (leído antes de cobrar).
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const takeInvite = useCallback((token: string) => setInviteToken(token), []);
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
  const inviting = usingService && (picked as ServiceItem).isInvitation === true;

  function pickService(next: ServiceItem | 'custom' | null) {
    setPicked(next);
    setInviteToken(null);
    setError(null);
  }

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
      if (inviting && !inviteToken) throw new Error('Escanea el QR de la chica a la que invita');
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
        // De la carta, la sección la pone el servicio; tecleado, la elegida.
        revenueCategory: service || mode === 'wallet' ? undefined : revCategory,
        serviceItemId: service?.id,
        invitedStaffToken: inviting ? (inviteToken ?? undefined) : undefined,
      };
      const what = JSON.stringify([
        cents,
        mode,
        usingZone ? selectedZone : null,
        walletIdentifier.trim(),
        revCategory,
        service?.id ?? null,
        inviting ? inviteToken : null,
      ]);
      if (attempt.current?.what !== what) attempt.current = { key: newIdempotencyKey(), what };
      const created = await createPayment({ ...request, idempotencyKey: attempt.current.key });
      attempt.current = null;
      const label = service ? `${inviting ? 'Invitación · ' : ''}${serviceLabel(service)}` : null;
      setActive({ payment: created, isPos: mode === 'pos', label, request });
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
    setInviteToken(null);
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

  // Sin QR ni datáfono (el dueño dejó solo el saldo): nada que cobrar aquí.
  if (modes.length === 0) {
    return (
      <Card style={{ padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: '0.75rem', textAlign: 'center' }}>
        <p style={kicker}>Cobrar</p>
        <p style={{ margin: 0, fontSize: '1.0625rem', fontWeight: 600 }}>
          {methods.wallet
            ? 'Este local solo cobra con saldo: usa la pestaña Saldo.'
            : 'Este local no tiene ninguna forma de cobro encendida. Habla con el encargado.'}
        </p>
      </Card>
    );
  }

  // Invitación elegida: antes de cobrar, el QR de la chica.
  if (inviting && !inviteToken) {
    const svc = picked as ServiceItem;
    return <InviteStep name={serviceLabel(svc)} priceCents={svc.priceCents} onToken={takeInvite} onCancel={() => pickService(null)} />;
  }

  if (showCarta) {
    return (
      <Card style={{ padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)' }}>
        <p style={{ ...kicker, textAlign: 'center' }}>¿Qué cobras?</p>
        <div style={cartaGridStyle}>
          {invitationsFirst(services).map((svc) => (
            <CartaTile
              key={svc.id}
              svc={svc}
              color={sectionColor(mySections.sections, svc.category)}
              onPick={() => pickService(svc)}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              pickService('custom');
              setAmountCents(0);
            }}
            style={{ ...tileStyle, borderStyle: 'dashed' }}
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
      <Card style={{ padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)' }}>
        <p style={{ ...kicker, textAlign: 'center' }}>{headline}</p>

        {cartaFailed && mode !== 'wallet' ? <CartaRetry onRetry={retryCarta} /> : null}

        <form id={formId} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)' }}>
          {usingService ? (
            <div style={pickedStyle}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700, fontSize: '1.125rem' }}>
                  {inviting ? 'Invitación · ' : ''}
                  {serviceLabel(picked as ServiceItem)}
                </p>
                <p className="np-num" style={{ margin: 0, fontSize: '2.25rem', fontWeight: 700 }}>
                  {formatEur((picked as ServiceItem).priceCents, { compact: true })}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => pickService(null)}
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

          {/* Importe tecleado: ¿de qué es? (de la carta ya lo dice el servicio). */}
          {!usingService && mode !== 'wallet' ? (
            <SectionPicker sections={sectionChoices} value={revCategory} onChange={setPickedSection} disabled={submitting} />
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
  lineHeight: 1.3,
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
