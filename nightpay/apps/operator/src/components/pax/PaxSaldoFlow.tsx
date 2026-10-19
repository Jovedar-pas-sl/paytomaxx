'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { formatEur } from '@/lib/money';
import { nfcSupported } from '@/lib/nfc';
import { callReader, hasBridgeMethod } from '@/lib/pax-bridge';
import {
  checkProblem,
  checkSaldoWallet,
  fetchSaldoCharges,
  CHIP_BY_CAMERA_TEXT,
  parseScan,
  readerErrorText,
  readFicha,
  refLabel,
  scanSaldoCharge,
  scanWithCamera,
  submitPin,
  type OutcomeKind,
  type SaldoCharge,
  type SaldoCheck,
  type SaldoRef,
} from '@/lib/pax-saldo';
import { usePolling } from '@/lib/use-polling';
import { PinPad } from '../PinPad';
import { StaffOutcome } from '../StaffOutcome';

/** Cómo lee este aparato: la ficha por la app (NFC de Android) o Web NFC (móvil), y la cámara. */
interface Readers {
  ficha: 'bridge' | 'web' | null;
  camera: boolean;
  /** Por qué no hay ficha (NFC reservado por el datáfono, apagado…). */
  fichaNote: string | null;
}

type Step =
  | { kind: 'pick' }
  | { kind: 'identify'; charge: SaldoCharge }
  | { kind: 'problem'; charge: SaldoCharge; ref: SaldoRef; check: SaldoCheck; text: string }
  | { kind: 'pin'; charge: SaldoCharge; ref: SaldoRef; check: SaldoCheck }
  | { kind: 'outcome'; charge: SaldoCharge; outcome: OutcomeKind; message?: string; newBalanceCents: number | null };

const POLL_MS = 3000;
/** Tras «Pagado», vuelta sola a la pantalla del datáfono (le da tiempo a ver lo que le queda). */
const BACK_AFTER_PAID_MS = 6000;

/**
 * Cobrar con saldo en el datáfono:
 *   1. El cobro con QR que hizo la chica: de la lista o escaneando su QR.
 *   2. De qué saldo es: su ficha NFC, el QR de su pase / página del saldo o su código.
 *   3. Si le llega (sin enseñar cuánto tiene), el cliente teclea su PIN aquí.
 *   4. PAGADO a pantalla completa (o por qué no).
 */
