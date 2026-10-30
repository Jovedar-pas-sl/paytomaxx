'use client';

import { useCallback, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { GivenFicha } from '@nightpay/contracts';
import { Button, Card, Input } from '@nightpay/ui';
import type { OperatorUser } from '@/lib/api';
import { giveFicha, readFichaQr, walletCodeOf } from '@/lib/give-ficha';
import { formatEur } from '@/lib/money';
import { fetchReceptionDesk, type ReceptionDeskSaldo } from '@/lib/reception-desk';
import { useVenueMethods } from '@/lib/venue-methods';
import { PinPad } from '../PinPad';
import { QrScanner, qrScanSupported } from '../QrScanner';
import { StaffOutcome } from '../StaffOutcome';
import { useReadNfc } from './use-read-nfc';

/** Lo encontrado y cómo prueba el cliente que es suyo (su QR o su PIN; el encargado, ninguna). */
interface Found {
  saldo: ReceptionDeskSaldo;
  proof?: string;
  pin?: string;
}

type Step = { kind: 'find' } | { kind: 'scan' } | { kind: 'pin'; found: Found; error?: string } | { kind: 'tap'; found: Found } | { kind: 'done'; out: GivenFicha };

/**
 * Recepción → «Dar ficha a un saldo»: el cliente que cargó su saldo desde
 * casa (o cualquiera sin ficha) llega y pide una ficha. Se busca su saldo
 * con el QR de su saldo (en su móvil) o con su código; con el código, el
 * cliente pone su PIN (el encargado y el dueño no lo necesitan). Después se
 * acerca una ficha y queda unida a ese saldo. Solo la primera ficha.
 */
export function GiveFicha({ user, onDone }: { user: OperatorUser; onDone: () => void }) {
  const nfcOn = useVenueMethods().nfc;
  const { reader, reading, read } = useReadNfc();
  const [step, setStep] = useState<Step>({ kind: 'find' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = user.role === 'MANAGER' || user.role === 'OWNER';

  async function find(walletCode: string, proof?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const view = await fetchReceptionDesk({ code: walletCode });
      if (view.kind !== 'saldo') throw new Error('No hay ningún saldo con ese código en este local');
      if (view.fichaNumber !== null) throw new Error(`Este saldo ya tiene ficha (nº ${view.printedNumber ?? view.fichaNumber}). Si la ha perdido, el encargado le da otra.`);
      if (view.blocked) throw new Error('Este saldo está bloqueado: avisa al encargado.');
      const found: Found = { saldo: view, ...(proof ? { proof } : {}) };
      if (proof || manager) return setStep({ kind: 'tap', found });
      if (!view.hasPin) {
        throw new Error('Este saldo aún no tiene PIN: que te enseñe el QR de su saldo en su móvil (o que lo haga el encargado).');
      }
      setStep({ kind: 'pin', found });
    } catch (err) {
      setError((err as Error).message);
      setStep({ kind: 'find' });
    } finally {
      setBusy(false);
    }
  }

  // La cámara no se reinicia en cada pintada: las dos funciones de abajo no cambian.
  const findRef = useRef(find);
  findRef.current = find;
  const onScan = useCallback((text: string) => {
    const qr = readFichaQr(text);
    if ('problem' in qr) {
      setError(qr.problem);
      setStep({ kind: 'find' });
      return;
    }
    void findRef.current(qr.code, qr.proof);
  }, []);
  const onScanError = useCallback((message: string) => {
    setError(message);
    setStep({ kind: 'find' });
  }, []);

  function byCode(e: FormEvent): void {
    e.preventDefault();
    const c = walletCodeOf(code);
    if (!c) return setError('El código del cliente tiene 6 letras o números.');
    void find(c);
  }

  async function tapAndGive(found: Found): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const nfc = await read();
      const out = await giveFicha({
        walletId: found.saldo.walletId,
        card: nfc.token,
        ...(nfc.uid ? { uid: nfc.uid } : {}),
        ...(found.proof ? { proof: found.proof } : {}),
        ...(found.pin ? { pin: found.pin } : {}),
      });
      setStep({ kind: 'done', out });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const message = (err as Error).message;
      // PIN mal: otra vez el PIN (el contador de fallos lo lleva el servidor).
      if (found.pin && /PIN/.test(message)) return setStep({ kind: 'pin', found: { saldo: found.saldo }, error: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'done') {
    const { out } = step;
    const ficha = out.printedNumber ?? (out.fichaNumber !== null ? String(out.fichaNumber).padStart(4, '0') : null);
    return (
      <StaffOutcome
        kind="paid"
        amountCents={out.balanceCents}
        message="Ficha dada"
        detail={<p>{`Saldo ${out.code}${ficha ? ` · ficha nº ${ficha}` : ''}. Ya puede pagar acercándola.`}</p>}
        primary={{ label: 'Otra ficha', onClick: () => { setCode(''); setStep({ kind: 'find' }); } }}
        secondary={{ label: 'Volver', onClick: onDone }}
      />
    );
  }

  if (step.kind === 'pin') {
    const { found } = step;
    return (
      <PinPad
        mode="enter"
        title={`Saldo ${found.saldo.code}`}
        hint={step.error ?? 'Pásale el móvil al cliente para que ponga su PIN'}
        onCancel={() => setStep({ kind: 'find' })}
        onPin={async (pin) => {
          setStep({ kind: 'tap', found: { ...found, pin } });
          return null;
        }}
      />
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Dar ficha a un saldo</p>
      {step.kind === 'tap' ? (
        <>
          <p className="np-num" style={amountStyle}>
            {formatEur(step.found.saldo.balanceCents, { compact: true })}
          </p>
          <p style={big}>Saldo {step.found.saldo.code}</p>
          <p style={muted}>Ahora acerca una ficha: queda unida a este saldo.</p>
          {reading ? (
            <Button size="lg" variant="ghost" onClick={() => reading.abort()}>
              Acerca la ficha… (cancelar)
            </Button>
          ) : (
            <Button size="lg" loading={busy} disabled={!reader.via} onClick={() => void tapAndGive(step.found)}>
              Acercar la ficha
            </Button>
          )}
          {!reader.loading && !reader.via && reader.note ? <p style={note}>{reader.note}</p> : null}
        </>
      ) : (
        <>
          <p style={big}>¿Cargó su saldo desde casa?</p>
          <p style={muted}>Que te enseñe el QR de su saldo en su móvil, o teclea su código{manager ? '' : ' (y pondrá su PIN)'}.</p>
          {!nfcOn ? <p style={note}>«Fichas NFC» está apagado en Ajustes: no se pueden dar fichas.</p> : null}
          {step.kind === 'scan' ? (
            <QrScanner onScan={onScan} onError={onScanError} />
          ) : qrScanSupported() ? (
            <Button size="lg" disabled={busy || !nfcOn} onClick={() => setStep({ kind: 'scan' })}>
              Escanear su QR
            </Button>
          ) : null}
          <form onSubmit={byCode} style={formStyle}>
            <Input
              label="Código del saldo"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="K7Q-4M2"
              autoCapitalize="characters"
              autoComplete="off"
              disabled={busy || !nfcOn}
            />
            <Button type="submit" size="lg" variant="ghost" loading={busy} disabled={!nfcOn || code.replace(/-/g, '').length < 6}>
              Buscar con el código
            </Button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" disabled={reading !== null} onClick={step.kind === 'find' ? onDone : () => setStep({ kind: 'find' })}>
        Volver
      </Button>
    </Card>
  );
}

const cardStyle: CSSProperties = { padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)', textAlign: 'center' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const amountStyle: CSSProperties = { margin: 0, fontSize: '2.5rem', lineHeight: 1.15, fontWeight: 700 };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--np-danger)', fontWeight: 600 };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem', textAlign: 'left' };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
