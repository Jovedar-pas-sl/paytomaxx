'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { GivenFicha } from '@nightpay/contracts';
import { Button, Input } from '@nightpay/ui';
import type { OperatorUser } from '@/lib/api';
import { giveFicha, readFichaQr, walletCodeOf } from '@/lib/give-ficha';
import { formatEur } from '@/lib/money';
import { fetchReceptionDesk, fichaGivenNote, noPinLimitCents, type ReceptionDeskSaldo } from '@/lib/reception-desk';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { PinPad } from '../PinPad';
import { QrScanner, qrScanSupported } from '../QrScanner';
import { StaffOutcome } from '../StaffOutcome';
import { ContactPhoneField } from './desk/ContactPhone';
import { DESK_FIELD } from './desk/desk-parts';
import r from './reception.module.css';
import { useReadNfc } from './use-read-nfc';

/** B5: la espera de la ficha que se lee sola se corta a este tiempo. */
const AUTO_READ_MS = 60_000;

/** Lo encontrado y cómo prueba el cliente que es suyo (su QR o su PIN; el encargado, ninguna). */
interface Found {
  saldo: ReceptionDeskSaldo;
  proof?: string;
  pin?: string;
}

type Step = { kind: 'find' } | { kind: 'scan' } | { kind: 'pin'; found: Found; error?: string } | { kind: 'tap'; found: Found } | { kind: 'done'; out: GivenFicha; hasPin: boolean };

/**
 * Recepción → «Dar ficha a un saldo»: el cliente que cargó su saldo desde
 * casa (o cualquiera sin ficha) llega y pide una ficha. Se busca su saldo
 * con el QR de su saldo (en su móvil) o con su código; con el código, el
 * cliente pone su PIN (el encargado y el dueño no lo necesitan). Después se
 * acerca una ficha y queda unida a ese saldo. Solo la primera ficha.
 */
export function GiveFicha({
  user,
  onDone,
  initialCode,
  scanFirst = false,
}: {
  user: OperatorUser;
  onDone: () => void;
  initialCode?: string;
  /** B5: desde «Escanear su QR (cargó en casa)»: la cámara, ya puesta. */
  scanFirst?: boolean;
}) {
  const nfcOn = useVenueMethods().nfc;
  const noPinMaxCents = noPinLimitCents(useVenueNight());
  const { reader, reading, read } = useReadNfc();
  const [step, setStep] = useState<Step>(() => (scanFirst && qrScanSupported() ? { kind: 'scan' } : { kind: 'find' }));
  // Desde un saldo sin ficha en el mostrador (A7): su código ya escrito; se busca como siempre.
  const [code, setCode] = useState(initialCode ?? '');
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

  /**
   * Acercar la ficha y darla. Sola (B5, tras «Escanear su QR»): la espera se
   * corta al minuto, una ficha en blanco se graba en el mismo gesto y solo vale
   * una nueva o del stock (onlyStock: el servidor no da la de otro saldo, aunque
   * esté gastado). La misma ficha leída otra vez no hace nada (el servidor
   * devuelve lo de antes).
   */
  async function tapAndGive(found: Found, auto = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const nfc = await read(auto ? { writeBlank: true, timeoutMs: AUTO_READ_MS } : {});
      const out = await giveFicha({
        walletId: found.saldo.walletId,
        card: nfc.token,
        ...(nfc.uid ? { uid: nfc.uid } : {}),
        ...(found.proof ? { proof: found.proof } : {}),
        ...(found.pin ? { pin: found.pin } : {}),
        ...(auto ? { onlyStock: true as const } : {}),
      });
      setStep({ kind: 'done', out, hasPin: found.saldo.hasPin });
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

  // B5: con el saldo encontrado, la ficha nueva se lee sola (una vez por saldo; si falla, queda el botón).
  const autoRead = useRef<Found | null>(null);
  useEffect(() => {
    if (step.kind !== 'tap' || !reader.via || busy || reading || autoRead.current === step.found) return;
    autoRead.current = step.found;
    void tapAndGive(step.found, true);
  });

  if (step.kind === 'done') {
    const { out } = step;
    const ficha = out.printedNumber ?? (out.fichaNumber !== null ? String(out.fichaNumber).padStart(4, '0') : null);
    return (
      <StaffOutcome
        kind="paid"
        sound="ficha"
        amountCents={out.balanceCents}
        message="Ficha dada"
        detail={
          <>
            <p>{`Saldo ${out.code}${ficha ? ` · ficha nº ${ficha}` : ''}. ${fichaGivenNote(step.hasPin, noPinMaxCents)}`}</p>
            {/* Su teléfono, si quiere: solo para encontrar su saldo si pierde la ficha. */}
            <ContactPhoneField walletId={out.walletId} />
          </>
        }
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
    <div className={r.card}>
      <p className={r.kicker}>Dar ficha a un saldo</p>
      {step.kind === 'tap' ? (
        <>
          {/* El código del saldo en grande (B5): que el cliente vea que es el suyo mientras se espera la ficha. */}
          <p className={r.kicker}>Su código</p>
          <p className={`np-num ${r.amount}`}>{step.found.saldo.code}</p>
          <p className={r.lead}>Le quedan {formatEur(step.found.saldo.balanceCents, { compact: true })}</p>
          <p className={r.text}>Ahora acerca una ficha nueva o del stock: queda unida a este saldo.</p>
          {reading ? (
            <Button variant="ghost" onClick={() => reading.abort()}>
              Acerca la ficha… (cancelar)
            </Button>
          ) : (
            <Button size="lg" loading={busy} disabled={!reader.via} onClick={() => void tapAndGive(step.found)} data-tour="dar-acercar">
              Acercar la ficha
            </Button>
          )}
          {!reader.loading && !reader.via && reader.note ? <p className={r.note}>{reader.note}</p> : null}
        </>
      ) : (
        <>
          <p className={r.lead}>¿Cargó su saldo desde casa?</p>
          <p className={r.text}>Que te enseñe el QR de su saldo en su móvil, o teclea su código{manager ? '' : ' (y pondrá su PIN)'}.</p>
          {!nfcOn ? <p className={r.note}>«Fichas NFC» está apagado en Ajustes: no se pueden dar fichas.</p> : null}
          {step.kind === 'scan' ? (
            <QrScanner onScan={onScan} onError={onScanError} />
          ) : qrScanSupported() ? (
            <Button size="lg" disabled={busy || !nfcOn} onClick={() => setStep({ kind: 'scan' })} data-tour="dar-escanear">
              Escanear su QR
            </Button>
          ) : null}
          <form onSubmit={byCode} className={r.form} data-tour="dar-codigo">
            <Input
              label="Código del saldo"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="K7Q-4M2"
              autoCapitalize="characters"
              autoComplete="off"
              disabled={busy || !nfcOn}
              style={DESK_FIELD}
            />
            <Button type="submit" variant="ghost" loading={busy} disabled={!nfcOn || code.replace(/-/g, '').length < 6}>
              Buscar con el código
            </Button>
          </form>
        </>
      )}
      {error ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" disabled={reading !== null} onClick={step.kind === 'find' ? onDone : () => setStep({ kind: 'find' })} data-tour="dar-volver">
        Volver
      </Button>
    </div>
  );
}
