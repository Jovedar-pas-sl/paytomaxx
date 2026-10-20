'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReceptionDeskNew, ReceptionOptions } from '@nightpay/contracts';
import { cancelPayment, createPayment, fetchTerminals, type CreatedPayment, type OperatorUser } from '@/lib/api';
import type { ChipTap } from '@/lib/chip-tap';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import {
  receptionAttempt,
  receptionWhat,
  staffBackend,
  stockOutcomeLine,
  walletOfTarget,
  type PayMethod,
  type ReceptionAttempt,
  type ReceptionWallet,
} from '@/lib/reception';
import {
  deskRow,
  deskTarget,
  exitPlan,
  fetchReceptionDesk,
  handOverLine,
  loadedMoneyLine,
  methodButtons,
  payoutCash,
  pinNote,
  quickAmounts,
  rechargeChip,
  rechargeProblem,
  refundDoneLine,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
} from '@/lib/reception-desk';
import { useVenueNight } from '@/lib/venue-methods';
import { PinPad } from '../../PinPad';
import { DeskHead, DeskBtn, DeskRowView } from './desk-parts';
import { AmountStep, CodeStep, ExitStep, KeypadStep, MethodStep, TapStage } from './DeskSteps';
import { DeskLoaded } from './DeskLoaded';
import { TopUpQr } from './TopUpQr';
import { useDeskNfc } from './use-desk-nfc';
import s from './desk.module.css';

type Mode = 'entrada' | 'salida';

/** Lo leído: su saldo (null: saldo nuevo sin NFC) y el NFC acercado (null: por el código). */
interface Read {
  view: ReceptionDeskView | null;
  nfc: { card: string; uid: string | null } | null;
}

/** La recarga hecha (4.4). */
interface Loaded {
  read: Read;
  amountCents: number;
  method: PayMethod;
  wallet: ReceptionWallet | null;
  linked: boolean;
  warn: string | null;
}

type Step =
  | { kind: 'tap' }
  | { kind: 'code' }
  | { kind: 'amount'; read: Read }
  | { kind: 'keypad'; read: Read }
  | { kind: 'method'; read: Read; amountCents: number }
  | { kind: 'card'; read: Read; amountCents: number; payment: CreatedPayment | null }
  | { kind: 'loaded'; done: Loaded }
  | { kind: 'pin'; done: Loaded }
  | { kind: 'exit'; view: ReceptionDeskSaldo }
  | { kind: 'exitNew'; view: ReceptionDeskNew; nfc: { card: string; uid: string | null } }
  | { kind: 'refunded'; code: string; refundedCents: number; remainingCents: number };

/** Desde que se cobra hasta el resultado: si la sesión caduca, se entra encima sin perderlo. */
const CHARGING = new Set<Step['kind']>(['card', 'loaded', 'pin', 'refunded']);

const errText = (err: unknown) => (err as Error).message;

interface Props {
  user: OperatorUser;
  /** La pestaña se ve: solo entonces se escucha el NFC (en Saldo lo usa el cobro). */
  active: boolean;
  /** Lo de siempre, debajo del primer paso: «Preparar fichas», «Pendientes de asignar (2)». */
  footer: ReactNode;
}

/**
 * Recepción exprés (maquetas 4.1–4.5). Entrada: se acerca el NFC y la app
 * sabe sola si es nuevo o si ya tiene saldo; el importe (tocar uno ya sigue)
 * y cómo paga (la forma por defecto del local en grande): tres toques.
 * CARGADO en verde, con el efectivo a la caja y el NFC al cliente; el PIN,
 * después y si quiere. Salida: lo que le queda; «Guardar para la próxima»
 * (de fábrica) o devolverlo en efectivo con las reglas de siempre.
 * Solo recepción carga saldos y cobra efectivo (el servidor lo exige igual).
 */
