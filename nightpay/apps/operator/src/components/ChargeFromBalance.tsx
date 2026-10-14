'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import {
  cancelWalletCharge,
  fetchServices,
  fetchWalletCharge,
  lookupWalletCode,
  requestWalletCharge,
  type ServiceItem,
  type WalletChargeRequest,
  type WalletLookup,
} from '@/lib/api';
import { ScanWalletQr } from './ScanWalletQr';

interface Props {
  onCharged: () => void;
  /** Código que llegó por el enlace del QR (?saldo=…): se busca solo. */
  initialCode?: string | null;
}

type Stage =
  | { kind: 'code' }
  | { kind: 'pick'; wallet: WalletLookup }
  | { kind: 'waiting'; wallet: WalletLookup; request: WalletChargeRequest }
  | { kind: 'done'; wallet: WalletLookup; request: WalletChargeRequest };

const CODE_LENGTH = 6;
const POLL_MS = 1500;

/**
 * Cobrar del saldo NightPay:
 *   1. El cliente enseña su página de saldo: la chica escanea el QR o teclea
 *      el código (K7Q-4M2).
 *   2. La chica elige el servicio de la carta (u otro importe).
 *   3. Al cliente le sale el cobro en su móvil y lo acepta; aquí se ve al momento.
 * Nada se descuenta sin que el cliente lo acepte.
 */
export function ChargeFromBalance({ onCharged, initialCode = null }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'code' });
  // El código del enlace solo se usa la primera vez.
  const [startCode, setStartCode] = useState<string | null>(initialCode);
  const [services, setServices] = useState<ServiceItem[]>([]);

  useEffect(() => {
    fetchServices()
      .then(setServices)
      .catch(() => setServices([]));
  }, []);

  switch (stage.kind) {
    case 'code':
      return (
        <CodeStep
          initialCode={startCode}
          onFound={(wallet) => {
            setStartCode(null);
            setStage({ kind: 'pick', wallet });
          }}
        />
      );
    case 'pick':
      return (
        <PickStep
          wallet={stage.wallet}
          services={services}
          onBack={() => setStage({ kind: 'code' })}
          onRequested={(request) => setStage({ kind: 'waiting', wallet: stage.wallet, request })}
        />
      );
    case 'waiting':
      return (
        <WaitingStep
          request={stage.request}
          onFinished={(request) => {
            if (request.status === 'ACCEPTED') onCharged();
            setStage({ kind: 'done', wallet: stage.wallet, request });
          }}
        />
      );
    case 'done':
      return (
        <DoneStep
          wallet={stage.wallet}
          request={stage.request}
          onAgain={(wallet) => setStage({ kind: 'pick', wallet })}
          onNewClient={() => setStage({ kind: 'code' })}
        />
      );
  }
}

function CodeStep({
  initialCode,
  onFound,
}: {
  initialCode: string | null;
  onFound: (wallet: WalletLookup) => void;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function find(value: string) {
    setCode(value);
    setBusy(true);
    setError(null);
    try {
      onFound(await lookupWalletCode(value));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Llegó por el QR escaneado con la cámara del móvil: se busca directamente.
  useEffect(() => {
    if (initialCode) void find(initialCode);
    // Solo al abrir la pantalla con ese código.
  }, []);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void find(code);
  }

  if (scanning) {
    return (
      <Card style={cardStyle}>
        <p style={{ ...kicker, textAlign: 'center' }}>Escanear el QR del cliente</p>
        <ScanWalletQr
          onCode={(scanned) => {
            setScanning(false);
            void find(scanned);
          }}
          onCancel={() => setScanning(false)}
        />
      </Card>
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={{ ...kicker, textAlign: 'center' }}>Cobrar del saldo</p>
      <Button type="button" size="lg" onClick={() => setScanning(true)} disabled={busy}>
        Escanear QR del cliente
      </Button>
      <p style={{ ...hintStyle, textAlign: 'center' }}>o teclea el código que sale en su página de saldo</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Input
          aria-label="Código del cliente"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH))}
          placeholder="K7Q4M2"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          style={codeInputStyle}
        />
        {error ? <p style={errorStyle}>{error}</p> : null}
        <Button type="submit" variant="ghost" loading={busy} disabled={code.length !== CODE_LENGTH}>
          Buscar saldo
        </Button>
      </form>
    </Card>
  );
}

