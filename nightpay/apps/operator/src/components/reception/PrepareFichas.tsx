'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { isPrintedFichaNumber, walletCardUrl } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';
import { blankCodeFrom, isChipTimeout, isFatalChipError, tapChip } from '@/lib/chip-tap';
import { deviceBackend, preparedText, staffBackend, stockOutcomeLine, type PrepareLine } from '@/lib/reception';
import { nextPrintedNumber, notFollowingText } from '@/lib/ficha-number';
import { isSameTapAgain, needsPrintedNumber } from '@/lib/prepare-fichas';
import { FichaNumber } from './desk/desk-parts';
import r from './reception.module.css';
import { useChipReader } from './use-chip-via';

/** Líneas que se ven (la más nueva arriba). */
const MAX_LINES = 8;

interface Props {
  on: 'device' | 'staff';
  onDone: () => void;
}

/**
 * «Preparar fichas»: acercar, acercar, acercar. Cada ficha en blanco se graba
 * con un código del servidor y queda en el stock del local; una ya grabada se
 * mira: si es de un saldo gastado vuelve al stock, si es de un cliente con
 * saldo (o perdida, bloqueada, de otro local) se dice y se aparta. Nunca se
 * graba encima de una ficha con algo. El contador cuenta las preparadas.
 */
