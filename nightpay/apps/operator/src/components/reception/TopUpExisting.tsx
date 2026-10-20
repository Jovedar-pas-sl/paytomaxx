'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { MAX_CASH_TOP_UP_CENTS, type ReceptionOptions } from '@nightpay/contracts';
import { AmountKeypad, Button, Card, Input } from '@nightpay/ui';
import { createPayment, fetchTerminals, type CreatedPayment } from '@/lib/api';
import { receptionLookupCode, startPendingTopUp } from '@/lib/api-noche';
import { formatEur } from '@/lib/money';
import {
  cardMethodLabel,
  existingCashDetail,
  methodChoices,
  newReceptionKey,
  receptionAttempt,
  receptionWhat,
  staffBackend,
  targetLabel,
  walletOfTarget,
  type ExistingTarget,
  type PayMethod,
  type ReceptionAttempt,
} from '@/lib/reception';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { ActivePayment } from '../ActivePayment';
import { StaffOutcome } from '../StaffOutcome';
import { AssignTopUp } from './AssignTopUp';
import { useReadNfc } from './use-read-nfc';

type Step =
  | { kind: 'saldo' }
  /** `target` null: plan B, cobrar primero sin su NFC (se asigna después). */
  | { kind: 'amount'; target: ExistingTarget | null }
  | { kind: 'method'; target: ExistingTarget }
  | { kind: 'cash'; target: ExistingTarget }
  | { kind: 'cardQr'; payment: CreatedPayment }
  | { kind: 'pendingQr'; payment: CreatedPayment }
  | { kind: 'assign'; walletId: string; amountCents: number }
  | { kind: 'done'; message: string; detail: string };

interface Props {
  /** Volver a cobrar (sin él, no hay otra cosa que hacer en Inicio). */
  onExit?: () => void;
  /** Recarga cobrada: refrescar lo de la chica. */
  onDone: () => void;
}

/**
 * Inicio → «Recargar saldo»: un saldo que ya existe (los nuevos se dan de
 * alta en Recepción).
 *   1. El saldo: su NFC (lo recomendado, antes de cobrar) o su código.
 *   2. El importe (con los importes rápidos del local).
 *   3. Tarjeta: el cliente paga el QR en su móvil y se suma a ese saldo.
 *      Efectivo: solo con el permiso «cobrar recargas en efectivo».
 * Plan B, si su NFC no se pudo leer: se cobra primero (tarjeta) y la recarga
 * queda pendiente de asignar hasta que se acerca su NFC o se teclea su código.
 * La maquinaria de la recepción de siempre (/v1/reception, lib/reception).
 */
