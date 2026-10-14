'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import {
  assignWalletTag,
  cancelPayment,
  chargeWalletWithPin,
  createPayment,
  fetchServices,
  fetchWalletById,
  lookupWalletCode,
  lookupWalletTag,
  newIdempotencyKey,
  setWalletPin,
  type CreatedPayment,
  type ServiceItem,
  type WalletLookup,
} from '@/lib/api';
import { nfcAvailable, readNfcTag } from '@/lib/nfc';
import { PinPad } from './PinPad';
import { ScanWalletQr } from './ScanWalletQr';

interface Props {
  onCharged: () => void;
  /** Código que llegó por el enlace del QR (?saldo=…): se busca solo. */
  initialCode?: string | null;
}

/** Lo que se va a cobrar: un servicio de la carta o un importe. */
interface Charge {
  serviceItemId?: string;
  amountCents: number;
  label: string;
}

type Stage =
  | { kind: 'code' }
  | { kind: 'pick'; wallet: WalletLookup }
  | { kind: 'choosePin'; wallet: WalletLookup; then: Charge | null }
  | { kind: 'pin'; wallet: WalletLookup; charge: Charge }
  | { kind: 'topup'; wallet: WalletLookup }
  | { kind: 'done'; wallet: WalletLookup; charge: Charge; newBalanceCents: number | null };

const CODE_LENGTH = 6;
const TOPUP_POLL_MS = 2000;