export function PrepareFichas({ on, onDone }: Props) {
  const backend = on === 'device' ? deviceBackend : staffBackend;
  const reader = useChipReader();
  const [running, setRunning] = useState<AbortController | null>(null);
  const [count, setCount] = useState(0);
  const [pending, setPending] = useState<{ card: string; uid: string; line: PrepareLine } | null>(null);
  const [printedNumber, setPrintedNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [numberError, setNumberError] = useState<string | null>(null);
  const [lines, setLines] = useState<Array<PrepareLine & { id: number }>>([]);
  // El número impreso de la última ficha (guardado ahora o el que ya tenía): el siguiente debería seguirle (A12).
  const [lastPrinted, setLastPrinted] = useState<string | null>(null);
  // El bucle de lectura no se vuelve a crear en cada pintada: lee la última de aquí.
  const lastPrintedRef = useRef<string | null>(null);
  lastPrintedRef.current = lastPrinted;
  /** Código pedido para la próxima ficha en blanco (se reutiliza si no se intentó grabar). */
  const blank = useMemo(
    () => blankCodeFrom(() => backend.newToken(), (token) => walletCardUrl(window.location.origin, token)),
    [backend],
  );
  const lastTap = useRef<{ uid: string | null; at: number } | null>(null);
  const seq = useRef(0);

  useEffect(() => () => running?.abort(), [running]);

  function addLine(line: PrepareLine): void {
    seq.current += 1;
    const id = seq.current;
    setLines((prev) => [{ ...line, id }, ...prev].slice(0, MAX_LINES));
    if (line.counts) setCount((n) => n + 1);
    // Se preparan mirando las fichas, no la pantalla: lo que hay que apartar suena y vibra.
    if (line.tone === 'warn') playOutcomeSound('warn');
  }

  /** La línea de esta ficha; la misma ficha no se vuelve a mirar unos segundos. */
  function answered(uid: string | null, line: PrepareLine): void {
    lastTap.current = { uid, at: Date.now() };
    addLine(line);
  }

  async function oneTap(signal: AbortSignal): Promise<'number-needed' | void> {
    if (!reader.via) return;
    const tap = await tapChip(reader.via, signal, reader.canWrite ? blank : undefined);
    // La misma ficha sigue apoyada: no se cuenta dos veces.
    if (isSameTapAgain(lastTap.current, tap.uid, Date.now())) return;
    if (tap.other) {
      answered(tap.uid, { tone: 'warn', text: 'Tiene otra cosa grabada: no se toca, apártala', counts: false });
      return;
    }
    if (!tap.token) {
      answered(tap.uid, { tone: 'warn', text: reader.note ?? 'Ficha en blanco: aquí no se puede grabar', counts: false });
      return;
    }
    // Solo cuando el servidor contesta: si falla, acercarla otra vez la vuelve a mirar.
    const outcome = await backend.stock(tap.token, tap.uid);
    if ('printedNumber' in outcome && outcome.printedNumber) setLastPrinted(outcome.printedNumber);
    if (backend.labelStock && needsPrintedNumber(outcome)) {
      if (!tap.uid) throw new Error('No se pudo leer la serie NFC: acerca la ficha otra vez');
      setPending({ card: tap.token, uid: tap.uid, line: stockOutcomeLine(outcome) });
      // B11: propone el siguiente al de la anterior (se acepta con un toque o se cambia); sin anterior, se teclea.
      setPrintedNumber(nextPrintedNumber(lastPrintedRef.current) ?? '');
      setNumberError(null);
      // Stop the reader while the physical number is entered; count only after saving.
      return 'number-needed';
    }
    answered(tap.uid, stockOutcomeLine(outcome));
  }

  async function loop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      // Una lectura por ficha: la anterior se corta antes de esperar la siguiente.
      const one = new AbortController();
      const stop = () => one.abort();
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        if ((await oneTap(one.signal)) === 'number-needed') controller.abort();
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) break;
        if (isChipTimeout(err)) continue;
        addLine({ tone: 'warn', text: (err as Error).message, counts: false });
        if (isFatalChipError(err)) break;
      } finally {
        one.abort();
        controller.signal.removeEventListener('abort', stop);
      }
    }
  }

  async function saveNumber(): Promise<void> {
    if (!pending || !backend.labelStock || !isPrintedFichaNumber(printedNumber) || saving) return;
    setSaving(true);
    setNumberError(null);
    try {
      await backend.labelStock(pending.card, pending.uid, printedNumber);
      setLastPrinted(printedNumber);
      answered(pending.uid, { ...pending.line, text: `Ficha ${printedNumber} \u00b7 ${pending.line.text}` });
      setPending(null);
      start();
    } catch (err) {
      setNumberError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function start(): void {
    const controller = new AbortController();
    setRunning(controller);
    void loop(controller).finally(() => setRunning((cur) => (cur === controller ? null : cur)));
  }

  function stop(): void {
    running?.abort();
    setRunning(null);
  }

  return (
    <div className={r.card}>
      <p className={r.kicker}>Preparar fichas</p>
      <p className={r.counter} aria-live="polite" data-tour="prep-contador">
        {count}
      </p>
      <p className={r.text}>{preparedText(count)} en el stock de este local</p>

      {reader.loading ? <p className={r.text}>Mirando el lector de fichas…</p> : null}
      {!reader.loading && (!reader.via || !reader.canWrite) ? <p className={r.note}>{reader.note}</p> : null}

      {pending ? (
        <form onSubmit={(event) => { event.preventDefault(); void saveNumber(); }} className={r.form} data-tour="prep-numero">
          <label htmlFor="ficha-printed-number" className={r.lead}>Número impreso en esta ficha</label>
          <input id="ficha-printed-number" className={r.field} autoFocus inputMode="numeric" autoComplete="off" pattern="[0-9]{1,12}" maxLength={12} value={printedNumber} onChange={(event) => setPrintedNumber(event.target.value)} />
          <p className={r.text}>
            {nextPrintedNumber(lastPrinted) ? 'Te proponemos la siguiente: compruébala con la ficha y cámbiala si no es.' : 'Copia las cifras tal como aparecen, incluidos los ceros iniciales.'}
          </p>
          {/* Lo tecleado, en grande y en grupos de 4 como en la ficha; si no sigue a la anterior, se avisa (A12). */}
          {printedNumber ? <FichaNumber printed={printedNumber} className={r.typedFicha} /> : null}
          {notFollowingText(lastPrinted, printedNumber) ? (
            <p role="status" className={r.followWarn}>
              {notFollowingText(lastPrinted, printedNumber)}
            </p>
          ) : null}
          {numberError ? <p role="alert" className={r.error}>{numberError}</p> : null}
          <Button size="lg" type="submit" disabled={saving || !isPrintedFichaNumber(printedNumber)}>{saving ? 'Guardando...' : 'Guardar y seguir'}</Button>
        </form>
      ) : running ? (
        <>
          <p className={r.lead}>Acerca una ficha, retírala y acerca la siguiente</p>
          <Button variant="ghost" onClick={stop} data-tour="prep-accion">
            Parar
          </Button>
        </>
      ) : (
        <Button size="lg" disabled={!reader.via} onClick={start} data-tour="prep-accion">
          {count > 0 ? 'Seguir preparando' : 'Empezar'}
        </Button>
      )}

      {lines.length > 0 ? (
        <ul role="log" aria-live="polite" className={r.log} aria-label="Últimas fichas" data-tour="prep-registro">
          {lines.map((l) => (
            <li key={l.id} className={r.logLine}>
              <span className={r.logMark} style={{ color: TONE[l.tone] }}>{l.tone === 'warn' ? '!' : '✓'}</span> <span>{l.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Button variant="ghost" disabled={running !== null || saving} onClick={onDone}>
        Volver
      </Button>
    </div>
  );
}

/** El color de la marca de cada línea (siempre con su signo: ✓ o !). */
const TONE: Record<PrepareLine['tone'], string> = {
  ok: 'var(--np-success)',
  info: 'var(--np-text-mute)',
  warn: 'var(--np-warning)',
};