export function TopUpExisting({ onExit, onDone }: Props) {
  const night = useVenueNight();
  const nfcOn = useVenueMethods().nfc;
  const { reader, reading, read } = useReadNfc();
  const [options, setOptions] = useState<ReceptionOptions | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'saldo' });
  const [amountCents, setAmountCents] = useState(0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Una clave por recarga: repetir lo mismo (corte, doble toque) no carga dos veces.
  const attempt = useRef<ReceptionAttempt | null>(null);
  const pendingKey = useRef<{ amountCents: number; key: string } | null>(null);

  useEffect(() => {
    staffBackend
      .options()
      .then(setOptions)
      .catch((err: Error) => setError(err.message));
  }, []);

  function restart(): void {
    attempt.current = null;
    pendingKey.current = null;
    setAmountCents(0);
    setCode('');
    setError(null);
    setStep({ kind: 'saldo' });
  }

  async function run(task: () => Promise<void>): Promise<void> {
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

  function keyFor(method: PayMethod, target: ExistingTarget): string {
    attempt.current = receptionAttempt(attempt.current, receptionWhat(amountCents, method, target));
    return attempt.current.key;
  }

  async function payByCard(target: ExistingTarget): Promise<void> {
    const terminal = (await fetchTerminals())[0]?.externalId;
    if (!terminal) throw new Error('No hay terminales configurados en el local');
    const payment = await createPayment({
      amountCents,
      terminalExternalId: terminal,
      idempotencyKey: keyFor('card', target),
      walletId: target.view.walletId,
    });
    setStep({ kind: 'cardQr', payment });
  }

  /** Plan B: cobrar primero (tarjeta) a una recarga pendiente de asignar. */
  async function payFirst(): Promise<void> {
    if (pendingKey.current?.amountCents !== amountCents) pendingKey.current = { amountCents, key: newReceptionKey() };
    setStep({ kind: 'pendingQr', payment: await startPendingTopUp(amountCents, pendingKey.current.key) });
  }

  if (step.kind === 'cardQr' || step.kind === 'pendingQr') {
    const { payment } = step;
    // Sin el saldo nuevo del cobro: es el de siempre del cliente (o, en el plan B, el provisional).
    return (
      <ActivePayment
        payment={{ ...payment, walletId: null }}
        isPos={false}
        label={step.kind === 'cardQr' ? 'Recarga del saldo' : 'Recarga (se asigna después)'}
        onPaid={() => {
          onDone();
          if (step.kind === 'pendingQr' && payment.walletId) {
            setStep({ kind: 'assign', walletId: payment.walletId, amountCents: payment.amountCents });
          }
        }}
        onClose={restart}
      />
    );
  }

  if (step.kind === 'assign') {
    return (
      <AssignTopUp
        walletId={step.walletId}
        amountCents={step.amountCents}
        onAssigned={(out) =>
          setStep({
            kind: 'done',
            message: 'Recarga asignada',
            detail: `Saldo ${out.codeHint} · tiene ${formatEur(out.balanceCents)}`,
          })
        }
        onLater={restart}
      />
    );
  }

  if (step.kind === 'done') {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={amountCents}
        message={step.message}
        detail={<p>{step.detail}</p>}
        primary={{ label: 'Otra recarga', onClick: restart }}
        secondary={onExit ? { label: 'Volver a cobrar', onClick: onExit } : undefined}
      />
    );
  }

  const quick = night.receptionQuickAmountsCents;
  return (
    <Card style={cardStyle}>
      <p style={kicker}>Recargar saldo</p>

      {step.kind === 'saldo' ? (
        <>
          <p style={big}>¿Qué saldo?</p>
          {nfcOn && options?.nfc !== false ? (
            reading ? (
              <Button size="lg" variant="ghost" onClick={() => reading.abort()}>
                Acerca su NFC… (cancelar)
              </Button>
            ) : (
              <Button
                size="lg"
                disabled={busy || !reader.via}
                onClick={() =>
                  void run(async () => {
                    const nfc = await read();
                    const view = await staffBackend.lookup(nfc.token, nfc.uid);
                    setStep({ kind: 'amount', target: { kind: 'card', card: nfc.token, uid: nfc.uid, view } });
                  })
                }
              >
                Acercar su NFC
              </Button>
            )
          ) : null}
          {nfcOn && !reader.loading && !reader.via && reader.note ? <p style={note}>{reader.note}</p> : null}
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                const view = await receptionLookupCode(code);
                setStep({ kind: 'amount', target: { kind: 'code', code, view } });
              });
            }}
            style={formStyle}
          >
            <Input
              label="O su código"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="K7Q-4M2"
              autoCapitalize="characters"
              autoComplete="off"
              disabled={busy}
            />
            <Button type="submit" variant="ghost" size="lg" loading={busy} disabled={code.replace(/-/g, '').length < 6}>
              Buscar su saldo
            </Button>
          </form>
          {options?.card ? (
            <button type="button" style={linkBtnStyle} disabled={busy || reading !== null} onClick={() => setStep({ kind: 'amount', target: null })}>
              ¿No se lee su NFC? Cobrar primero y asignarla después
            </button>
          ) : null}
          <p style={note}>Los saldos nuevos se dan de alta en Recepción.</p>
          {onExit ? (
            <Button variant="ghost" onClick={onExit} disabled={busy}>
              Volver a cobrar
            </Button>
          ) : null}
        </>
      ) : null}

      {step.kind === 'amount' ? (
        <>
          <p style={muted}>{step.target ? targetLabel(step.target) : 'Sin su NFC: se asigna a su saldo al pagar'}</p>
          {quick.length > 0 ? (
            <div style={quickRow}>
              {quick.map((c) => (
                <Button key={c} variant={amountCents === c ? 'primary' : 'ghost'} aria-pressed={amountCents === c} onClick={() => setAmountCents(c)}>
                  {formatEur(c, { compact: true })}
                </Button>
              ))}
            </div>
          ) : null}
          <AmountKeypad valueCents={amountCents} onChange={setAmountCents} label="Importe a cargar" disabled={busy} />
          <Button
            size="lg"
            loading={busy}
            disabled={amountCents <= 0}
            onClick={() => {
              const target = step.target;
              if (target) setStep({ kind: 'method', target });
              else void run(payFirst);
            }}
          >
            {step.target ? 'Siguiente' : amountCents > 0 ? `Cobrar ${formatEur(amountCents, { compact: true })} con tarjeta` : 'Cobrar con tarjeta'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={restart}>
            Otro saldo
          </Button>
        </>
      ) : null}

      {step.kind === 'method' ? (
        <MethodStep
          amountCents={amountCents}
          options={options}
          target={step.target}
          preferred={night.receptionDefaultMethod}
          busy={busy}
          onCard={() => void run(() => payByCard(step.target))}
          onCash={() => setStep({ kind: 'cash', target: step.target })}
          onBack={() => setStep({ kind: 'amount', target: step.target })}
        />
      ) : null}

      {step.kind === 'cash' ? (
        <>
          <p className="np-num" style={amountStyle}>
            {formatEur(amountCents)}
          </p>
          <p style={big}>Cobra {formatEur(amountCents)} en efectivo</p>
          <p style={muted}>{targetLabel(step.target)}. Guarda el dinero en la caja y pulsa «Cobrado».</p>
          <Button
            size="lg"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const target = step.target;
                const out = await staffBackend.cash({ amountCents, idempotencyKey: keyFor('cash', target), wallet: walletOfTarget(target) });
                onDone();
                setStep({ kind: 'done', message: 'Recargado en efectivo', detail: existingCashDetail(out) });
              })
            }
          >
            Cobrado
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setStep({ kind: 'method', target: step.target })}>
            Atrás
          </Button>
        </>
      ) : null}

      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