export function PaxSaldoFlow({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const readers = useReaders();
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const paid = step.kind === 'outcome' && step.outcome === 'paid';
  useEffect(() => {
    if (!paid) return undefined;
    const t = setTimeout(() => onDoneRef.current(), BACK_AFTER_PAID_MS);
    return () => clearTimeout(t);
  }, [paid]);

  function finish(charge: SaldoCharge, outcome: OutcomeKind, newBalanceCents: number | null, message?: string) {
    setStep({ kind: 'outcome', charge, outcome, newBalanceCents, message });
  }

  switch (step.kind) {
    case 'pick':
      return (
        <PickCharge
          camera={readers.camera}
          onPicked={(charge) => setStep({ kind: 'identify', charge })}
          onBack={onDone}
        />
      );
    case 'identify':
      return (
        <IdentifyWallet
          charge={step.charge}
          readers={readers}
          onChecked={(ref, check) => {
            const text = checkProblem(check);
            setStep(
              text
                ? { kind: 'problem', charge: step.charge, ref, check, text }
                : { kind: 'pin', charge: step.charge, ref, check },
            );
          }}
          onBack={() => setStep({ kind: 'pick' })}
        />
      );
    case 'problem':
      return (
        <Card style={cardStyle}>
          <ChargeHeader charge={step.charge} />
          <p style={muted}>{refLabel(step.ref, step.check.codeHint)}</p>
          <p role="alert" style={{ ...big, color: 'var(--np-warning)' }}>
            {step.text}
          </p>
          <Button size="lg" onClick={() => setStep({ kind: 'identify', charge: step.charge })}>
            Otra ficha, QR o código
          </Button>
          <Button variant="ghost" onClick={() => setStep({ kind: 'pick' })}>
            Elegir otro cobro
          </Button>
        </Card>
      );
    case 'pin': {
      const { charge, ref, check } = step;
      return (
        <PinPad
          mode="enter"
          title={`${formatEur(charge.amountCents)}${charge.serviceName ? ` · ${charge.serviceName}` : ''}`}
          hint={`${refLabel(ref, check.codeHint)} · saldo suficiente ✓`}
          onCancel={() => setStep({ kind: 'identify', charge })}
          onPin={async (pin) => {
            const r = await submitPin(charge.id, ref, pin);
            if (r.kind === 'retry') return r.message;
            finish(charge, r.outcome, r.newBalanceCents, r.message);
            return null;
          }}
        />
      );
    }
    case 'outcome': {
      const { charge, outcome, message, newBalanceCents } = step;
      return (
        <StaffOutcome
          kind={outcome}
          amountCents={charge.amountCents}
          message={message ?? (outcome === 'paid' ? 'Cobrado del saldo.' : undefined)}
          detail={
            <>
              {charge.serviceName ? <p>{charge.serviceName}</p> : null}
              {outcome === 'paid' && newBalanceCents !== null ? <p>Le quedan {formatEur(newBalanceCents)}</p> : null}
            </>
          }
          primary={{ label: 'Otro cobro con saldo', onClick: () => setStep({ kind: 'pick' }) }}
          secondary={{ label: 'Volver', onClick: onDone }}
        />
      );
    }
  }
}

function useReaders(): Readers {
  const [readers, setReaders] = useState<Readers>({ ficha: null, camera: false, fichaNote: null });
  useEffect(() => {
    let alive = true;
    const web = nfcSupported();
    if (!hasBridgeMethod('capabilities')) {
      // Móvil (Web NFC) o una app del datáfono vieja: sin cámara.
      setReaders({ ficha: web ? 'web' : null, camera: false, fichaNote: null });
      return undefined;
    }
    void callReader('capabilities').then((r) => {
      if (!alive) return;
      const nfc = r.ok ? (r.nfc ?? 'unavailable') : 'unavailable';
      const ficha = nfc === 'ready' ? 'bridge' : web ? 'web' : null;
      setReaders({
        ficha,
        camera: r.ok && r.camera === true && hasBridgeMethod('scanQr'),
        fichaNote: ficha ? null : readerErrorText(nfc === 'disabled' ? 'nfcDisabled' : 'nfcUnavailable'),
      });
    });
    return () => {
      alive = false;
    };
  }, []);
  return readers;
}

function PickCharge({
  camera,
  onPicked,
  onBack,
}: {
  camera: boolean;
  onPicked: (charge: SaldoCharge) => void;
  onBack: () => void;
}) {
  const [charges, setCharges] = useState<SaldoCharge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  usePolling(
    async (signal) => {
      try {
        setCharges(await fetchSaldoCharges(signal));
        setError(null);
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return 'slow';
      }
    },
    { intervalMs: POLL_MS, enabled: !busy },
  );

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      const text = await scanWithCamera();
      if (text === null) return;
      const target = parseScan(text);
      if (target.kind === 'charge') onPicked(await scanSaldoCharge(target.payToken));
      else if (target.kind === 'wallet' || target.kind === 'chip') {
        setError('Ese es el QR del cliente: primero elige el cobro (o escanea el QR del cobro de la chica).');
      }
      else setError('Ese QR no es de un cobro de OxioPay.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Cobrar con saldo</p>
      <p style={muted}>Elige el cobro que ha hecho la chica (o escanea el QR de su móvil).</p>
      {camera ? (
        <Button size="lg" loading={busy} onClick={() => void scan()}>
          Escanear QR del cobro
        </Button>
      ) : null}
      {charges === null && !error ? <p style={muted}>Cargando…</p> : null}
      {charges !== null && charges.length === 0 ? (
        <p style={{ ...muted, padding: '1rem 0' }}>No hay cobros del saldo esperando. Los hace la chica en «Cobrar del saldo».</p>
      ) : null}
      {(charges ?? []).map((c) => (
        <button key={c.id} type="button" disabled={busy} onClick={() => onPicked(c)} style={chargeBtn}>
          <span className="np-num" style={{ fontSize: '2rem', fontWeight: 700 }}>
            {formatEur(c.amountCents)}
          </span>
          <span style={{ fontSize: '1.0625rem', fontWeight: 600 }}>
            {[c.requestedByName, c.serviceName].filter(Boolean).join(' · ') || 'Cobro del saldo'}
          </span>
        </button>
      ))}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={onBack} disabled={busy}>
        Volver
      </Button>
    </Card>
  );
}

function IdentifyWallet({
  charge,
  readers,
  onChecked,
  onBack,
}: {
  charge: SaldoCharge;
  readers: Readers;
  onChecked: (ref: SaldoRef, check: SaldoCheck) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => reading?.abort(), [reading]);

  async function attempt(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const check = async (ref: SaldoRef) => onChecked(ref, await checkSaldoWallet(charge.id, ref));

  function tapFicha() {
    const via = readers.ficha;
    if (!via) return;
    const controller = new AbortController();
    setReading(controller);
    void attempt(async () => {
      try {
        const read = await readFicha(controller.signal, via);
        if (!read.token) throw new Error('Esta ficha está vacía o no es de OxioPay: se da al recargar en recepción.');
        await check({ card: read.token, uid: read.uid });
      } finally {
        setReading(null);
      }
    });
  }

  function scanCustomer() {
    void attempt(async () => {
      const text = await scanWithCamera();
      if (text === null) return;
      const target = parseScan(text);
      if (target.kind === 'wallet') await check(target.ref);
      else if (target.kind === 'chip') throw new Error(CHIP_BY_CAMERA_TEXT);
      else if (target.kind === 'charge') throw new Error('Ese es el QR de un cobro: escanea el del cliente (su pase o su página del saldo).');
      else throw new Error('Ese QR no es de un saldo de OxioPay.');
    });
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    void attempt(() => check({ code: code.replace(/[^A-Z0-9]/g, '') }));
  }

  return (
    <Card style={cardStyle}>
      <ChargeHeader charge={charge} />
      {reading ? (
        <>
          <p style={big}>Acerca la ficha a la parte de atrás del datáfono…</p>
          <Button variant="ghost" onClick={() => reading.abort()}>
            Cancelar
          </Button>
        </>
      ) : (
        <>
          {readers.ficha ? (
            <Button size="lg" onClick={tapFicha} disabled={busy}>
              Acercar ficha
            </Button>
          ) : null}
          {readers.camera ? (
            <Button size="lg" variant={readers.ficha ? 'ghost' : 'primary'} onClick={scanCustomer} disabled={busy}>
              Escanear QR del cliente
            </Button>
          ) : null}
          {readers.fichaNote ? <p style={noteStyle}>{readers.fichaNote}</p> : null}
          <form onSubmit={submitCode} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Input
              label="Código del cliente"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="K7Q-4M2"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={8}
              disabled={busy}
            />
            <Button type="submit" variant="ghost" loading={busy} disabled={code.replace(/-/g, '').length !== 6}>
              Buscar por código
            </Button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={onBack} disabled={busy && !reading}>
        Elegir otro cobro
      </Button>
    </Card>
  );
}

function ChargeHeader({ charge }: { charge: SaldoCharge }) {
  return (
    <>
      <p style={kicker}>Cobrar con saldo</p>
      <p className="np-num" style={{ margin: 0, fontSize: '3rem', fontWeight: 700 }}>
        {formatEur(charge.amountCents)}
      </p>
      <p style={muted}>{[charge.requestedByName, charge.serviceName].filter(Boolean).join(' · ') || 'Cobro del saldo'}</p>
    </>
  );
}

const cardStyle: CSSProperties = {
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  textAlign: 'center',
};
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--np-danger)', fontWeight: 600 };
const noteStyle: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
const chargeBtn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.25rem',
  padding: '1rem 1.25rem',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-lg)',
  color: 'var(--np-text)',
  textAlign: 'left',
  cursor: 'pointer',
  minHeight: '5.5rem',
};