function PickStep({
  wallet,
  services,
  onBack,
  onRequested,
}: {
  wallet: WalletLookup;
  services: ServiceItem[];
  onBack: () => void;
  onRequested: (request: WalletChargeRequest) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(input: { serviceItemId?: string; amountCents?: number }) {
    setBusy(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      onRequested(await requestWalletCharge({ code: wallet.code, ...input }));
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
    if (cents > wallet.balanceCents) {
      setError(`Al cliente le quedan ${formatEur(wallet.balanceCents)}`);
      return;
    }
    void send({ amountCents: cents });
  }

  return (
    <Card style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
        <div>
          <p style={kicker}>Saldo · {wallet.code}</p>
          <p className="np-num" style={balanceStyle}>
            {formatEur(wallet.balanceCents)}
          </p>
          <p style={hintStyle}>{[wallet.label, wallet.homeVenueName].filter(Boolean).join(' · ')}</p>
        </div>
        <button type="button" onClick={onBack} style={linkBtnStyle}>
          ← Otro código
        </button>
      </div>

      {wallet.pendingRequest ? (
        <p style={noteStyle}>El cliente tiene otro cobro esperando. Que lo acepte o lo rechace antes.</p>
      ) : null}

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
            Pedir {amount ? `${amount} €` : ''}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCustom(false)} disabled={busy}>
            Volver a la carta
          </Button>
        </form>
      ) : (
        <div style={gridStyle}>
          {services.map((svc) => {
            const tooMuch = svc.priceCents > wallet.balanceCents;
            return (
              <button
                key={svc.id}
                type="button"
                disabled={busy || tooMuch}
                onClick={() => void send({ serviceItemId: svc.id })}
                style={{ ...tileStyle, ...(tooMuch ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
              >
                <span style={{ fontSize: '1.125rem', fontWeight: 700 }}>{serviceLabel(svc)}</span>
                <span className="np-num" style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--np-accent)' }}>
                  {formatEur(svc.priceCents)}
                </span>
              </button>
            );
          })}
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

function WaitingStep({
  request,
  onFinished,
}: {
  request: WalletChargeRequest;
  onFinished: (request: WalletChargeRequest) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // El sondeo y "Cancelar" pueden ver la respuesta a la vez: se termina una vez.
  const finished = useRef(false);

  function finish(fresh: WalletChargeRequest): void {
    if (finished.current || fresh.status === 'PENDING') return;
    finished.current = true;
    onFinished(fresh);
  }

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      setNow(Date.now());
      try {
        const fresh = await fetchWalletCharge(request.id);
        if (stopped) return;
        setError(null);
        finish(fresh);
      } catch (err) {
        if (!stopped) setError((err as Error).message);
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // Solo importa el id del cobro (finish/onFinished cambian en cada render del padre).
  }, [request.id]);

  async function handleCancel() {
    setCanceling(true);
    setError(null);
    try {
      await cancelWalletCharge(request.id);
    } catch {
      // Ya no estaba pendiente (el cliente acaba de responder): mostramos lo que haya.
    }
    try {
      finish(await fetchWalletCharge(request.id));
    } catch (err) {
      setError((err as Error).message);
      setCanceling(false);
    }
  }

  const secondsLeft = Math.max(0, Math.ceil((new Date(request.expiresAt).getTime() - now) / 1000));

  return (
    <Card style={{ ...cardStyle, alignItems: 'stretch', textAlign: 'center' }}>
      <p style={{ ...kicker, textAlign: 'center' }}>Esperando al cliente</p>
      <p className="np-num" style={{ ...balanceStyle, textAlign: 'center' }}>
        {formatEur(request.amountCents)}
      </p>
      {request.serviceName ? <p style={{ ...hintStyle, textAlign: 'center' }}>{request.serviceName}</p> : null}
      <p style={{ margin: 0, fontSize: '1rem' }}>Dile que lo acepte en su móvil, en su página de saldo.</p>
      <p className="np-num" style={{ ...hintStyle, textAlign: 'center' }}>
        Caduca en {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
      </p>
      {error ? <p style={errorStyle}>{error}</p> : null}
      <Button variant="ghost" onClick={handleCancel} loading={canceling}>
        Cancelar cobro
      </Button>
    </Card>
  );
}

const DONE_TEXT: Record<Exclude<WalletChargeRequest['status'], 'PENDING'>, { title: string; color: string }> = {
  ACCEPTED: { title: '✓ Cobrado del saldo', color: 'var(--np-success)' },
  REJECTED: { title: 'El cliente lo ha rechazado', color: 'var(--np-danger)' },
  EXPIRED: { title: 'El cliente no respondió a tiempo', color: 'var(--np-warning)' },
  CANCELED: { title: 'Cobro cancelado', color: 'var(--np-text-mute)' },
};

function DoneStep({
  wallet,
  request,
  onAgain,
  onNewClient,
}: {
  wallet: WalletLookup;
  request: WalletChargeRequest;
  onAgain: (wallet: WalletLookup) => void;
  onNewClient: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = DONE_TEXT[request.status === 'PENDING' ? 'EXPIRED' : request.status];

  async function again() {
    setBusy(true);
    setError(null);
    try {
      onAgain(await lookupWalletCode(wallet.code));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card style={{ ...cardStyle, textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: text.color }}>{text.title}</p>
      <p className="np-num" style={{ ...balanceStyle, textAlign: 'center' }}>
        {formatEur(request.amountCents)}
      </p>
      {request.status === 'ACCEPTED' && request.newBalanceCents !== null ? (
        <p style={{ ...hintStyle, textAlign: 'center' }}>Le quedan {formatEur(request.newBalanceCents)}</p>
      ) : null}
      {error ? <p style={errorStyle}>{error}</p> : null}
      <Button size="lg" onClick={again} loading={busy}>
        {request.status === 'ACCEPTED' ? 'Cobrar otra cosa al mismo cliente' : 'Volver a intentarlo'}
      </Button>
      <Button variant="ghost" onClick={onNewClient} disabled={busy}>
        Otro cliente
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

function formatEur(cents: number): string {
  return `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} €`;
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
  padding: '0.75rem 1rem',
  border: '2px solid var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
};

const codeInputStyle: CSSProperties = {
  fontSize: '2rem',
  fontWeight: 800,
  letterSpacing: '0.3em',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
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
