'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MAX_CASH_TOP_UP_CENTS, walletCardUrl, type ReceptionOptions } from '@nightpay/contracts';
import { AmountKeypad, Button, Card } from '@nightpay/ui';
import { createPayment, fetchTerminals, type CreatedPayment } from '@/lib/api';
import { PENDING_CONFIRM_TEXT } from '@/lib/pax-api';
import { blankCodeFrom, tapChip } from '@/lib/chip-tap';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import {
  cardMethodLabel,
  deviceBackend,
  existingTopUpDetail,
  nextAfterPay,
  payProblem,
  receptionAttempt,
  receptionDetail,
  receptionWhat,
  staffBackend,
  topUpCheck,
  walletAfterCash,
  walletOfTarget,
  type DeviceCardSale,
  type PayMethod,
  type ReceptionAttempt,
  type ReceptionBackend,
  type ReceptionWallet,
  type Target,
  type TopUpCheck,
} from '@/lib/reception';
import { ActivePayment } from '../ActivePayment';
import { PaxChargeFlow } from '../pax/PaxChargeFlow';
import { PinPad } from '../PinPad';
import { StaffOutcome } from '../StaffOutcome';
import { useChipReader } from './use-chip-via';

type Step =
  | { kind: 'amount' }
  | { kind: 'method' }
  | { kind: 'target'; method: PayMethod }
  | { kind: 'cash'; target: Target }
  /** `existing`: la ficha que ya tenía (null: saldo nuevo). */
  | { kind: 'cardSale'; sale: DeviceCardSale; existing: (Target & { kind: 'card' }) | null }
  | { kind: 'cardQr'; payment: CreatedPayment }
  /** Recarga con tarjeta a una ficha que ya tenía: se pregunta cómo quedó (topups/:paymentId). */
  | { kind: 'topUp'; paymentId: string; target: Target & { kind: 'card' } }
  | { kind: 'topUpPending' }
  | { kind: 'topUpNotPaid'; target: Target & { kind: 'card' } }
  | { kind: 'chip'; wallet: ReceptionWallet; method: PayMethod }
  | { kind: 'pin'; wallet: ReceptionWallet; method: PayMethod }
  | { kind: 'done'; detail: string; method: PayMethod };

/** Preguntas por cómo quedó una recarga con tarjeta (cada 3 s, hasta 30 s). */
const TOP_UP_POLL_MS = 3_000;
const TOP_UP_POLL_TRIES = 10;

/** Pasos antes de cobrar: ahí aún no hay nada que perder si la sesión caduca. */
const BEFORE_CHARGE = new Set<Step['kind']>(['amount', 'method', 'target']);

const done = (wallet: ReceptionWallet, method: PayMethod): Step => ({ kind: 'done', detail: receptionDetail(wallet), method });

interface Props {
  /** El datáfono (su credencial y su lector) o el móvil del personal (su sesión y Web NFC). */
  on: 'device' | 'staff';
  onDone: () => void;
}

/**
 * Recepción: 1) importe, 2) tarjeta o efectivo, 3) saldo nuevo o el de su
 * ficha, 4) la ficha (si está en blanco se graba), 5) el cliente elige su PIN
 * y 6) el resultado. En el datáfono la tarjeta pasa por su lector (Paytef);
 * en el móvil, el cliente paga la recarga con el QR en su móvil.
 */
