'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { isPrintedFichaNumber, type ReplacedFicha } from '@nightpay/contracts';
import { Button, Input } from '@nightpay/ui';
import type { OperatorUser } from '@/lib/api';
import { readFichaQr, walletCodeOf } from '@/lib/give-ficha';
import { lostFichaPlan, replaceLostFicha } from '@/lib/lost-ficha';
import { formatEur } from '@/lib/money';
import { fetchFichaByNumber, fetchReceptionDesk } from '@/lib/reception-desk';
import { useVenueNight } from '@/lib/venue-methods';
import { PinPad } from '../PinPad';
import { QrScanner, qrScanSupported } from '../QrScanner';
import { StaffOutcome } from '../StaffOutcome';
import { DESK_FIELD, FichaNumber } from './desk/desk-parts';
import r from './reception.module.css';
import { useReadNfc } from './use-read-nfc';

/** El saldo encontrado: por su QR o su código (walletId) o por el número de la ficha perdida. */
interface Found {
  ref: { walletId: string } | { printedNumber: string };
  /** «Saldo K7Q-4M2» o «Ficha nº 0000 1013 · K7Q-•••». */
  label: string;
  balanceCents: number;
  proof?: string;
  pin?: string;
}

type Step =
  | { kind: 'find' }
  | { kind: 'scan' }
  | { kind: 'pin'; found: Found; error?: string }
  | { kind: 'confirm'; found: Found }
  | { kind: 'done'; out: ReplacedFicha };

/**
 * Recepción → «Ficha perdida» (B6): el cliente perdió su ficha y le das otra.
 * Prueba que el saldo es suyo con su QR, o con su código o el número de su
 * ficha y su PIN (el encargado y el dueño, sin prueba). Antes de acercar la
 * nueva, la pantalla dice cuánto cuesta (Ajustes → Noche) y cuánto le
 * quedará; si no le llega, se dice y no se hace. Al acercar la nueva, la
 * vieja deja de pagar y la nueva se cobra del saldo, en la misma operación.
 */