export function ReceptionDesk({ user, active, footer }: Props) {
  const night = useVenueNight();
  const [mode, setMode] = useState<Mode>('entrada');
  const [step, setStep] = useState<Step>({ kind: 'tap' });
  const [options, setOptions] = useState<ReceptionOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState<string | null>(null);
  // Una clave por recarga (importe, forma de pago y saldo): repetirla no carga dos veces.
  const attempt = useRef<ReceptionAttempt | null>(null);

  useEffect(() => {
    staffBackend
      .options()
      .then(setOptions)
      .catch((err: Error) => setError(err.message));
  }, []);

  const nfc = useDeskNfc(active && step.kind === 'tap' && !busy, mode === 'entrada', onTap, setError);
  useOpenCharge('recepcion', CHARGING.has(step.kind), step.kind === 'card' && step.payment !== null);
  const amounts = quickAmounts(night.receptionQuickAmountsCents);

  function go(next: Step): void {
    setError(null);
    setTotp(null);
    setStep(next);
  }

  function restart(nextMode: Mode = mode, message: string | null = null): void {
    attempt.current = null;
    setCode('');
    setMode(nextMode);
    go({ kind: 'tap' });
    setNotice(message);
  }

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Lo leído → Entrada: el importe; Salida: lo que le queda. */
  function open(view: ReceptionDeskView, card: Read['nfc']): void {
    setNotice(null);
    if (mode === 'salida') {
      if (view.kind === 'saldo') go({ kind: 'exit', view });
      else if (card) go({ kind: 'exitNew', view, nfc: card });
      return;
    }
    const problem = rechargeProblem(view);
    if (problem) throw new Error(problem);
    go({ kind: 'amount', read: { view, nfc: card } });
  }

  /** El NFC acercado (en blanco, en Entrada ya viene grabado). */
  async function onTap(tap: ChipTap): Promise<void> {
    if (tap.other) return setError('Este NFC tiene otra cosa grabada: usa otro.');
    if (!tap.token) {
      return setError(mode === 'entrada' ? (nfc.reader.note ?? 'Este NFC está en blanco y aquí no se puede grabar: usa otro.') : 'Este NFC está en blanco: no tiene saldo.');
    }
    const card = { card: tap.token, uid: tap.uid };
    await run(async () => {
      // Recién grabado: al stock, como en «Preparar fichas» (si no paga, sigue siendo una ficha).
      if (tap.written) await staffBackend.stock(card.card, card.uid);
      open(await fetchReceptionDesk(card.uid ? { card: card.card, uid: card.uid } : { card: card.card }), card);
    });
  }

  function onCode(next: string): void {
    setCode(next);
    setError(null);
    if (next.length === 6) void run(async () => open(await fetchReceptionDesk({ code: next }), null));
  }

  function keyFor(amountCents: number, method: PayMethod, read: Read): string {
    attempt.current = receptionAttempt(attempt.current, receptionWhat(amountCents, method, deskTarget(read.view, read.nfc)));
    return attempt.current.key;
  }

  /** Cobrado: a un saldo nuevo se le da el NFC; después, CARGADO (4.4). */
  async function finish(read: Read, amountCents: number, method: PayMethod, wallet: ReceptionWallet | null): Promise<void> {
    let linked = read.view?.kind === 'saldo';
    let warn: string | null =
      wallet === null && read.view?.kind === 'new' ? 'Cobrado y sumado a su saldo nuevo. El NFC y el PIN, con el encargado.' : null;
    let w = wallet;
    if (w && read.view?.kind === 'new' && read.nfc) {
      try {
        w = await staffBackend.link(w, read.nfc.card, read.nfc.uid);
        linked = true;
      } catch (err) {
        warn = `El NFC no se ha podido dar: ${errText(err)} Que apunte su código ${w.code}.`;
      }
    }
    attempt.current = null;
    go({ kind: 'loaded', done: { read, amountCents, method, wallet: w, linked, warn } });
  }

  async function payCash(read: Read, amountCents: number): Promise<void> {
    const target = deskTarget(read.view, read.nfc);
    const out = await staffBackend.cash({ amountCents, idempotencyKey: keyFor(amountCents, 'cash', read), wallet: walletOfTarget(target) });
    const hasPin = read.view?.kind === 'saldo' && read.view.hasPin;
    await finish(read, amountCents, 'cash', { walletId: out.walletId, code: out.code, balanceCents: out.balanceCents, hasPin, hasCard: read.nfc !== null });
  }

  async function newCardPayment(read: Read, amountCents: number): Promise<CreatedPayment> {
    const target = deskTarget(read.view, read.nfc);
    const terminal = (await fetchTerminals())[0]?.externalId;
    if (!terminal) throw new Error('No hay terminales configurados en el local');
    return createPayment({
      amountCents,
      terminalExternalId: terminal,
      idempotencyKey: keyFor(amountCents, 'card', read),
      ...(target.kind === 'new' ? { newWallet: true } : { walletId: target.view.walletId }),
    });
  }

  /** Otro importe encima del QR (o el primero): se retira el QR anterior y sale otro. */
  async function changeCard(read: Read, amountCents: number, old: CreatedPayment | null): Promise<void> {
    if (old) await cancelPayment(old.id);
    go({ kind: 'card', read, amountCents, payment: null });
    const payment = await newCardPayment(read, amountCents);
    setStep({ kind: 'card', read, amountCents, payment });
  }

  async function cardPaid(read: Read, payment: CreatedPayment): Promise<void> {
    const view = read.view;
    if (view?.kind === 'saldo') {
      const w = { walletId: view.walletId, code: view.code, balanceCents: view.balanceCents + payment.amountCents, hasPin: view.hasPin, hasCard: read.nfc !== null };
      return finish(read, payment.amountCents, 'card', w);
    }
    // Saldo nuevo: su código para darle el NFC (y el PIN).
    const w = payment.walletId ? await staffBackend.wallet(payment.walletId).catch(() => null) : null;
    return finish(read, payment.amountCents, 'card', w);
  }

  /** Salida: devolver en efectivo (el encargado, con su código 2FA si lo pide). */
  async function refund(view: ReceptionDeskSaldo, totpCode?: string): Promise<void> {
    const out = await payoutCash(view.walletId, totpCode);
    if (out.kind === 'totp') {
      setTotp(out.message);
      return;
    }
    go({ kind: 'refunded', code: view.code, refundedCents: out.refundedCents, remainingCents: out.remainingCents });
  }

  const name = user.displayName ?? 'Recepción';
  const chip = { section: 'VENUE_ENTRY', label: 'Entradas' };
  const head = (onBack?: () => void) => <DeskHead title="Recepción" sub={name} chip={chip} stripe="section" onBack={onBack} />;

  if (step.kind === 'loaded') {
    const { done } = step;
    const money = loadedMoneyLine(done.method, done.amountCents);
    const canPin = done.wallet !== null && !done.wallet.hasPin;
    return (
      <DeskLoaded
        word="CARGADO"
        amountCents={done.amountCents}
        reference={done.wallet?.code ?? null}
        money={{ icon: done.method, ...money }}
        meta={handOverLine(done.read.view, done.linked)}
        warn={done.warn}
        primary={{ label: 'Siguiente cliente', onClick: () => restart('entrada') }}
        secondary={canPin ? { label: 'Que ponga su PIN', onClick: () => go({ kind: 'pin', done }) } : null}
      />
    );
  }

  if (step.kind === 'pin' && step.done.wallet) {
    const { done } = step;
    const wallet = step.done.wallet;
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${wallet.code}`}
        hint="Pásale el móvil al cliente para que elija su PIN"
        onCancel={() => go({ kind: 'loaded', done })}
        onPin={async (pin) => {
          const next = await staffBackend.setPin(wallet, pin);
          go({ kind: 'loaded', done: { ...done, wallet: next } });
          return null;
        }}
      />
    );
  }

  if (step.kind === 'refunded') {
    return (
      <DeskLoaded
        word="DEVUELTO"
        amountCents={step.refundedCents}
        reference={step.code}
        money={{ icon: 'cash', label: 'Efectivo:', amount: formatEur(step.refundedCents, { compact: true }), tail: 'de la caja' }}
        meta={refundDoneLine(step.remainingCents)}
        primary={{ label: 'Siguiente cliente', onClick: () => restart('salida') }}
      />
    );
  }

  if (step.kind === 'card') {
    const { read, amountCents, payment } = step;
    const forWhom = read.view?.kind === 'saldo' ? `Se carga en ${read.view.code}.` : 'Se carga en su saldo nuevo.';
    return (
      <TopUpQr
        head={head(() => void run(async () => {
          if (payment) await cancelPayment(payment.id);
          go({ kind: 'method', read, amountCents });
        }))}
        payment={payment}
        amounts={amounts}
        changing={busy}
        forWhom={forWhom}
        onAmount={(cents) => void run(() => changeCard(read, cents, payment))}
        onPaid={(paid) => void run(() => cardPaid(read, paid))}
        onRetry={() => {
          attempt.current = null;
          void run(() => changeCard(read, amountCents, null));
        }}
        onCash={
          options?.cash
            ? () =>
                void run(async () => {
                  if (payment) await cancelPayment(payment.id);
                  await payCash(read, payment?.amountCents ?? amountCents);
                })
            : undefined
        }
        cashBusy={busy}
        onBack={() => go({ kind: 'method', read, amountCents })}
        error={error}
      />
    );
  }

  return (
    <div className={s.screen}>
      {step.kind === 'tap' || step.kind === 'exit' || step.kind === 'exitNew' ? (
        <>
          {head()}
          <div className={s.seg} role="group" aria-label="Entrada o salida">
            {(['entrada', 'salida'] as const).map((m) => (
              <button key={m} type="button" className={s.segBtn} aria-pressed={mode === m} onClick={() => restart(m)}>
                {m === 'entrada' ? 'Entrada' : 'Salida'}
              </button>
            ))}
          </div>
        </>
      ) : (
        head(() => go(backOf(step)))
      )}

      {step.kind === 'tap' ? (
        <>
          <TapStage
            mode={mode}
            noReader={!nfc.reader.loading && !nfc.reader.via ? nfc.reader.note : null}
            stopped={nfc.stopped}
            onRestart={nfc.restart}
            busy={busy}
            error={error}
            notice={notice}
          />
          <div className={s.foot}>
            <DeskBtn kind="gho" label="Escribir el código" onClick={() => go({ kind: 'code' })} />
            {footer}
          </div>
        </>
      ) : null}

      {step.kind === 'code' ? (
        <CodeStep
          code={code}
          onCode={onCode}
          busy={busy}
          error={error}
          onNewWithout={mode === 'entrada' ? () => go({ kind: 'amount', read: { view: null, nfc: null } }) : undefined}
        />
      ) : null}

      {step.kind === 'amount' ? (
        <AmountStep
          row={step.read.view ? deskRow(step.read.view, 'entrada') : { title: 'Saldo nuevo', detail: 'Sin NFC: se queda con su código' }}
          amounts={amounts}
          onPick={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })}
          onOther={() => go({ kind: 'keypad', read: step.read })}
        />
      ) : null}

      {step.kind === 'keypad' ? <KeypadStep onDone={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })} /> : null}

      {step.kind === 'method' ? (
        <MethodStep
          chip={rechargeChip(step.read.view)}
          amountCents={step.amountCents}
          loading={options === null}
          blocked={null}
          buttons={options ? methodButtons(options, deskTarget(step.read.view, step.read.nfc), step.amountCents, night.receptionDefaultMethod) : []}
          pinNote={step.read.view?.kind === 'saldo' && step.read.view.hasPin ? null : pinNote(night.nfcNoPinMaxCents)}
          busy={busy}
          onPick={(method) => {
            const { read, amountCents } = step;
            if (method === 'cash') void run(() => payCash(read, amountCents));
            else void run(() => changeCard(read, amountCents, null));
          }}
        />
      ) : null}

      {step.kind === 'exit' ? (
        <ExitStep
          row={deskRow(step.view, 'salida')}
          plan={exitPlan(step.view, user.role)}
          busy={busy}
          totp={totp}
          onKeep={() => restart('salida', `Guardado: ${step.view.code} sigue con ${formatEur(step.view.balanceCents, { compact: true })}.`)}
          onRefund={() => void run(() => refund(step.view))}
          onTotp={(totpCode) => void run(() => refund(step.view, totpCode))}
        />
      ) : null}

      {step.kind === 'exitNew' ? (
        <>
          <DeskRowView title="NFC sin saldo" detail={deskRow(step.view, 'salida').detail} check={false} />
          <p className={s.lbl}>No tiene saldo: guárdalo con los del stock.</p>
          <DeskBtn
            kind="pri"
            size="l"
            label="Al stock"
            small="Para el siguiente cliente"
            busy={busy}
            onClick={() =>
              void run(async () => {
                const outcome = await staffBackend.stock(step.nfc.card, step.nfc.uid);
                restart('salida', stockOutcomeLine(outcome).text);
              })
            }
          />
        </>
      ) : null}

      {error && step.kind !== 'tap' && step.kind !== 'code' ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Volver un paso (la cabecera): del importe al NFC, del teclado y de cómo paga al importe. */
function backOf(step: Step): Step {
  if (step.kind === 'keypad') return { kind: 'amount', read: step.read };
  if (step.kind === 'method') return { kind: 'amount', read: step.read };
  return { kind: 'tap' };
}