/**
 * Cobrar del saldo, sin el móvil del cliente:
 *   1. La chica escanea el QR, teclea el código o acerca la pulsera NFC.
 *   2. Elige el servicio de la carta (u otro importe).
 *   3. Le pasa el móvil al cliente y él pone su PIN: se cobra al momento.
 * Si el cliente aún no tiene PIN, lo elige él antes del primer cobro.
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

  async function refresh(wallet: WalletLookup): Promise<WalletLookup> {
    try {
      return await lookupWalletCode(wallet.code);
    } catch {
      return wallet;
    }
  }

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
          onWallet={(wallet) => setStage({ kind: 'pick', wallet })}
          onCharge={(charge) =>
            setStage(
              stage.wallet.hasPin
                ? { kind: 'pin', wallet: stage.wallet, charge }
                : { kind: 'choosePin', wallet: stage.wallet, then: charge },
            )
          }
          onChoosePin={() => setStage({ kind: 'choosePin', wallet: stage.wallet, then: null })}
          onTopUp={() => setStage({ kind: 'topup', wallet: stage.wallet })}
        />
      );
    case 'choosePin':
      return (
        <PinPad
          mode="choose"
          title={`Saldo ${stage.wallet.code}`}
          hint="Pásale el móvil al cliente para que elija su PIN"
          onCancel={() => setStage({ kind: 'pick', wallet: stage.wallet })}
          onPin={async (pin) => {
            const wallet = await setWalletPin(stage.wallet.code, pin);
            setStage(stage.then ? { kind: 'pin', wallet, charge: stage.then } : { kind: 'pick', wallet });
            return null;
          }}
        />
      );
    case 'pin':
      return (
        <PinPad
          mode="enter"
          title={`${formatEur(stage.charge.amountCents)} · ${stage.charge.label}`}
          hint="Pásale el móvil al cliente para que ponga su PIN"
          onCancel={() => setStage({ kind: 'pick', wallet: stage.wallet })}
          onPin={async (pin) => {
            try {
              const result = await chargeWalletWithPin({
                code: stage.wallet.code,
                ...(stage.charge.serviceItemId
                  ? { serviceItemId: stage.charge.serviceItemId }
                  : { amountCents: stage.charge.amountCents }),
                pin,
              });
              onCharged();
              setStage({ kind: 'done', wallet: stage.wallet, charge: stage.charge, newBalanceCents: result.newBalanceCents });
              return null;
            } catch (err) {
              const message = (err as Error).message;
              // Bloqueado: no tiene sentido seguir probando.
              if (/bloqueado/i.test(message)) {
                setStage({ kind: 'pick', wallet: await refresh(stage.wallet) });
              }
              return message;
            }
          }}
        />
      );
    case 'topup':
      return (
        <TopUpStep
          wallet={stage.wallet}
          onBack={(wallet) => setStage({ kind: 'pick', wallet })}
          onToppedUp={(wallet) => {
            onCharged();
            setStage({ kind: 'pick', wallet });
          }}
        />
      );
    case 'done':
      return (
        <DoneStep
          charge={stage.charge}
          newBalanceCents={stage.newBalanceCents}
          onAgain={async () => setStage({ kind: 'pick', wallet: await refresh(stage.wallet) })}
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
  const [reading, setReading] = useState<AbortController | null>(null);
  const [canNfc, setCanNfc] = useState(false);

  useEffect(() => setCanNfc(nfcAvailable()), []);
  // Al salir de la pantalla se deja de esperar la pulsera.
  useEffect(() => () => reading?.abort(), [reading]);

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

  async function readTag() {
    const controller = new AbortController();
    setReading(controller);
    setError(null);
    try {
      const tag = await readNfcTag(controller.signal);
      setReading(null);
      setBusy(true);
      onFound(await lookupWalletTag(tag));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setReading(null);
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

  if (reading) {
    return (
      <Card style={{ ...cardStyle, textAlign: 'center' }}>
        <p style={{ ...kicker, textAlign: 'center' }}>Pulsera NFC</p>
        <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>Acerca la pulsera a la parte de atrás del móvil</p>
        <Button variant="ghost" onClick={() => reading.abort()}>
          Cancelar
        </Button>
      </Card>
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={{ ...kicker, textAlign: 'center' }}>Cobrar del saldo</p>
      <Button type="button" size="lg" onClick={() => setScanning(true)} disabled={busy}>
        Escanear QR del cliente
      </Button>
      {canNfc ? (
        <Button type="button" size="lg" variant="ghost" onClick={() => void readTag()} disabled={busy}>
          Acercar pulsera NFC
        </Button>
      ) : null}
      <p style={{ ...hintStyle, textAlign: 'center' }}>o teclea el código del cliente</p>
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
  onWallet,
  onCharge,
  onChoosePin,
  onTopUp,
}: {
  wallet: WalletLookup;
  services: ServiceItem[];
  onBack: () => void;
  onWallet: (wallet: WalletLookup) => void;
  onCharge: (charge: Charge) => void;
  onChoosePin: () => void;
  onTopUp: () => void;
}) {
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tagging, setTagging] = useState<AbortController | null>(null);
  const [canNfc, setCanNfc] = useState(false);

  useEffect(() => setCanNfc(nfcAvailable()), []);
  useEffect(() => () => tagging?.abort(), [tagging]);

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
    onCharge({ amountCents: cents, label: 'Otro importe' });
  }

  async function assignTag() {
    const controller = new AbortController();
    setTagging(controller);
    setError(null);
    try {
      const tag = await readNfcTag(controller.signal);
      onWallet(await assignWalletTag(wallet.code, tag));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setTagging(null);
    }
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
          ← Otro cliente
        </button>
      </div>

      {wallet.pinLocked ? (
        <p style={noteStyle}>PIN bloqueado tras 5 fallos. Que el encargado lo desbloquee desde el panel.</p>
      ) : null}
      {!wallet.hasPin && !wallet.pinLocked ? (
        <p style={noteStyle}>
          El cliente aún no tiene PIN: lo elegirá en tu móvil antes de pagar.{' '}
          <button type="button" onClick={onChoosePin} style={inlineLinkStyle}>
            Elegirlo ahora
          </button>
        </p>
      ) : null}

      {wallet.pinLocked || wallet.balanceCents <= 0 ? null : custom ? (
        <form onSubmit={sendCustom} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <Input
            label="Importe (€)"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
            placeholder="50"
            inputMode="decimal"
            autoFocus
          />
          <Button type="submit" size="lg" disabled={!amount.trim()}>
            Cobrar {amount ? `${amount} €` : ''}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCustom(false)}>
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
                disabled={tooMuch}
                onClick={() => onCharge({ serviceItemId: svc.id, amountCents: svc.priceCents, label: serviceLabel(svc) })}
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

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button variant="ghost" onClick={onTopUp} style={{ flex: 1 }}>
          Recargar saldo
        </Button>
        {canNfc && !wallet.hasTag ? (
          tagging ? (
            <Button variant="ghost" onClick={() => tagging.abort()} style={{ flex: 1 }}>
              Acerca la pulsera… (cancelar)
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => void assignTag()} style={{ flex: 1 }}>
              Asignar pulsera
            </Button>
          )
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Recargar el saldo del cliente: un QR para que pague con su tarjeta (como un
 * cobro normal). Cuando el banco lo confirma, el saldo sube y se vuelve.
 */