export function LostFicha({ user, onDone }: { user: OperatorUser; onDone: () => void }) {
  const feeCents = useVenueNight().lostFichaFeeCents;
  const { reader, reading, read } = useReadNfc();
  const [step, setStep] = useState<Step>({ kind: 'find' });
  const [code, setCode] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = user.role === 'MANAGER' || user.role === 'OWNER';

  async function lookup(task: () => Promise<Found>, proof?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const found = { ...(await task()), ...(proof ? { proof } : {}) };
      setStep(proof || manager ? { kind: 'confirm', found } : { kind: 'pin', found });
    } catch (err) {
      setError((err as Error).message);
      setStep({ kind: 'find' });
    } finally {
      setBusy(false);
    }
  }

  // La cámara no se reinicia en cada pintada.
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const onScan = useCallback((text: string) => {
    const qr = readFichaQr(text);
    if ('problem' in qr) {
      setError(qr.problem);
      setStep({ kind: 'find' });
      return;
    }
    void lookupRef.current(byCode(qr.code), qr.proof);
  }, []);
  const onScanError = useCallback((message: string) => {
    setError(message);
    setStep({ kind: 'find' });
  }, []);

  async function tapAndReplace(found: Found): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const nfc = await read();
      const out = await replaceLostFicha({
        ...found.ref,
        card: nfc.token,
        ...(nfc.uid ? { uid: nfc.uid } : {}),
        ...(found.proof ? { proof: found.proof } : {}),
        ...(found.pin ? { pin: found.pin } : {}),
        feeCents,
      });
      setStep({ kind: 'done', out });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      const message = (err as Error).message;
      // PIN mal: otra vez el PIN (el contador de fallos lo lleva el servidor).
      if (found.pin && /PIN/.test(message)) return setStep({ kind: 'pin', found: { ...found, pin: undefined }, error: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'done') {
    const { out } = step;
    return (
      <StaffOutcome
        kind="paid"
        amountCents={out.balanceCents}
        message="Ficha nueva dada"
        detail={
          <p>
            {out.printedNumber ? `Ficha nº ${out.printedNumber}. ` : ''}
            {out.feeCents > 0 ? `Se han cobrado ${formatEur(out.feeCents, { compact: true })} de su saldo. ` : ''}
            La vieja ya no paga.
          </p>
        }
        primary={{ label: 'Volver', onClick: onDone }}
      />
    );
  }

  if (step.kind === 'pin') {
    const { found } = step;
    return (
      <PinPad
        mode="enter"
        title={found.label}
        hint={step.error ?? 'Pásale el móvil al cliente para que ponga su PIN'}
        onCancel={() => setStep({ kind: 'find' })}
        onPin={async (pin) => {
          setStep({ kind: 'confirm', found: { ...found, pin } });
          return null;
        }}
      />
    );
  }

  if (step.kind === 'confirm') {
    const { found } = step;
    const plan = lostFichaPlan(found.balanceCents, feeCents);
    return (
      <div className={r.card}>
        <p className={r.kicker}>Ficha perdida</p>
        <p className={r.lead}>{found.label}</p>
        <p className={r.amount}>{formatEur(found.balanceCents, { compact: true })}</p>
        <p className={plan.ok ? r.text : r.error} role={plan.ok ? undefined : 'alert'}>
          {plan.text}
        </p>
        {plan.ok ? (
          reading ? (
            <Button variant="ghost" onClick={() => reading.abort()}>
              Acerca la ficha nueva… (cancelar)
            </Button>
          ) : (
            <Button size="lg" loading={busy} disabled={!reader.via} onClick={() => void tapAndReplace(found)}>
              {feeCents > 0 ? `Cobrar ${formatEur(feeCents, { compact: true })} y acercar la nueva` : 'Acercar la ficha nueva'}
            </Button>
          )
        ) : null}
        {!reader.loading && !reader.via && reader.note ? <p className={r.note}>{reader.note}</p> : null}
        {error ? (
          <p role="alert" className={r.error}>
            {error}
          </p>
        ) : null}
        <Button variant="ghost" disabled={reading !== null} onClick={() => setStep({ kind: 'find' })}>
          Volver
        </Button>
      </div>
    );
  }

  function submitCode(e: FormEvent): void {
    e.preventDefault();
    const c = walletCodeOf(code);
    if (!c) return setError('El código del cliente tiene 6 letras o números.');
    void lookup(byCode(c));
  }

  function submitNumber(e: FormEvent): void {
    e.preventDefault();
    if (!isPrintedFichaNumber(number)) return setError('Escribe el número impreso de su ficha (de 1 a 12 cifras).');
    void lookup(byNumber(number));
  }

  return (
    <div className={r.card}>
      <p className={r.kicker}>Ficha perdida</p>
      <p className={r.lead}>¿Ha perdido su ficha?</p>
      <p className={r.text}>
        Que te enseñe el QR de su saldo, o busca su saldo por su código o por el número de su ficha{manager ? '' : ' (y pondrá su PIN)'}. La ficha nueva
        {feeCents > 0 ? ` cuesta ${formatEur(feeCents, { compact: true })} de su saldo` : ' no le cuesta nada'}.
      </p>
      {step.kind === 'scan' ? (
        <QrScanner onScan={onScan} onError={onScanError} />
      ) : qrScanSupported() ? (
        <Button size="lg" disabled={busy} onClick={() => setStep({ kind: 'scan' })}>
          Escanear su QR
        </Button>
      ) : null}
      <form onSubmit={submitCode} className={r.form}>
        <Input
          label="Su código"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          placeholder="K7Q-4M2"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={busy}
          style={DESK_FIELD}
        />
        <Button type="submit" variant="ghost" loading={busy} disabled={code.replace(/-/g, '').length < 6}>
          Buscar con el código
        </Button>
      </form>
      <form onSubmit={submitNumber} className={r.form}>
        <Input
          label="El número de su ficha"
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
          disabled={busy}
          style={DESK_FIELD}
        />
        {number ? <FichaNumber printed={number} className={r.typedFicha} /> : null}
        <Button type="submit" variant="ghost" loading={busy} disabled={!isPrintedFichaNumber(number)}>
          Buscar con el número
        </Button>
      </form>
      {error ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" disabled={reading !== null} onClick={step.kind === 'find' ? onDone : () => setStep({ kind: 'find' })}>
        Volver
      </Button>
    </div>
  );
}

/** Por su código (o el de su QR): el saldo, si tiene ficha que perder. */
function byCode(walletCode: string): () => Promise<Found> {
  return async () => {
    const view = await fetchReceptionDesk({ code: walletCode });
    if (view.kind !== 'saldo') throw new Error('No hay ningún saldo con ese código en este local');
    if (view.fichaNumber === null) throw new Error('Este saldo no tiene ficha: dásela con «Dar ficha a un saldo» (sin cobrar).');
    return { ref: { walletId: view.walletId }, label: `Saldo ${view.code}`, balanceCents: view.balanceCents };
  };
}

/** Por el número de la ficha perdida: solo el resumen (el código, tapado); sirve con su PIN. */
function byNumber(printed: string): () => Promise<Found> {
  return async () => {
    const view = await fetchFichaByNumber(printed);
    if (view.kind !== 'saldo') throw new Error('Esa ficha no tiene saldo: no hay nada que pasar a otra.');
    return { ref: { printedNumber: printed }, label: `Ficha nº ${printed} · ${view.codeHint}`, balanceCents: view.balanceCents };
  };
}