/** Tarjeta (a todos) o efectivo (con permiso), la de por defecto del local primero y en grande. */
function MethodStep(props: {
  amountCents: number;
  options: ReceptionOptions | null;
  target: ExistingTarget;
  preferred: PayMethod;
  busy: boolean;
  onCard: () => void;
  onCash: () => void;
  onBack: () => void;
}) {
  const { amountCents, options, target } = props;
  const choices = options ? methodChoices(options, target, props.preferred) : [];
  const cashTooBig = amountCents > MAX_CASH_TOP_UP_CENTS;
  return (
    <>
      <p className="np-num" style={amountStyle}>
        {formatEur(amountCents)}
      </p>
      <p style={muted}>{targetLabel(target)}</p>
      <p style={big}>¿Cómo paga?</p>
      {!options ? <p style={muted}>Cargando…</p> : null}
      {options && choices.length === 0 ? <p style={note}>{options.cashBlockedReason ?? 'Ahora no se pueden hacer recargas en este local.'}</p> : null}
      {choices.map(({ method, problem }, i) => (
        <Button
          key={method}
          size="lg"
          variant={i === 0 ? 'primary' : 'ghost'}
          loading={props.busy && method === 'card'}
          disabled={props.busy || problem !== null || (method === 'cash' && cashTooBig)}
          onClick={method === 'card' ? props.onCard : props.onCash}
        >
          {method === 'card' ? cardMethodLabel('staff') : 'Efectivo'}
        </Button>
      ))}
      {choices.map(({ method, problem }) => (problem ? <p key={`p-${method}`} style={note}>{problem}</p> : null))}
      {cashTooBig && choices.some((c) => c.method === 'cash') ? <p style={note}>En efectivo, como mucho 999,99 € por recarga.</p> : null}
      <Button variant="ghost" disabled={props.busy} onClick={props.onBack}>
        Cambiar el importe
      </Button>
    </>
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
const quickRow: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(5rem, 1fr))', gap: '0.5rem' };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
// 44 px de alto: se toca bien aunque parezca un enlace.
const linkBtnStyle: CSSProperties = {
  minHeight: '2.75rem',
  background: 'transparent',
  border: 'none',
  color: 'var(--np-text-mute)',
  fontSize: '0.9375rem',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: '0 0.5rem',
};
