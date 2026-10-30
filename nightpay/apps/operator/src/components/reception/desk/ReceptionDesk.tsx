'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReceptionDeskNew, ReceptionOptions } from '@nightpay/contracts';
import { createPayment, fetchTerminals, type CreatedPayment, type OperatorUser } from '@/lib/api';
import type { ChipTap } from '@/lib/chip-tap';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import {
  receptionAttempt,
  staffBackend,
  stockOutcomeLine,
  cashWithFreshFee,
  topUpCharge,
  type PayMethod,
  type ReceptionAttempt,
  type ReceptionWallet,
} from '@/lib/reception';
import {
  attemptOnStep,
  CASH_CHECK_DELAY_MS,
  CASH_CHECK_TRIES,
  CASH_UNSURE_LEAVE_TEXT,
  CASH_UNSURE_LEFT_NOTICE,
  cashTopUpUnsure,
  cashTopUpWallet,
  cashUnsureRow,
  cashUnsureText,
  deskRechargeWhat,
  deskRow,
  deskTarget,
  fetchFichaByNumber,
  fetchReceptionDesk,
  fichaText,
  handOverLine,
  loadedMoneyLine,
  methodButtons,
  numberEntryProblem,
  numberMethodButtons,
  numberRow,
  pinNote,
  quickAmounts,
  rechargeChip,
  rechargeProblem,
  refundDoneLine,
  topUpByNumber,
  type NumberSaldo,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
} from '@/lib/reception-desk';
import { receptionChip, useMySections } from '@/lib/sections';
import { useVenueNight } from '@/lib/venue-methods';
import {
  canSkipPasskey,
  cashExitPlan,
  exitNext,
  fetchPayoutPlan,
  receptionCashPayout,
  type CashExitNfc,
  type ReceptionPayoutPlan,
} from '@/lib/reception-cash-payout';
import { PinPad } from '../../PinPad';
import { ActivationQr } from './ActivationQr';
import { DeskHead, DeskBtn, DeskRowView } from './desk-parts';
import { AmountStep, CodeStep, ExitStep, KeypadStep, MethodStep, NumberStep, TapStage } from './DeskSteps';
import { DeskLoaded } from './DeskLoaded';
import { ManagerExitStep, NumberExitStep, PasskeyExitStep, TotpExitStep } from './ExitSteps';
import { TopUpQr, useRetirePayment } from './TopUpQr';
import { useDeskNfc } from './use-desk-nfc';
import s from './desk.module.css';

type Mode = 'entrada' | 'salida';

/**
 * Lo leído: su saldo (null: saldo nuevo sin NFC), el NFC acercado (null: por
 * el código) o la ficha buscada por su número (solo saldos que ya existen,
 * tapados: se recargan en efectivo).
 */
interface Read {
  view: ReceptionDeskView | null;
  nfc: { card: string; uid: string | null } | null;
  number?: NumberSaldo;
}

/** La recarga hecha (4.4). */
interface Loaded {
  read: Read;
  amountCents: number;
  /** La «Comisión del servicio» que pagó encima (la que cobró el servidor; 0 sin ella). */
  feeCents: number;
  method: PayMethod;
  wallet: ReceptionWallet | null;
  linked: boolean;
  warn: string | null;
  /** Ya se vio (se vuelve del PIN): sin sonar otra vez. */
  seen?: boolean;
  /** La referencia de arriba si no hay saldo entero (por número: K7Q-•••). */
  reference?: string | null;
}

type Exit = { kind: 'exit'; view: ReceptionDeskSaldo; nfc: CashExitNfc; requestKey: string };