export function ReceptionFlow({ on, onDone }: Props) {
  const backend: ReceptionBackend = on === 'device' ? deviceBackend : staffBackend;
  const reader = useChipReader();
  const [options, setOptions] = useState<ReceptionOptions | null>(null);
  const [amountCents, setAmountCents] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'amount' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  // Una clave por recarga (importe, forma de pago y saldo): repetir lo mismo
  // (corte, doble toque) no carga dos veces; otra cosa lleva otra clave.
  const attempt = useRef<ReceptionAttempt | null>(null);
  // Código para la ficha en blanco: se reutiliza hasta que se intenta grabar.
  const blankCode = useMemo(
    () => blankCodeFrom(() => backend.newToken(), (token) => walletCardUrl(window.location.origin, token)),
    [backend],
  );
  // Desde que se cobra hasta el resultado: si la sesión caduca, se entra encima sin perderlo.
  const charging = !BEFORE_CHARGE.has(step.kind);
  useOpenCharge('recepcion', charging, charging && step.kind !== 'done');

  function keyFor(method: PayMethod, target: Target): string {
    attempt.current = receptionAttempt(attempt.current, receptionWhat(amountCents, method, target));
    return attempt.current.key;
  }

  useEffect(() => {
    backend
      .options()
      .then(setOptions)
      .catch((err: Error) => setError(err.message));
  }, [backend]);
  useEffect(() => () => reading?.abort(), [reading]);

  // Recarga con tarjeta a una ficha que ya tenía: su resultado lo dice el servidor
  // (sumada con el saldo, pendiente de Paytef o no cobrada). Si no contesta, lo de antes.
  const topUpId = step.kind === 'topUp' ? step.paymentId : null;
  useEffect(() => {
    if (step.kind !== 'topUp') return undefined;
    const { paymentId, target } = step;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fallback = () => setStep({ kind: 'done', detail: existingTopUpDetail(target.view), method: 'card' });
    const ask = async (tries: number): Promise<void> => {
      let check: TopUpCheck;
      try {
        check = topUpCheck(await deviceBackend.topUp(paymentId));
      } catch {
        if (alive) fallback();
        return;
      }
      if (!alive) return;
      if (check.kind === 'done') setStep({ kind: 'done', detail: check.detail, method: 'card' });
      else if (check.kind === 'pending') setStep({ kind: 'topUpPending' });
      else if (check.kind === 'notPaid') setStep({ kind: 'topUpNotPaid', target });
      else if (tries <= 1) fallback();
      else timer = setTimeout(() => void ask(tries - 1), TOP_UP_POLL_MS);
    };
    void ask(TOP_UP_POLL_TRIES);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
    // Una vez por recarga.
  }, [topUpId]);

  function restart(): void {
    attempt.current = null;
    setAmountCents(0);
    setError(null);
    setStep({ kind: 'amount' });
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

  /** Espera la ficha; con `blank`, si está en blanco se le graba un código nuevo del servidor. */
  async function readChip(blank: boolean) {
    if (!reader.via) throw new Error(reader.note ?? 'Aquí no se pueden leer fichas.');
    const controller = new AbortController();
    setReading(controller);
    try {
      const tap = await tapChip(reader.via, controller.signal, blank && reader.canWrite ? blankCode : undefined);
      if (tap.other) throw new Error('Esta ficha tiene otra cosa grabada: usa otra.');
      if (!tap.token) {
        throw new Error(blank ? (reader.note ?? 'Esta ficha está en blanco y aquí no se puede grabar.') : 'Esta ficha no es de ningún saldo.');
      }
      return { token: tap.token, uid: tap.uid };
    } finally {
      controller.abort();
      setReading(null);
    }
  }

  /**
   * Tras cobrar un saldo nuevo: su código, su ficha y su PIN. (Al saldo de una
   * ficha que ya tenía no se le cambia nada: su PIN, con el encargado; y su
   * resultado sale del propio cobro, sin pedir el saldo.)
   */
  async function afterPay(walletId: string, method: PayMethod): Promise<void> {
    const wallet = await backend.wallet(walletId);
    const next = nextAfterPay(wallet, { nfc: Boolean(options?.nfc) && reader.via !== null });
    setStep(next === 'done' ? done(wallet, method) : { kind: next, wallet, method });
  }

  /**
   * Ya cobrado: si no se puede seguir (sin conexión al pedir el saldo), se
   * dice que la recarga está hecha y se empieza otra con una clave nueva.
   */
  async function paidThen(walletId: string, method: PayMethod): Promise<void> {
    try {
      await afterPay(walletId, method);
    } catch (err) {
      attempt.current = null;
      setAmountCents(0);
      setStep({ kind: 'amount' });
      throw new Error(`Recarga cobrada y sumada al saldo. La ficha y el PIN, con el encargado: ${(err as Error).message}`);
    }
  }

  /** Recarga con tarjeta: en el lector del datáfono, o el QR para su móvil. */
  async function startCard(target: Target): Promise<void> {
    if (on === 'device') {
      const sale = await deviceBackend.cardSale({
        amountCents,
        idempotencyKey: keyFor('card', target),
        wallet: target.kind === 'new' ? { create: true } : (walletOfTarget(target) as { card: string; uid?: string }),
      });
      setStep({ kind: 'cardSale', sale, existing: target.kind === 'card' ? target : null });
      return;
    }
    const terminal = (await fetchTerminals())[0]?.externalId;
    if (!terminal) throw new Error('No hay terminales configurados en el local');
    const payment = await createPayment({
      amountCents,
      terminalExternalId: terminal,
      idempotencyKey: keyFor('card', target),
      ...(target.kind === 'new' ? { newWallet: true } : { walletId: target.view.walletId }),
    });
    setStep({ kind: 'cardQr', payment });
  }

  /** Forma de pago y saldo elegidos: efectivo a confirmar o la tarjeta. */
  async function choose(method: PayMethod, target: Target): Promise<void> {
    if (!options) return;
    const problem = payProblem(method, target, options);
    if (problem) throw new Error(problem);
    if (method === 'cash') setStep({ kind: 'cash', target });
    else await startCard(target);
  }

  if (step.kind === 'cardSale') {
    const { sale, existing } = step;
    return (
      <PaxChargeFlow
        charge={{
          id: sale.paymentId,
          amountCents: sale.amountCents,
          currency: 'EUR',
          createdAt: new Date().toISOString(),
          createdByName: 'Recepción · recarga del saldo',
          zone: null,
          terminalLabel: null,
          code: '',
          forThisTerminal: true,
        }}
        start={() => Promise.resolve({ reference: sale.reference, amountCents: sale.amountCents })}
        onPaid={() =>
          existing
            ? setStep({ kind: 'topUp', paymentId: sale.paymentId, target: existing })
            : void run(() => paidThen(sale.walletId, 'card'))
        }
        onDone={restart}
      />
    );
  }

  if (step.kind === 'cardQr') {
    // El cliente paga en su móvil; al pagarse, su código, la ficha y el PIN (como «Cargar wallet»).
    return (
      <ActivePayment
        payment={step.payment}
        isPos={false}
        label="Recarga del saldo"
        onPaid={() => undefined}
        onClose={restart}
        spot="recepcion"
      />
    );
  }

  if (step.kind === 'topUp' || step.kind === 'topUpPending' || step.kind === 'topUpNotPaid') {
    return (
      <Card style={cardStyle}>
        <p style={kicker}>Recepción</p>
        <p className="np-num" style={amountStyle}>
          {formatEur(amountCents)}
        </p>
        {step.kind === 'topUp' ? <p style={big}>Comprobando la recarga…</p> : null}
        {step.kind === 'topUpPending' ? (
          <p role="status" style={{ ...big, color: 'var(--np-warning)' }}>
            {PENDING_CONFIRM_TEXT}
          </p>
        ) : null}
        {step.kind === 'topUpNotPaid' ? (
          <>
            <p role="alert" style={{ ...big, color: 'var(--np-danger)' }}>
              La recarga no consta como cobrada: no se ha sumado nada.
            </p>
            <Button
              size="lg"
              loading={busy}
              onClick={() => {
                const { target } = step;
                // Otra venta: la anterior no se cobró, así que va con clave nueva.
                attempt.current = null;
                void run(() => startCard(target));
              }}
            >
              Volver a cobrar {formatEur(amountCents)}
            </Button>
          </>
        ) : null}
        {step.kind === 'topUp' ? null : (
          <Button variant="ghost" disabled={busy} onClick={restart}>
            Otra recarga
          </Button>
        )}
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
      </Card>
    );
  }

  if (step.kind === 'pin') {
    const { wallet } = step;
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${wallet.code}`}
        hint={on === 'device' ? 'Que el cliente elija su PIN (tápalo con la mano)' : 'Pásale el móvil al cliente para que elija su PIN'}
        onCancel={() => setStep(done(wallet, step.method))}
        onPin={async (pin) => {
          const next = await backend.setPin(wallet, pin);
          setStep(done(next, step.method));
          return null;
        }}
      />
    );
  }

  if (step.kind === 'done') {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={amountCents}
        message={step.method === 'cash' ? 'Recargado en efectivo' : 'Recargado con tarjeta'}
        detail={<p>{step.detail}</p>}
        primary={{ label: 'Otra recarga', onClick: restart }}
        secondary={{ label: 'Volver', onClick: onDone }}
      />
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Recepción</p>
      {step.kind === 'amount' ? (
        <>
          <AmountKeypad valueCents={amountCents} onChange={setAmountCents} label="Importe a cargar" disabled={busy} />
          <Button size="lg" disabled={amountCents <= 0} onClick={() => setStep({ kind: 'method' })}>
            Siguiente
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'method' ? (
        <>
          <p className="np-num" style={amountStyle}>
            {formatEur(amountCents)}
          </p>
          <p style={big}>¿Cómo paga?</p>
          {!options ? <p style={muted}>Cargando…</p> : null}
          <Button size="lg" disabled={!options?.card} onClick={() => setStep({ kind: 'target', method: 'card' })}>
            {cardMethodLabel(on)}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            disabled={!options?.cash || amountCents > MAX_CASH_TOP_UP_CENTS}
            onClick={() => setStep({ kind: 'target', method: 'cash' })}
          >
            Efectivo
          </Button>
          {options && !options.cash && options.cashBlockedReason ? <p style={note}>{options.cashBlockedReason}</p> : null}
          {amountCents > MAX_CASH_TOP_UP_CENTS ? <p style={note}>En efectivo, como mucho 999,99 € por recarga.</p> : null}
          <Button variant="ghost" onClick={() => setStep({ kind: 'amount' })}>
            Cambiar el importe
          </Button>
        </>
      ) : null}

      {step.kind === 'target' ? (
        <>
          <p className="np-num" style={amountStyle}>
            {formatEur(amountCents)}
          </p>
          <p style={big}>¿A qué saldo?</p>
          <Button size="lg" disabled={busy || reading !== null} onClick={() => void run(() => choose(step.method, { kind: 'new' }))}>
            Saldo nuevo
          </Button>
          {reading ? (
            <Button variant="ghost" onClick={() => reading.abort()}>
              Acerca su ficha… (cancelar)
            </Button>
          ) : (
            <Button
              size="lg"
              variant="ghost"
              disabled={busy || !reader.via || !options?.nfc}
              onClick={() =>
                void run(async () => {
                  const chip = await readChip(false);
                  const view = await backend.lookup(chip.token, chip.uid);
                  await choose(step.method, { kind: 'card', card: chip.token, uid: chip.uid, view });
                })
              }
            >
              Recargar su ficha (acercarla)
            </Button>
          )}
          {reader.note && options?.nfc ? <p style={note}>{reader.note}</p> : null}
          <Button variant="ghost" onClick={() => setStep({ kind: 'method' })}>
            Atrás
          </Button>
        </>
      ) : null}

      {step.kind === 'cash' ? (
        <>
          <p className="np-num" style={amountStyle}>
            {formatEur(amountCents)}
          </p>
          <p style={big}>Cobra {formatEur(amountCents)} en efectivo</p>
          <p style={muted}>
            {step.target.kind === 'card' ? `A su saldo ${step.target.view.codeHint}.` : 'Saldo nuevo.'} Guarda el dinero en la caja y
            pulsa «Cobrado».
          </p>
          <Button
            size="lg"
            loading={busy}
            onClick={() =>
              void run(async () => {
                const target = step.target;
                const out = await backend.cash({
                  amountCents,
                  idempotencyKey: keyFor('cash', target),
                  wallet: walletOfTarget(target),
                });
                if (target.kind === 'card') setStep(done(walletAfterCash(out, target.view), 'cash'));
                else await paidThen(out.walletId, 'cash');
              })
            }
          >
            Cobrado
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setStep({ kind: 'target', method: 'cash' })}>
            Atrás
          </Button>
        </>
      ) : null}

      {step.kind === 'chip' ? (
        <>
          <p style={big}>Saldo {step.wallet.code}</p>
          <p style={muted}>Que haga una foto al código. Ahora, su ficha.</p>
          {reading ? (
            <Button variant="ghost" onClick={() => reading.abort()}>
              Acerca la ficha y déjala quieta… (cancelar)
            </Button>
          ) : (
            <Button
              size="lg"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  const { wallet, method } = step;
                  const chip = await readChip(true);
                  const next = await backend.link(wallet, chip.token, chip.uid);
                  setStep(next.hasPin ? done(next, method) : { kind: 'pin', wallet: next, method });
                })
              }
            >
              Darle una ficha
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy || reading !== null}
            onClick={() =>
              setStep(step.wallet.hasPin ? done(step.wallet, step.method) : { kind: 'pin', wallet: step.wallet, method: step.method })
            }
          >
            Sin ficha
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
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--np-danger)', fontWeight: 600 };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
