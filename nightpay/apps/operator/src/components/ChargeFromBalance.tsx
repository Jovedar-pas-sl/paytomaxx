'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { AmountKeypad, Button, Card, Input, QrCountdown, qrDeadline, useNow, useWakeLock } from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS, type SectionCode } from '@nightpay/contracts';
import {
  cancelWalletCharge,
  createQrWalletCharge,
  fetchWalletCharge,
  lookupWalletCard,
  lookupWalletCode,
  payWalletChargeWithPin,
  type QrWalletCharge,
  type WalletChargeRequest,
  getUser,
  pollErrorText,
  ServerUnavailableError,
  SessionExpiredError,
  type WalletLookup,
  type WalletRef,
} from '@/lib/api';
import { useHealthReport } from '@/lib/connection-health';
import { clearFichaContext, saveFichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { nfcSupported, readCard } from '@/lib/nfc';
import { useOpenCharge } from '@/lib/open-charges';
import { useVenueMethods } from '@/lib/venue-methods';
import { usePolling } from '@/lib/use-polling';
import { CartaRetry, serviceLabel, useCarta, type Carta } from './carta';
import { STICKY_ACTION_BOTTOM } from './layout';
import { PinPad } from './PinPad';
import { SectionPicker } from './SectionPicker';
import { initialSection, offeredSections, sectionColor, useMySections } from '@/lib/sections';
import { useSessionExpired } from './session-context';
import { StaffOutcome } from './StaffOutcome';

interface Props {
  onCharged: () => void;
}

/** Lo que se pidió (servicio, o importe y su sección): «Otro QR · mismo importe» lo repite sin teclear. */
type ChargeInput = { serviceItemId?: string; amountCents?: number; category?: SectionCode };

type Stage =
  | { kind: 'pick' }
  | { kind: 'qr'; charge: QrWalletCharge; input: ChargeInput }
  | { kind: 'done'; charge: QrWalletCharge; result: WalletChargeRequest; input: ChargeInput };

const POLL_MS = 1000;
/** Con el servidor caído o saturado (429), se pregunta menos. */
const POLL_SLOW_MS = 3000;

/**
 * Cobrar del saldo:
 *   1. La chica elige el servicio de la carta (u otro importe).
 *   2. Le sale un QR: el cliente lo escanea con su móvil y paga desbloqueándolo
 *      (Face ID, huella o el PIN de su teléfono).
 *      O, sin sacar su móvil: la chica pone su código y él teclea su PIN aquí.
 *   3. Aquí se ve al momento que está pagado y lo que le queda.
 * Sin batería y sin PIN: el encargado lo cobra desde el panel.
 */
export function ChargeFromBalance({ onCharged }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const carta = useCarta();
  // Con su QR o su resultado en pantalla: si la sesión caduca, se entra encima sin perderlo.
  useOpenCharge('saldo', stage.kind !== 'pick', stage.kind === 'qr');

  switch (stage.kind) {
    case 'pick':
      return <PickStep carta={carta} onCreated={(charge, input) => setStage({ kind: 'qr', charge, input })} />;
    case 'qr':
      return (
        <QrStep
          key={stage.charge.id}
          charge={stage.charge}
          onFinished={(result) => {
            if (result.status === 'ACCEPTED') onCharged();
            setStage({ kind: 'done', charge: stage.charge, result, input: stage.input });
          }}
          onBack={() => setStage({ kind: 'pick' })}
        />
      );
    case 'done':
      return (
        <DoneStep
          charge={stage.charge}
          result={stage.result}
          input={stage.input}
          onRetried={(charge) => setStage({ kind: 'qr', charge, input: stage.input })}
          onAgain={() => setStage({ kind: 'pick' })}
        />
      );
  }
}

function PickStep({
  carta,
  onCreated,
}: {
  carta: Carta;
  onCreated: (charge: QrWalletCharge, input: ChargeInput) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [amountCents, setAmountCents] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // «Otro importe»: la sección, con la del puesto ya marcada (nunca «Otros»).
  const mySections = useMySections();
  const sectionChoices = offeredSections(mySections.sections);
  const [pickedSection, setPickedSection] = useState<SectionCode | null>(null);
  const category = pickedSection ?? initialSection(sectionChoices, mySections.defaultCategory);

  async function send(input: ChargeInput) {
    setBusy(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      onCreated(await createQrWalletCharge(input), input);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function sendCustom(e: FormEvent) {
    e.preventDefault();
    if (amountCents <= 0) {
      setError('Pon el importe');
      return;
    }
    void send({ amountCents, category });
  }

  // Sin servicios en la carta (o sin carta): el teclado directamente, sin pasar por «Otro importe».
  const hasCarta = carta.services.length > 0;
  const keypad = custom || (carta.loaded && !hasCarta);

  return (
    <Card style={cardStyle}>
      <p style={{ ...kicker, textAlign: 'center' }}>Cobrar del saldo</p>
      <p style={{ ...hintStyle, textAlign: 'center' }}>
        {keypad
          ? 'Teclea el importe: te sale un QR, el cliente lo escanea y paga desbloqueando su móvil.'
          : 'Elige el servicio: te sale un QR, el cliente lo escanea y paga desbloqueando su móvil.'}
      </p>
      {!carta.loaded && !custom ? null : keypad ? (
        <form onSubmit={sendCustom} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <AmountKeypad
            valueCents={amountCents}
            onChange={setAmountCents}
            maxCents={MAX_TYPED_AMOUNT_CENTS}
            disabled={busy}
          />
          <SectionPicker sections={sectionChoices} value={category} onChange={setPickedSection} disabled={busy} />
          {hasCarta ? (
            <Button type="button" variant="ghost" onClick={() => setCustom(false)} disabled={busy}>
              Volver a la carta
            </Button>
          ) : null}
          <div className="np-sticky-action" style={{ bottom: STICKY_ACTION_BOTTOM }}>
            <Button type="submit" size="lg" loading={busy} disabled={amountCents <= 0}>
              {amountCents > 0 ? `Cobrar ${formatEur(amountCents, { compact: true })}` : 'Cobrar'}
            </Button>
          </div>
        </form>
      ) : (
        <div style={gridStyle}>
          {carta.services.map((svc) => (
            <button
              key={svc.id}
              type="button"
              disabled={busy}
              onClick={() => void send({ serviceItemId: svc.id })}
              style={{ ...tileStyle, borderLeft: `0.5rem solid ${sectionColor(mySections.sections, svc.category)}` }}
            >
              <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{serviceLabel(svc)}</span>
              <span className="np-num" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--np-accent)' }}>
                {formatEur(svc.priceCents, { compact: true })}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCustom(true);
              setError(null);
            }}
            style={{ ...tileStyle, borderStyle: 'dashed' }}
          >
            <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>Otro importe</span>
            <span style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>Teclearlo</span>
          </button>
        </div>
      )}
      {carta.failed ? <CartaRetry onRetry={carta.retry} /> : null}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function QrStep({
  charge,
  onFinished,
  onBack,
}: {
  charge: QrWalletCharge;
  onFinished: (result: WalletChargeRequest) => void;
  onBack: () => void;
}) {
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sin sacar su móvil: su ficha o su código → su PIN en este móvil.
  const [withPin, setWithPin] = useState(false);
  const [wallet, setWallet] = useState<WalletLookup | null>(null);
  const [ref, setRef] = useState<WalletRef | null>(null);
  // El sondeo, el PIN y "Cancelar" pueden ver la respuesta a la vez: se
  // termina una vez (y nada llega a la pantalla después de "Elegir otro").
  const finished = useRef(false);

  /** true si el cobro ya terminó (ahora o antes). */
  function finish(fresh: WalletChargeRequest): boolean {
    if (finished.current || fresh.status === 'PENDING') return finished.current;
    finished.current = true;
    onFinished(fresh);
    return true;
  }

  // La cuenta atrás solo pinta: no pregunta nada al servidor.
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(() => qrDeadline(charge.expiresAt, receivedAt), [charge.expiresAt, receivedAt]);
  const now = useNow(true);
  // Cobro abierto: pantalla encendida; y si el API no contesta, lo dice la franja de arriba.
  const [pollDown, setPollDown] = useState(false);
  useWakeLock(true);
  useHealthReport(`saldo:${charge.id}`, { serverDown: pollDown });
  // Este estado pide la sesión de la chica: caducada, se para; al volver a entrar, sigue solo.
  const expired = useSessionExpired();

  // ¿Ya ha pagado? Una pregunta por segundo, sin solapes; para al terminar.
  usePolling(
    async (signal) => {
      if (finished.current) return 'stop';
      try {
        const fresh = await fetchWalletCharge(charge.id, signal);
        setError(null);
        setPollDown(false);
        return finish(fresh) ? 'stop' : undefined;
      } catch (err) {
        // Sin respuesta (o plazo agotado): servidor caído, lo dice la franja.
        if (signal.aborted || err instanceof ServerUnavailableError) {
          setPollDown(true);
          return 'slow';
        }
        setError(pollErrorText(err));
        return err instanceof SessionExpiredError ? 'stop' : 'slow';
      }
    },
    { intervalMs: POLL_MS, slowIntervalMs: POLL_SLOW_MS, initialDelayMs: POLL_MS, enabled: !expired },
  );

  // iPhone: tras "Sin móvil", al acercar la ficha se abre otra pestaña
  // (?ficha=…) que paga ESTE cobro.
  useEffect(() => {
    const userId = getUser()?.id;
    if (!withPin || !userId) return;
    saveFichaContext({
      userId,
      kind: 'cobro',
      chargeId: charge.id,
      amountCents: charge.amountCents,
      serviceName: charge.serviceName,
      expiresAt: charge.expiresAt,
    });
    return () => clearFichaContext((ctx) => ctx.kind === 'cobro' && ctx.chargeId === charge.id);
  }, [withPin, charge.id, charge.amountCents, charge.serviceName, charge.expiresAt]);

  /**
   * Cancela el cobro (si mientras tanto lo pagó, se ve el pagado). Con
   * thenBack, después vuelve a la carta: el QR viejo no se queda pendiente.
   */
  async function cancel(thenBack: boolean) {
    setCanceling(true);
    setError(null);
    try {
      await cancelWalletCharge(charge.id);
    } catch {
      // Ya no estaba pendiente (el cliente acaba de pagar): se ve abajo.
    }
    try {
      const fresh = await fetchWalletCharge(charge.id);
      if (thenBack && fresh.status !== 'PENDING' && fresh.status !== 'ACCEPTED' && !finished.current) {
        finished.current = true;
        onBack();
        return;
      }
      if (!finish(fresh)) {
        setError('No se ha podido cancelar. Inténtalo otra vez.');
        setCanceling(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setCanceling(false);
    }
  }

  const what = `${formatEur(charge.amountCents, { compact: true })}${charge.serviceName ? ` · ${charge.serviceName}` : ''}`;

  if (withPin && wallet && ref && wallet.hasPin && !wallet.pinLocked) {
    return (
      <PinPad
        mode="enter"
        title={what}
        hint={`Saldo ${wallet.code}${'card' in ref ? ' · ficha' : ''}`}
        onCancel={() => {
          setWallet(null);
          setRef(null);
        }}
        onPin={async (pin) => {
          const result = await payWalletChargeWithPin(charge.id, ref, pin);
          if (result.status === 'PENDING') return 'No se ha cobrado todavía: vuelve a intentarlo.';
          finish(result);
          return null;
        }}
      />
    );
  }

  if (withPin) {
    return (
      <PinCodeStep
        what={what}
        wallet={wallet}
        onFound={(w, r) => {
          setWallet(w);
          setRef(r);
        }}
        onBack={() => {
          setWithPin(false);
          setWallet(null);
          setRef(null);
        }}
      />
    );
  }

  return (
    <Card style={{ ...cardStyle, alignItems: 'center', textAlign: 'center' }}>
      <p style={kicker}>Cobrar del saldo</p>
      <p className="np-num" style={balanceStyle}>
        {formatEur(charge.amountCents, { compact: true })}
      </p>
      {charge.serviceName ? <p style={hintStyle}>{charge.serviceName}</p> : null}
      <QrCountdown deadline={deadline} nowMs={now}>
        <img src={charge.qrPngDataUrl} alt="QR para pagar con el saldo" width={260} height={260} style={qrStyle} />
      </QrCountdown>
      <p style={{ margin: 0, fontSize: '1rem' }}>
        Que el cliente lo escanee con su móvil y lo desbloquee (Face ID, huella o su PIN).
      </p>
      <Button variant="ghost" onClick={() => setWithPin(true)} disabled={canceling}>
        Sin móvil: ficha o código + PIN
      </Button>
      {error ? <p style={errorStyle}>{error}</p> : null}
      <Button variant="ghost" onClick={() => void cancel(false)} loading={canceling}>
        Cancelar cobro
      </Button>
      {/* Debajo de los botones: en un móvil bajo, lo que no cabe es esto. */}
      <p style={noteStyle}>¿Sin batería y sin PIN? Avisa al encargado: lo cobra desde el panel.</p>
      <button type="button" onClick={() => void cancel(true)} style={linkBtnStyle} disabled={canceling}>
        ← Elegir otro servicio
      </button>
    </Card>
  );
}

/** Su ficha NFC (o su código, K7Q-4M2) antes de que teclee su PIN. */
function PinCodeStep({
  what,
  wallet,
  onFound,
  onBack,
}: {
  what: string;
  wallet: WalletLookup | null;
  onFound: (wallet: WalletLookup, ref: WalletRef) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState(wallet?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nfc, setNfc] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  // Ficha NFC apagada por el dueño: solo código + PIN.
  const nfcOn = useVenueMethods().nfc;

  useEffect(() => setNfc(nfcSupported() && nfcOn), [nfcOn]);
  useEffect(() => () => reading?.abort(), [reading]);

  async function find(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const w = await lookupWalletCode(code);
      onFound(w, { code: w.code });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function tapCard() {
    const controller = new AbortController();
    setReading(controller);
    setError(null);
    try {
      const read = await readCard(controller.signal);
      if (!read.token) throw new Error('Esta ficha está vacía: se le da al cliente al recargar');
      const w = await lookupWalletCard(read.token, read.uid);
      onFound(w, { card: read.token, uid: read.uid });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      controller.abort();
      setReading(null);
    }
  }

  const problem = !wallet
    ? null
    : wallet.pinLocked
      ? 'Su PIN está bloqueado por fallos: avisa al encargado.'
      : !wallet.hasPin
        ? 'Este cliente aún no tiene PIN: que pague con el QR, o que lo elija con el encargado.'
        : null;

  return (
    <Card style={cardStyle}>
      <p style={{ ...kicker, textAlign: 'center' }}>Sin móvil: ficha o código + PIN</p>
      <p className="np-num" style={{ ...balanceStyle, textAlign: 'center' }}>
        {what}
      </p>
      {nfc ? (
        reading ? (
          <Button size="lg" variant="ghost" onClick={() => reading.abort()}>
            Acerca la ficha a la parte de atrás del móvil… (cancelar)
          </Button>
        ) : (
          <Button size="lg" onClick={() => void tapCard()} disabled={busy}>
            Acercar su ficha
          </Button>
        )
      ) : (
        <p style={noteStyle}>
          ¿Tiene ficha? En iPhone: acércala a la parte de arriba del móvil y toca el aviso que sale.
        </p>
      )}
      <form onSubmit={find} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Input
          label="Código del cliente"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          placeholder="K7Q-4M2"
          autoCapitalize="characters"
          autoComplete="off"
          autoFocus
          disabled={busy}
        />
        <Button type="submit" size="lg" loading={busy} disabled={code.replace(/-/g, '').length < 6}>
          Siguiente: su PIN
        </Button>
      </form>
      {problem ? <p style={errorStyle}>{problem}</p> : null}
      {error ? <p style={errorStyle}>{error}</p> : null}
      <button type="button" onClick={onBack} style={linkBtnStyle} disabled={busy}>
        ← Volver al QR
      </button>
    </Card>
  );
}

const DONE_TEXT: Record<Exclude<WalletChargeRequest['status'], 'PENDING'>, { title: string; color: string }> = {
  ACCEPTED: { title: '✓ Cobrado del saldo', color: 'var(--np-success)' },
  REJECTED: { title: 'El cliente no lo ha pagado', color: 'var(--np-danger)' },
  EXPIRED: { title: 'El cliente no lo pagó a tiempo', color: 'var(--np-warning)' },
  CANCELED: { title: 'Cobro cancelado', color: 'var(--np-text-mute)' },
};

function DoneStep({
  charge,
  result,
  input,
  onRetried,
  onAgain,
}: {
  charge: QrWalletCharge;
  result: WalletChargeRequest;
  input: ChargeInput;
  /** «Otro QR · mismo importe» ya creado: a su QR. */
  onRetried: (charge: QrWalletCharge) => void;
  onAgain: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const status = result.status === 'PENDING' ? 'EXPIRED' : result.status;
  const text = DONE_TEXT[status];

  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      onRetried(await createQrWalletCharge(input));
    } catch (err) {
      setRetryError((err as Error).message);
      setRetrying(false);
    } finally {
      inFlight.current = false;
    }
  }

  if (status === 'ACCEPTED') {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={charge.amountCents}
        message="Cobrado del saldo."
        detail={
          <>
            {/* La referencia que ve el cliente en sus movimientos. */}
            {charge.ref ? (
              <p className="np-num" style={{ fontWeight: 800, letterSpacing: '0.04em' }}>
                {charge.ref}
              </p>
            ) : null}
            {charge.serviceName ? <p>{charge.serviceName}</p> : null}
            {result.newBalanceCents !== null ? (
              <p>Le quedan {formatEur(result.newBalanceCents, { compact: true })}</p>
            ) : null}
          </>
        }
        primary={{ label: 'Nuevo cobro del saldo', onClick: onAgain }}
      />
    );
  }

  if (status === 'REJECTED' || status === 'EXPIRED') {
    return (
      <StaffOutcome
        kind={status === 'REJECTED' ? 'failed' : 'expired'}
        amountCents={charge.amountCents}
        message={`${text.title}.`}
        detail={charge.serviceName ? <p>{charge.serviceName}</p> : null}
        primary={{ label: 'Otro QR · mismo importe', onClick: () => void retry(), loading: retrying }}
        secondary={{ label: 'Elegir otro servicio', onClick: onAgain, disabled: retrying }}
        error={retryError}
      />
    );
  }

  return (
    <Card style={{ ...cardStyle, textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: text.color }}>{text.title}</p>
      <p className="np-num" style={{ ...balanceStyle, textAlign: 'center' }}>
        {formatEur(charge.amountCents, { compact: true })}
      </p>
      {charge.serviceName ? <p style={{ ...hintStyle, textAlign: 'center' }}>{charge.serviceName}</p> : null}
      {result.status === 'ACCEPTED' && result.newBalanceCents !== null ? (
        <p style={{ margin: 0, fontSize: '1.05rem' }}>Le quedan {formatEur(result.newBalanceCents, { compact: true })}</p>
      ) : null}
      <Button size="lg" onClick={onAgain}>
        Nuevo cobro del saldo
      </Button>
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: 'var(--np-pad-card)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--np-gap)',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  color: 'var(--np-danger)',
  textAlign: 'center',
};

const noteStyle: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
};

const balanceStyle: CSSProperties = {
  margin: 0,
  fontSize: '2.25rem',
  lineHeight: 1.15,
  fontWeight: 800,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

// 44 px de alto: se toca bien aunque parezca un enlace.
const linkBtnStyle: CSSProperties = {
  minHeight: '2.75rem',
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text-mute)',
  fontSize: '0.875rem',
  cursor: 'pointer',
  padding: '0 0.5rem',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '0.625rem',
};

const tileStyle: CSSProperties = {
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

// 260 px como mucho; en el móvil, según el alto (--np-qr): el QR y sus botones en una pantalla.
const qrStyle: CSSProperties = {
  width: 'min(260px, var(--np-qr))',
  height: 'auto',
  background: '#fff',
  padding: '0.5rem',
  borderRadius: 'var(--np-r-md)',
};