type Step =
  | { kind: 'tap' }
  | { kind: 'code' }
  | { kind: 'number' }
  | { kind: 'amount'; read: Read }
  | { kind: 'keypad'; read: Read }
  | { kind: 'method'; read: Read; amountCents: number }
  | { kind: 'card'; read: Read; amountCents: number; payment: CreatedPayment | null }
  | { kind: 'loaded'; done: Loaded }
  | { kind: 'pin'; done: Loaded }
  | Exit
  | { kind: 'exitPasskey'; exit: Exit; plan: ReceptionPayoutPlan }
  | { kind: 'exitTotp'; exit: Exit; plan: ReceptionPayoutPlan | null; passkey: boolean; pin?: string; message?: string }
  | { kind: 'exitManager'; exit: Exit; plan: ReceptionPayoutPlan }
  | { kind: 'exitPin'; exit: Exit; totpCode?: string }
  | { kind: 'managerPending'; exit: Exit; message: string }
  | { kind: 'exitNew'; view: ReceptionDeskNew; nfc: { card: string; uid: string | null } }
  | { kind: 'exitNumber'; view: NumberSaldo }
  | { kind: 'refunded'; code: string; refundedCents: number; remainingCents: number }
  /** Efectivo sin respuesta: no se sabe si se cargó. Se comprueba con la misma clave antes de seguir. */
  | { kind: 'cashUnsure'; read: Read; amountCents: number; checking: boolean; leaveArmed?: boolean };

