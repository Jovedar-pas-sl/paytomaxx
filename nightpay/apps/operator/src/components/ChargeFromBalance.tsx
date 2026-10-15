'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import {
  cancelWalletCharge,
  createQrWalletCharge,
  fetchServices,
  fetchWalletCharge,
  lookupWalletCard,
  lookupWalletCode,
  payWalletChargeWithPin,
  type QrWalletCharge,
  type ServiceItem,
  type WalletChargeRequest,
  getUser,
  type WalletLookup,
  type WalletRef,
} from '@/lib/api';
import { clearFichaContext, saveFichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { nfcSupported, readCard } from '@/lib/nfc';
import { PinPad } from './PinPad';

interface Props {
  onCharged: () => void;
  /** Ya no se usa (antes: el código del cliente por el enlace ?saldo=…). */
  initialCode?: string | null;
}

type Stage =
  | { kind: 'pick' }
  | { kind: 'qr'; charge: QrWalletCharge }
  | { kind: 'done'; charge: QrWalletCharge; result: WalletChargeRequest };

const POLL_MS = 1000;

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
  const [services, setServices] = useState<ServiceItem[]>([]);

  useEffect(() => {
    fetchServices()
      .then(setServices)
      .catch(() => setServices([]));
  }, []);

  switch (stage.kind) {
    case 'pick':
      return <PickStep services={services} onCreated={(charge) => setStage({ kind: 'qr', charge })} />;
    case 'qr':
      return (
        <QrStep
          charge={stage.charge}
          onFinished={(result) => {
            if (result.status === 'ACCEPTED') onCharged();
            setStage({ kind: 'done', charge: stage.charge, result });
          }}
          onBack={() => setStage({ kind: 'pick' })}
        />
      );
    case 'done':
      return <DoneStep charge={stage.charge} result={stage.result} onAgain={() => setStage({ kind: 'pick' })} />;
  }
}

function PickStep({ services, onCreated }: { services: ServiceItem[]; onCreated: (charge: QrWalletCharge) => void }) {
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(input: { serviceItemId?: string; amountCents?: number }) {
    setBusy(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      onCreated(await createQrWalletCharge(input));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function sendCustom(e: FormEvent) {
    e.preventDefault();
    const cents = parseEuroCents(amount);
    if (cents === null) {
      setError('Pon el importe (por ejemplo 50 o 50,50)');
      return;
    }
    void send({ amountCents: cents });
  }

  return (
    <Card style={cardStyle}>
      <p style={{ ...kicker, textAlign: 'center' }}>Cobrar del saldo</p>
      <p style={{ ...hintStyle, textAlign: 'center' }}>
        Elige el servicio: te sale un QR, el cliente lo escanea y paga desbloqueando su móvil.
      </p>
      {custom ? (
        <form onSubmit={sendCustom} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Input
            label="Importe (€)"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
            placeholder="50"
            inputMode="decimal"
            autoFocus
            disabled={busy}
          />
          <Button type="submit" size="lg" loading={busy} disabled={!amount.trim()}>
            Cobrar {amount ? `${amount} €` : ''}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCustom(false)} disabled={busy}>
            Volver a la carta
          </Button>
        </form>
      ) : (
        <div style={gridStyle}>
          {services.map((svc) => (
            <button
              key={svc.id}
              type="button"
              disabled={busy}
              onClick={() => void send({ serviceItemId: svc.id })}
              style={tileStyle}
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
      {error ? <p style={errorStyle}>{error}</p> : null}
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
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sin sacar su móvil: su ficha o su código → su PIN en este móvil.
  const [withPin, setWithPin] = useState(false);
  const [wallet, setWallet] = useState<WalletLookup | null>(null);
  const [ref, setRef] = useState<WalletRef | null>(null);
  // El sondeo y "Cancelar" pueden ver la respuesta a la vez: se termina una vez.
  const finished = useRef(false);

  function finish(fresh: WalletChargeRequest): void {
    if (finished.current || fresh.status === 'PENDING') return;
    finished.current = true;
    onFinished(fresh);
  }

  useEffect(() => {
    let stopped = false;
    const id = setInterval(async () => {
      setNow(Date.now());
      try {
        const fresh = await fetchWalletCharge(charge.id);
        if (stopped) return;
        setError(null);
        finish(fresh);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // Solo importa el id del cobro.
  }, [charge.id]);

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

  async function cancel() {
    setCanceling(true);
    setError(null);
    try {
      await cancelWalletCharge(charge.id);
    } catch {
      // Ya no estaba pendiente (el cliente acaba de pagar): se ve abajo.
    }
    try {
      finish(await fetchWalletCharge(charge.id));
    } catch (err) {
      setError((err as Error).message);
      setCanceling(false);
    }
  }

  const secondsLeft = Math.max(0, Math.ceil((new Date(charge.expiresAt).getTime() - now) / 1000));
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
          finish(await payWalletChargeWithPin(charge.id, ref, pin));
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
      <img src={charge.qrPngDataUrl} alt="QR para pagar con el saldo" width={260} height={260} style={qrStyle} />
      <p style={{ margin: 0, fontSize: '1rem' }}>
        Que el cliente lo escanee con su móvil y lo desbloquee (Face ID, huella o su PIN).
      </p>
      <p className="np-num" style={hintStyle}>
        Caduca en {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
      </p>
      <Button variant="ghost" onClick={() => setWithPin(true)} disabled={canceling}>
        Sin móvil: ficha o código + PIN
      </Button>
      <p style={noteStyle}>¿Sin batería y sin PIN? Avisa al encargado: lo cobra desde el panel.</p>
      {error ? <p style={errorStyle}>{error}</p> : null}
      <Button variant="ghost" onClick={() => void cancel()} loading={canceling}>
        Cancelar cobro
      </Button>
      <button type="button" onClick={onBack} style={linkBtnStyle} disabled={canceling}>
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

  useEffect(() => setNfc(nfcSupported()), []);
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
  onAgain,
}: {
  charge: QrWalletCharge;
  result: WalletChargeRequest;
  onAgain: () => void;
}) {
  const text = DONE_TEXT[result.status === 'PENDING' ? 'EXPIRED' : result.status];
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

/** Nombre del servicio y, si no lo dice ya el nombre, su duración. */
function serviceLabel(svc: ServiceItem): string {
  return svc.durationMin && !svc.name.includes(String(svc.durationMin))
    ? `${svc.name} · ${svc.durationMin} min`
    : svc.name;
}

const cardStyle: CSSProperties = {
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.75rem',
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
  fontWeight: 800,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};

const linkBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text-mute)',
  fontSize: '0.875rem',
  cursor: 'pointer',
  padding: 0,
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

const qrStyle: CSSProperties = {
  background: '#fff',
  padding: '0.5rem',
  borderRadius: 'var(--np-r-md)',
};
