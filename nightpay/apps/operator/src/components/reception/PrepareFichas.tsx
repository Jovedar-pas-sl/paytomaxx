'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { walletCardUrl } from '@nightpay/contracts';
import { Button, Card } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';
import { blankCodeFrom, isChipTimeout, isFatalChipError, tapChip } from '@/lib/chip-tap';
import { deviceBackend, preparedText, staffBackend, stockOutcomeLine, type PrepareLine } from '@/lib/reception';
import { isSameTapAgain } from '@/lib/prepare-fichas';
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
  const [lines, setLines] = useState<Array<PrepareLine & { id: number }>>([]);
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

  async function oneTap(signal: AbortSignal): Promise<void> {
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
    answered(tap.uid, stockOutcomeLine(outcome));
  }

  async function loop(controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      // Una lectura por ficha: la anterior se corta antes de esperar la siguiente.
      const one = new AbortController();
      const stop = () => one.abort();
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        await oneTap(one.signal);
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
    <Card style={cardStyle}>
      <p style={kicker}>Preparar fichas</p>
      <p className="np-num" style={counterStyle} aria-live="polite">
        {count}
      </p>
      <p style={muted}>{preparedText(count)} en el stock de este local</p>

      {reader.loading ? <p style={muted}>Mirando el lector de fichas…</p> : null}
      {!reader.loading && (!reader.via || !reader.canWrite) ? <p style={note}>{reader.note}</p> : null}

      {running ? (
        <>
          <p style={big}>Acerca una ficha, retírala y acerca la siguiente</p>
          <Button variant="ghost" onClick={stop}>
            Parar
          </Button>
        </>
      ) : (
        <Button size="lg" disabled={!reader.via} onClick={start}>
          {count > 0 ? 'Seguir preparando' : 'Empezar'}
        </Button>
      )}

      {lines.length > 0 ? (
        <ul role="log" aria-live="polite" style={listStyle} aria-label="Últimas fichas">
          {lines.map((l) => (
            <li key={l.id} style={{ ...lineStyle, borderColor: TONE[l.tone] }}>
              <span style={{ color: TONE[l.tone], fontWeight: 700 }}>{l.tone === 'warn' ? '!' : '✓'}</span> {l.text}
            </li>
          ))}
        </ul>
      ) : null}

      <Button variant="ghost" disabled={running !== null} onClick={onDone}>
        Volver
      </Button>
    </Card>
  );
}

const TONE: Record<PrepareLine['tone'], string> = {
  ok: 'var(--np-success)',
  info: 'var(--np-text-mute)',
  warn: 'var(--np-warning)',
};

const cardStyle: CSSProperties = { padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'center' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const counterStyle: CSSProperties = { margin: 0, fontSize: '4rem', fontWeight: 800, lineHeight: 1 };
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.25rem', fontWeight: 700 };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem', textAlign: 'left' };
const lineStyle: CSSProperties = {
  padding: '0.5rem 0.75rem',
  border: '1px solid',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.95rem',
};