/** Desde que se cobra hasta el resultado: si la sesión caduca, se entra encima sin perderlo. */
const CHARGING = new Set<Step['kind']>(['card', 'loaded', 'pin', 'cashUnsure', 'exitPasskey', 'exitTotp', 'exitPin', 'managerPending', 'refunded']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errText = (err: unknown) => (err as Error).message;
const eur = (cents: number) => formatEur(cents, { compact: true });

interface Props {
  user: OperatorUser;
  /** La pestaña se ve: solo entonces se escucha el NFC (en Inicio lo usa el cobro). */
  active: boolean;
  /** Lo de siempre, debajo del primer paso: «Preparar fichas», «Pendientes de asignar (2)». */
  footer: ReactNode;
}

/**
 * Recepción exprés (maquetas 4.1–4.5). Entrada: se acerca el NFC y la app
 * sabe sola si es nuevo o si ya tiene saldo; el importe (tocar uno ya sigue)
 * y cómo paga (la forma por defecto del local en grande): tres toques.
 * CARGADO en verde, con el efectivo a la caja, el NFC al cliente y, si pagó
 * en efectivo, el QR de activación (un solo uso, 10 min) para activar Face ID
 * en su móvil; el PIN, después y si quiere. Salida: lo que le queda; «Guardar para la próxima» (de fábrica) o
 * devolverlo en efectivo: antes del PIN se sabe si hace falta el encargado o
 * su Face ID, así el cliente teclea el PIN una sola vez.
 * Solo recepción carga saldos y cobra efectivo (el servidor lo exige igual).
 */
export function ReceptionDesk({ user, active, footer }: Props) {
  const night = useVenueNight();
  const { sections } = useMySections();
  const [mode, setMode] = useState<Mode>('entrada');
  const [step, setStep] = useState<Step>({ kind: 'tap' });
  const [options, setOptions] = useState<ReceptionOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // Una clave por recarga (importe, forma de pago y saldo): repetirla no carga dos veces.
  const attempt = useRef<ReceptionAttempt | null>(null);
  const retire = useRetirePayment();
  // La comprobación en curso de una recarga sin respuesta (otra la anula).
  const cashCheck = useRef(0);

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
    // Volver a leer (la flecha atrás hasta el NFC, otro cliente): clave de recarga nueva (A2-04).
    attempt.current = attemptOnStep(attempt.current, next.kind);
    setError(null);
    setStep(next);
  }

  function restart(nextMode: Mode = mode, message: string | null = null): void {
    attempt.current = null;
    cashCheck.current += 1;
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
      if (view.kind === 'saldo') go({ kind: 'exit', view, nfc: card, requestKey: crypto.randomUUID() });
      else if (card) go({ kind: 'exitNew', view, nfc: card });
      else restart('salida', 'Esta ficha no tiene saldo. Acerca su NFC original para devolverla al stock.');
      return;
    }
    const problem = rechargeProblem(view);
    if (problem) throw new Error(problem);
    go({ kind: 'amount', read: { view, nfc: card } });
  }

  /** Por el número impreso: Entrada solo recarga saldos que ya existen; Salida solo enseña lo que tiene. */
  async function openByNumber(printedNumber: string): Promise<void> {
    const view = await fetchFichaByNumber(printedNumber);
    setNotice(null);
    if (mode === 'salida') {
      if (view.kind !== 'saldo') throw new Error('Esta ficha no tiene saldo: guárdala con las del stock.');
      return go({ kind: 'exitNumber', view });
    }
    const problem = numberEntryProblem(view);
    if (problem || view.kind !== 'saldo') throw new Error(problem ?? 'Para cargar una ficha nueva, acércala');
    go({ kind: 'amount', read: { view: null, nfc: null, number: view } });
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

  /** La clave va con lo que se recarga, también con la ficha nueva leída: la de un cliente no vale para otro. */
  function keyFor(amountCents: number, method: PayMethod, read: Read): string {
    attempt.current = receptionAttempt(attempt.current, deskRechargeWhat(amountCents, method, read));
    return attempt.current.key;
  }

  /**
   * Cobrado: a un saldo nuevo se le da el NFC (si el servidor no lo dio ya
   * con la recarga: `cardLinked`); después, CARGADO (4.4).
   */
  async function finish(
    read: Read,
    amountCents: number,
    method: PayMethod,
    wallet: ReceptionWallet | null,
    cardLinked = false,
    feeCents = 0,
  ): Promise<void> {
    let linked = read.view?.kind === 'saldo' || cardLinked;
    let warn: string | null =
      wallet === null && read.view?.kind === 'new' ? 'Cobrado y sumado a su saldo nuevo. El NFC y el PIN, con el encargado.' : null;
    let w = wallet;
    if (w && read.view?.kind === 'new' && read.nfc && !cardLinked) {
      try {
        w = await staffBackend.link(w, read.nfc.card, read.nfc.uid);
        linked = true;
      } catch (err) {
        warn = `El NFC no se ha podido dar: ${errText(err)} Que apunte su código ${w.code}.`;
      }
    }
    attempt.current = null;
    go({ kind: 'loaded', done: { read, amountCents, feeCents, method, wallet: w, linked, warn } });
  }

  /** La recarga en efectivo con la clave de este intento: repetirla no carga dos veces. */
  async function sendCash(read: Read, amountCents: number): Promise<void> {
    if (read.number) {
      const out = await cashWithFreshFee(
        () =>
          topUpByNumber({
            printedNumber: read.number!.printedNumber,
            amountCents,
            idempotencyKey: keyFor(amountCents, 'cash', read),
            ...topUpCharge(options, amountCents).body,
          }),
        { refresh: () => staffBackend.options(), onOptions: setOptions, amountCents },
      );
      attempt.current = null;
      return go({
        kind: 'loaded',
        done: { read, amountCents, feeCents: out.serviceFeeCents ?? 0, method: 'cash', wallet: null, linked: true, warn: null, reference: out.codeHint },
      });
    }
    const target = deskTarget(read.view, read.nfc);
    // Un saldo nuevo lleva ya su ficha: el servidor la da en la misma operación.
    const out = await cashWithFreshFee(
      () =>
        staffBackend.cash({
          amountCents,
          idempotencyKey: keyFor(amountCents, 'cash', read),
          wallet: cashTopUpWallet(target, read.nfc),
          // La «Comisión del servicio» que se ha dicho (si cambió, el servidor no la apunta).
          ...topUpCharge(options, amountCents).body,
        }),
      { refresh: () => staffBackend.options(), onOptions: setOptions, amountCents },
    );
    const hasPin = read.view?.kind === 'saldo' && read.view.hasPin;
    const wallet = { walletId: out.walletId, code: out.code, balanceCents: out.balanceCents, hasPin, hasCard: read.nfc !== null };
    await finish(read, amountCents, 'cash', wallet, out.cardLinked === true, out.serviceFeeCents ?? 0);
  }

  /**
   * Efectivo. Sin respuesta (o con el servidor caído) no se sabe si se cargó:
   * en vez de «vuelve a intentarlo» (y pasar al siguiente cliente con la
   * ficha vacía), «Comprobando…» repitiéndola con la misma clave.
   */
  async function payCash(read: Read, amountCents: number): Promise<void> {
    try {
      await sendCash(read, amountCents);
    } catch (err) {
      if (!cashTopUpUnsure(err)) throw err;
      void checkCash(read, amountCents, CASH_CHECK_TRIES);
    }
  }

  /** Repite la recarga (misma clave) hasta saber qué pasó; si no hay manera, se pide comprobarlo a mano. */
  async function checkCash(read: Read, amountCents: number, tries: number): Promise<void> {
    const token = (cashCheck.current += 1);
    for (let i = 0; i < tries; i += 1) {
      go({ kind: 'cashUnsure', read, amountCents, checking: true });
      await sleep(CASH_CHECK_DELAY_MS);
      if (token !== cashCheck.current) return;
      try {
        await sendCash(read, amountCents);
        return;
      } catch (err) {
        if (token !== cashCheck.current) return;
        if (!cashTopUpUnsure(err)) {
          // El servidor la rechazó: no se cargó.
          go({ kind: 'method', read, amountCents });
          setError(errText(err));
          return;
        }
      }
    }
    go({ kind: 'cashUnsure', read, amountCents, checking: false });
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
    await retire(old);
    go({ kind: 'card', read, amountCents, payment: null });
    const payment = await newCardPayment(read, amountCents);
    setStep({ kind: 'card', read, amountCents, payment });
  }

  async function cardPaid(read: Read, payment: CreatedPayment): Promise<void> {
    const view = read.view;
    if (view?.kind === 'saldo') {
      const w = { walletId: view.walletId, code: view.code, balanceCents: view.balanceCents + payment.amountCents, hasPin: view.hasPin, hasCard: read.nfc !== null };
      return finish(read, payment.amountCents, 'card', w, false, payment.serviceFeeCents ?? 0);
    }
    // Saldo nuevo: su código para darle el NFC (y el PIN).
    const w = payment.walletId ? await staffBackend.wallet(payment.walletId).catch(() => null) : null;
    return finish(read, payment.amountCents, 'card', w, false, payment.serviceFeeCents ?? 0);
  }

  // ─── Salida (4.5) ───────────────────────────────────────────────────────

  /** «Devolver»: antes del PIN, qué hace falta (su Face ID, el encargado…). */
  async function startRefund(exit: Exit): Promise<void> {
    const plan = await fetchPayoutPlan(exit.view.walletId);
    if (plan.amountCents !== exit.view.cashOutCents) throw new Error('El importe ha cambiado: vuelve a acercar el NFC.');
    const next = exitNext(plan);
    if (next === 'passkey') return go({ kind: 'exitPasskey', exit, plan });
    if (next === 'totp') return go({ kind: 'exitTotp', exit, plan, passkey: false });
    if (next === 'manager') return go({ kind: 'exitManager', exit, plan });
    go({ kind: 'exitPin', exit });
  }

  /** Devolver en efectivo: con su PIN o su Face ID ya confirmado (y el 2FA del encargado si hace falta). */
  async function sendPayout(exit: Exit, o: { pin?: string; totpCode?: string; passkey?: boolean; plan?: ReceptionPayoutPlan | null }): Promise<void> {
    const { view, nfc: card, requestKey } = exit;
    if (!card?.uid) throw new Error('Acerca el NFC original.');
    const out = await receptionCashPayout(view.walletId, {
      card: card.card, uid: card.uid, expectedAmountCents: view.cashOutCents, requestKey,
      ...(o.pin ? { pin: o.pin } : {}),
      ...(o.totpCode ? { totpCode: o.totpCode } : {}),
    });
    // El encargado pone su 2FA y sigue (el PIN que ya puso el cliente no se vuelve a pedir).
    if (out.kind === 'totp') return go({ kind: 'exitTotp', exit, plan: o.plan ?? null, passkey: o.passkey === true, pin: o.pin, message: out.message });
    if (out.kind === 'passkey') return go({ kind: 'exitPasskey', exit, plan: await fetchPayoutPlan(view.walletId) });
    if (out.kind === 'manager') return go({ kind: 'managerPending', exit, message: out.message });
    go({ kind: 'refunded', code: view.code, refundedCents: out.refundedCents, remainingCents: out.remainingCents });
  }

  function keep(view: { balanceCents: number }, label: string): void {
    restart('salida', `Guardado: ${label} sigue con ${eur(view.balanceCents)}.`);
  }

  const name = user.displayName ?? 'Recepción';
  // La sección de las entradas con el nombre del local (Ajustes → Secciones), no el de fábrica.
  const chip = receptionChip(sections);
  const head = (onBack?: () => void) => <DeskHead title="Recepción" sub={name} chip={chip} stripe="section" onBack={onBack} />;

  if (step.kind === 'exitPin') {
    return <PinPad mode="enter"
      title={`Devolver ${eur(step.exit.view.cashOutCents)} en efectivo`}
      hint="Pásale el móvil al cliente para que confirme con su PIN"
      onCancel={() => go(step.exit)}
      onPin={async (pin) => { await sendPayout(step.exit, { pin, totpCode: step.totpCode }); return null; }} />;
  }

  if (step.kind === 'loaded') return renderLoaded(step.done);

  if (step.kind === 'cashUnsure') return renderCashUnsure(step);

  if (step.kind === 'pin' && step.done.wallet) {
    const { done } = step;
    const wallet = step.done.wallet;
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${wallet.code}`}
        hint="Pásale el móvil al cliente para que elija su PIN"
        onCancel={() => go({ kind: 'loaded', done: { ...done, seen: true } })}
        onPin={async (pin) => {
          const next = await staffBackend.setPin(wallet, pin);
          go({ kind: 'loaded', done: { ...done, wallet: next, seen: true } });
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
        money={{ icon: 'cash', label: 'Efectivo:', amount: eur(step.refundedCents), tail: 'de la caja' }}
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
          await retire(payment);
          go({ kind: 'method', read, amountCents });
        }))}
        payment={payment}
        amountCents={amountCents}
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
            ? (qrSettled) =>
                void run(async () => {
                  // Primero se retira el QR (si ya lo pagó, el servidor no deja: sale su CARGADO).
                  if (!qrSettled) await retire(payment);
                  setStep({ kind: 'card', read, amountCents, payment: null });
                  await payCash(read, amountCents);
                })
            : undefined
        }
        cashBusy={busy}
        onBack={() => go({ kind: 'method', read, amountCents })}
        error={error}
      />
    );
  }

  const topLevel = step.kind === 'tap' || step.kind === 'exit' || step.kind === 'exitNew' || step.kind === 'exitNumber';
  return (
    <div className={s.screen}>
      {topLevel ? (
        <>
          {head(step.kind === 'tap' ? undefined : () => restart('salida'))}
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
            <DeskBtn kind="gho" label="Buscar número de ficha" onClick={() => go({ kind: 'number' })} />
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

      {step.kind === 'number' ? <NumberStep busy={busy} error={error} onFind={(n) => void run(() => openByNumber(n))} /> : null}

      {step.kind === 'amount' ? (
        <AmountStep
          row={readRow(step.read)}
          amounts={amounts}
          onPick={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })}
          onOther={() => go({ kind: 'keypad', read: step.read })}
        />
      ) : null}

      {step.kind === 'keypad' ? <KeypadStep onDone={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })} /> : null}

      {step.kind === 'method' ? renderMethod(step.read, step.amountCents) : null}

      {step.kind === 'exit' ? (
        <ExitStep
          row={deskRow(step.view, 'salida')}
          plan={cashExitPlan(step.view, step.nfc)}
          busy={busy}
          onKeep={() => keep(step.view, step.view.code)}
          onRefund={() => void run(() => startRefund(step))}
          onReadNfc={!step.nfc?.uid && step.view.fichaNumber !== null ? () => restart('salida') : undefined}
        />
      ) : null}

      {step.kind === 'exitNumber' ? (
        <NumberExitStep view={step.view} onKeep={() => keep(step.view, step.view.codeHint)} onTap={() => restart('salida', 'Para devolver efectivo, acerca su NFC original.')} />
      ) : null}

      {step.kind === 'exitPasskey' ? renderPasskey(step) : null}

      {step.kind === 'exitTotp' ? (
        <TotpExitStep
          plan={step.plan}
          amountCents={step.exit.view.cashOutCents}
          message={step.message}
          busy={busy}
          then={step.passkey || step.pin ? 'Devolver' : 'Seguir con el PIN del cliente'}
          onCode={(totpCode) => {
            const { exit, passkey, pin, plan } = step;
            if (passkey || pin) void run(() => sendPayout(exit, { pin, totpCode, passkey, plan }));
            else go({ kind: 'exitPin', exit, totpCode });
          }}
        />
      ) : null}

      {step.kind === 'exitManager' ? (
        <ManagerExitStep plan={step.plan} amountCents={step.exit.view.cashOutCents}
          onAsk={() => go({ kind: 'exitPin', exit: step.exit })}
          onKeep={() => keep(step.exit.view, step.exit.view.code)} />
      ) : null}

      {step.kind === 'managerPending' ? (
        <>
          <DeskRowView {...deskRow(step.exit.view, 'salida')} />
          <p className={s.q} role="status">Pendiente del encargado; no se ha devuelto dinero</p>
          <p className={s.lbl}>{step.message || 'El encargado confirma la devolución con su propio 2FA desde su panel.'}</p>
          <DeskBtn kind="pri" size="l" label="Siguiente cliente" onClick={() => restart('salida')} />
        </>
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

      {error && step.kind !== 'tap' && step.kind !== 'code' && step.kind !== 'number' ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
    </div>
  );

  /** Efectivo sin respuesta: se comprueba antes de pasar al siguiente cliente (sin flecha atrás). */
  function renderCashUnsure(st: Extract<Step, { kind: 'cashUnsure' }>) {
    const { read, amountCents, checking, leaveArmed } = st;
    return (
      <div className={s.screen}>
        {head()}
        {/* Ni «sin saldo» ni lo que le quedaba: puede que ya esté cargado. */}
        <DeskRowView {...cashUnsureRow(read, amountCents, checking)} />
        {checking ? (
          <p className={s.q} role="status">
            Comprobando si se han cargado los {eur(amountCents)}…
          </p>
        ) : (
          <p role="alert" className={s.error}>
            {cashUnsureText(eur(amountCents))}
          </p>
        )}
        <DeskBtn kind="pri" size="l" label={checking ? 'Comprobando…' : 'Comprobar otra vez'} busy={checking} onClick={() => void checkCash(read, amountCents, 1)} />
        {checking ? null : leaveArmed ? (
          <>
            <p className={s.lbl}>{CASH_UNSURE_LEAVE_TEXT}</p>
            <DeskBtn kind="gho" label="Salir sin saberlo" onClick={() => restart('entrada', CASH_UNSURE_LEFT_NOTICE)} />
          </>
        ) : (
          <DeskBtn kind="gho" label="Siguiente cliente" onClick={() => setStep({ ...st, leaveArmed: true })} />
        )}
      </div>
    );
  }

  function renderLoaded(done: Loaded) {
    const money = loadedMoneyLine(done.method, done.amountCents, done.feeCents);
    const canPin = done.wallet !== null && !done.wallet.hasPin;
    const meta = done.read.number ? `Devuélvele su ficha · ${fichaText(done.read.number.printedNumber)}` : handOverLine(done.read.view, done.linked);
    // Pagó en efectivo aquí: su enlace privado no le llega; con este QR activa Face ID en su móvil.
    const activation = done.method === 'cash' && done.wallet && !done.read.number ? <ActivationQr walletId={done.wallet.walletId} /> : null;
    return (
      <DeskLoaded
        word="CARGADO"
        amountCents={done.amountCents}
        reference={done.reference ?? done.wallet?.code ?? null}
        money={{ icon: done.method, ...money }}
        meta={meta}
        warn={done.warn}
        quiet={done.seen}
        extra={activation}
        primary={{ label: 'Siguiente cliente', onClick: () => restart('entrada') }}
        secondary={canPin ? { label: 'Que ponga su PIN', onClick: () => go({ kind: 'pin', done }) } : null}
      />
    );
  }

  function renderMethod(read: Read, amountCents: number) {
    let buttons = read.number ? numberMethodButtons(options) : [];
    if (!read.number && options) buttons = methodButtons(options, deskTarget(read.view, read.nfc), amountCents, night.receptionDefaultMethod);
    const hasPin = read.number ? true : read.view?.kind === 'saldo' && read.view.hasPin;
    return (
      <MethodStep
        chip={read.number ? `Recarga · ${fichaText(read.number.printedNumber)}` : rechargeChip(read.view)}
        amountCents={amountCents}
        feeText={topUpCharge(options, amountCents).feeCents > 0 ? topUpCharge(options, amountCents).text : null}
        loading={options === null}
        blocked={null}
        buttons={buttons}
        pinNote={hasPin ? null : pinNote(night.nfcNoPinMaxCents)}
        busy={busy}
        onPick={(method) => {
          if (method === 'cash') void run(() => payCash(read, amountCents));
          else void run(() => changeCard(read, amountCents, null));
        }}
      />
    );
  }

  function renderPasskey(st: Extract<Step, { kind: 'exitPasskey' }>) {
    const { exit, plan } = st;
    const card = exit.nfc;
    if (!card?.uid) return null;
    const skip = canSkipPasskey(user.role)
      ? {
          label: user.role === 'OWNER' ? 'Sin su móvil: con su PIN' : 'Sin su móvil: tu 2FA y su PIN',
          onClick: () => go(user.role === 'OWNER'
            ? { kind: 'exitPin', exit }
            : { kind: 'exitTotp', exit, plan: { ...plan, reasons: [...plan.reasons, 'no_passkey'] }, passkey: false }),
        }
      : undefined;
    return (
      <PasskeyExitStep
        walletId={exit.view.walletId}
        proof={{ card: card.card, uid: card.uid, expectedAmountCents: exit.view.cashOutCents, requestKey: exit.requestKey }}
        plan={plan}
        onWithoutPhone={skip}
        onKeep={() => keep(exit.view, exit.view.code)}
        onConfirmed={() => {
          if (plan.needs === 'manager_2fa') go({ kind: 'exitTotp', exit, plan, passkey: true });
          else void run(() => sendPayout(exit, { passkey: true, plan }));
        }}
      />
    );
  }
}

/** La fila de 4.2: su NFC, su código o la ficha buscada por su número (tapada). */
function readRow(read: Read): { title: string; detail: string } {
  if (read.number) return numberRow(read.number);
  return read.view ? deskRow(read.view, 'entrada') : { title: 'Saldo nuevo', detail: 'Sin NFC: se queda con su código' };
}

/** Volver un paso (la cabecera): del importe al NFC, del teclado y de cómo paga al importe; de la salida, a lo que le queda. */
function backOf(step: Step): Step {
  if (step.kind === 'keypad') return { kind: 'amount', read: step.read };
  if (step.kind === 'method') return { kind: 'amount', read: step.read };
  if (step.kind === 'exitPasskey' || step.kind === 'exitTotp' || step.kind === 'exitManager' || step.kind === 'managerPending') return step.exit;
  return { kind: 'tap' };
}