function TopUpStep({
  wallet,
  onBack,
  onToppedUp,
}: {
  wallet: WalletLookup;
  onBack: (wallet: WalletLookup) => void;
  onToppedUp: (wallet: WalletLookup) => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<CreatedPayment | null>(null);
  const key = useRef(newIdempotencyKey());

  // Esperando al banco: el saldo sube cuando la recarga se cobra.
  useEffect(() => {
    if (!payment) return;
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const fresh = await fetchWalletById(wallet.walletId);
        if (!stopped && fresh.balanceCents > wallet.balanceCents) {
          stopped = true;
          clearInterval(id);
          onToppedUp(fresh);
        }
      } catch {
        // Se vuelve a mirar en el siguiente intento.
      }
    }, TOPUP_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // Solo importa la recarga en curso.
  }, [payment?.id]);

  async function start(e: FormEvent) {
    e.preventDefault();
    const cents = parseEuroCents(amount);
    if (cents === null) {
      setError('Pon el importe (por ejemplo 50)');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPayment(await createPayment({ amountCents: cents, walletId: wallet.walletId, idempotencyKey: key.current }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (payment) {
      try {
        await cancelPayment(payment.id);
      } catch {
        // Ya cobrada o caducada: se ve al volver.
      }
    }
    onBack(wallet);
  }

  if (payment) {
    return (
      <Card style={{ ...cardStyle, textAlign: 'center', alignItems: 'center' }}>
        <p style={kicker}>Recarga · {wallet.code}</p>
        <p className="np-num" style={balanceStyle}>
          {formatEur(payment.amountCents)}
        </p>
        <img src={payment.qrPngDataUrl} alt="QR para pagar la recarga" width={240} height={240} style={qrStyle} />
        <p style={{ margin: 0 }}>Que el cliente escanee el QR y pague con su tarjeta.</p>
        <p style={hintStyle}>Esperando al banco…</p>
        <Button variant="ghost" onClick={() => void cancel()}>
          Cancelar recarga
        </Button>
      </Card>
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Recargar · {wallet.code}</p>
      <p style={hintStyle}>Le quedan {formatEur(wallet.balanceCents)}</p>
      <form onSubmit={start} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Input
          label="Importe de la recarga (€)"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
          placeholder="100"
          inputMode="decimal"
          autoFocus
          disabled={busy}
        />
        {error ? <p style={errorStyle}>{error}</p> : null}
        <Button type="submit" size="lg" loading={busy} disabled={!amount.trim()}>
          Generar QR de la recarga
        </Button>
        <Button type="button" variant="ghost" onClick={() => onBack(wallet)} disabled={busy}>
          Volver
        </Button>
      </form>
    </Card>
  );
}

function DoneStep({
  charge,
  newBalanceCents,
  onAgain,
  onNewClient,
}: {
  charge: Charge;
  newBalanceCents: number | null;
  onAgain: () => Promise<void>;
  onNewClient: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Card style={{ ...cardStyle, textAlign: 'center' }}>
      <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: 'var(--np-success)' }}>✓ Cobrado del saldo</p>
      <p className="np-num" style={{ ...balanceStyle, textAlign: 'center' }}>
        {formatEur(charge.amountCents)}
      </p>
      <p style={{ ...hintStyle, textAlign: 'center' }}>{charge.label}</p>
      {newBalanceCents !== null ? (
        <p style={{ margin: 0, fontSize: '1.05rem' }}>Le quedan {formatEur(newBalanceCents)}</p>
      ) : null}
      <Button
        size="lg"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await onAgain();
        }}
      >
        Cobrar otra cosa al mismo cliente
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

const inlineLinkStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: 'var(--np-accent)',
  fontWeight: 700,
  fontSize: 'inherit',
  cursor: 'pointer',
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

const qrStyle: CSSProperties = {
  background: '#fff',
  padding: '0.5rem',
  borderRadius: 'var(--np-r-md)',
};
