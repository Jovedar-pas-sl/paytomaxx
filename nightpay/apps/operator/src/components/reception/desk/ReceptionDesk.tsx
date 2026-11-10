'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FichaCheck, ReceptionOptions } from '@nightpay/contracts';
import { createPayment, fetchTerminals, type CreatedPayment, type OperatorUser } from '@/lib/api';
import { playOutcomeSound } from '@/lib/alert-sound';
import type { ChipTap } from '@/lib/chip-tap';
import {
  counterFicha,
  counterTapText,
  loadedBlockedText,
  confirmsWithFicha,
  isFreshTap,
  loadedOtherTap,
  needsFichaCheck,
  sameCounterCard,
} from '@/lib/counter-tap';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import {
  receptionAttempt,
  staffBackend,
  stockOutcomeLine,
  cashWithFreshFee,
  topUpCharge,
  type PayMethod,
  type ReceptionWallet,
} from '@/lib/reception';
import {
  attemptOnStep,
  canChoosePin,
  canChoosePinAfterLoad,
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
  FICHA_IN_HAND,
  lastTopUpOf,
  fetchFichaByNumber,
  fetchReceptionDesk,
  handOverLine,
  loadedMoneyLine,
  METHOD_ARM_MS,
  methodButtons,
  noPinLimitCents,
  noReaderStage,
  numberEntryProblem,
  numberMethodButtons,
  pinAfterLoad,
  pinAfterLoadText,
  pinNote,
  quickAmounts,
  readFicha,
  rechargeChip,
  rechargeProblem,
  refundDoneLine,
  topUpByNumber,
  type PinAfterLoad,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
} from '@/lib/reception-desk';
import { undoCashTopUp, type CashUndoReason } from '@/lib/cash-undo';
import { fichaShort, photoHint } from '@/lib/ficha-number';
import { handOverOf, loadedHelp } from '@/lib/reception-help';
import { receptionChip, useMySections } from '@/lib/sections';
import { useVenueNight } from '@/lib/venue-methods';
import {
  canSkipPasskey,
  cashExitPlan,
  exitNext,
  fetchPayoutPlan,
  receptionCashPayout,
  type ReceptionPayoutPlan,
} from '@/lib/reception-cash-payout';
import { PinPad } from '../../PinPad';
import { ActivationQr } from './ActivationQr';
import { CounterAviso, DeskHead, DeskBtn, DeskRowLink, DeskRowView } from './desk-parts';
import { AmountStep, CashConfirmStep, CodeStep, ExitStep, KeypadStep, MethodStep, NumberStep, TapStage } from './DeskSteps';
import { DeskLoaded, LoadedBand } from './DeskLoaded';
import { ManagerExitStep, NumberExitStep, PasskeyExitStep, TotpExitStep } from './ExitSteps';
import { TopUpQr, useRetirePayment } from './TopUpQr';
import { UndoLink, UndoneStep, UndoRow, UndoStep } from './UndoSteps';
import { useDeskNfc, type TapMeta } from './use-desk-nfc';
import { CHARGING, PhoneOption, backOf, counterOf, ignoreCounterError, readRow, useCashAttemptRef, type Exit, type Loaded, type Mode, type Read, type Step } from './desk-model';
import s from './desk.module.css';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errText = (err: unknown) => (err as Error).message;
const eur = (cents: number) => formatEur(cents, { compact: true });

/** «50 € · ficha 1013» (o su código): de qué recarga es «Me he equivocado» en la primera pantalla (B4). */
function undoRowLabel(done: Loaded): string {
  const ficha = fichaShort(readFicha(done.read));
  const who = ficha ? `ficha ${ficha}` : (done.wallet?.code ?? done.reference ?? '');
  return [eur(done.amountCents + done.feeCents), who].filter(Boolean).join(' · ');
}

interface Props {
  user: OperatorUser;
  /** La pestaña se ve: solo entonces se escucha el NFC (en Inicio lo usa el cobro). */
  active: boolean;
  /** Lo de siempre, debajo del primer paso: «Preparar fichas», «Pendientes de asignar (2)». */
  footer: ReactNode;
  /** Un saldo sin ficha encontrado por su código (A7): «Darle una» abre «Dar ficha a un saldo» con él. */
  onGiveFicha?: (code: string) => void;
  /** B5: «Escanear su QR (cargó en casa)»: abre «Dar ficha a un saldo» con la cámara ya puesta. */
  onScanHome?: () => void;
  /**
   * B12: Inicio → «Recargar saldo», con las mismas pantallas (solo la entrada,
   * sin el pie de Recepción). `onExit`: volver a cobrar; `onDone`: recargado.
   */
  home?: { onExit: () => void; onDone: () => void };
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
export function ReceptionDesk({ user, active, footer, onGiveFicha, onScanHome, home }: Props) {
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
  // La de efectivo queda también en la pestaña: si la pantalla falla a mitad y
  // se vuelve a hacer la misma recarga, no se carga dos veces (S-4).
  const attempt = useCashAttemptRef();
  const retire = useRetirePayment();
  // La comprobación en curso de una recarga sin respuesta (otra la anula).
  const cashCheck = useRef(0);
  // Se acercó otra ficha en el mostrador (A3): el aviso, hasta cambiar de pantalla.
  const [wrong, setWrong] = useState<string | null>(null);
  const counterRound = useRef(0);
  const printedOf = useRef(new Map<string, string | null>());
  // B3: el QR de Face ID está a la vista en CARGADO (la siguiente ficha no lo cierra).
  const [faceQrOpen, setFaceQrOpen] = useState(false);
  // Cuándo salió la pantalla: la ficha que aún se estaba leyendo al tocar «Efectivo» no lo confirma (B2).
  const stepShownAt = useRef(0);
  // B4: las últimas recargas en efectivo de esta pantalla, para «Me he equivocado» en la primera pantalla (2 min).
  const [recentCash, setRecentCash] = useState<Loaded[]>([]);

  useEffect(() => {
    staffBackend
      .options()
      .then(setOptions)
      .catch((err: Error) => setError(err.message));
  }, []);

  // El lector escucha siempre en el mostrador (A3); solo en la primera pantalla
  // lee para abrir (y graba una ficha en blanco); en las demás, solo avisa.
  const here = counterOf(step);
  const atTap = step.kind === 'tap';
  const nfc = useDeskNfc(
    active && !busy && (atTap || here !== null),
    mode === 'entrada' && step.kind === 'tap',
    atTap ? onTap : onCounterTap,
    atTap ? setError : ignoreCounterError,
  );
  useEffect(() => {
    counterRound.current += 1;
    stepShownAt.current = Date.now();
    setWrong(null);
    setFaceQrOpen(false);
  }, [step.kind]);
  useEffect(() => {
    if (step.kind !== 'loaded') return;
    const done = step.done;
    if (done.method !== 'cash' || !done.topUpId || !done.loadedAt || !needsFichaCheck(counterFicha(done.read))) return;
    setRecentCash((prev) => [done, ...prev.filter((d) => d.topUpId !== done.topUpId)].slice(0, 3));
  }, [step]);
  useOpenCharge(home ? 'cobro' : 'recepcion', CHARGING.has(step.kind), step.kind === 'card' && step.payment !== null);
  // B12: recargado desde Inicio, lo de la persona se pone al día (como tras un cobro).
  useEffect(() => {
    if (step.kind === 'loaded') home?.onDone();
  }, [step.kind]);
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

  /**
   * Fuera de la primera pantalla el lector sigue escuchando (A3): con la ficha
   * de este cliente no pasa nada; con otra, solo el aviso («Esa es la 1014, no
   * la 1013»). No graba, no carga y no cambia de pantalla.
   */
  async function onCounterTap(tap: ChipTap, meta: TapMeta): Promise<void> {
    const ficha = here;
    if (!ficha) return;
    const at = step;
    if (sameCounterCard(ficha, tap.token)) return counterSame(at, tap, meta);
    const round = counterRound.current;
    const printed = tap.token && !tap.other ? await printedOfCard(tap.token, tap.uid) : null;
    if (round !== counterRound.current) return;
    const text = counterTapText(ficha, { token: tap.token, printed });
    if (text === null) return counterSame(at, tap, meta);
    await counterOther(at, tap, text);
  }

  /** El número impreso de la ficha acercada, una vez por ficha (sigue apoyada y se lee otra vez). */
  async function printedOfCard(card: string, uid: string | null): Promise<string | null> {
    const known = printedOf.current;
    if (known.has(card)) return known.get(card) ?? null;
    const printed = await fetchReceptionDesk(uid ? { card, uid } : { card }).then(
      (view) => view.printedNumber ?? null,
      () => null,
    );
    known.set(card, printed);
    return printed;
  }

  /** Un saldo sin ficha (por su código), en la entrada (A7): «Darle una». */
  function giveFichaOf(read: Read): (() => void) | undefined {
    const view = read.view;
    if (!onGiveFicha || mode !== 'entrada' || view?.kind !== 'saldo' || view.fichaNumber !== null || view.blocked) return undefined;
    return () => onGiveFicha(view.code);
  }

  /** La misma ficha en el mostrador: confirma el efectivo (B2) o la anulación (B4); en lo demás no pasa nada (A3). */
  function counterSame(at: Step, tap: ChipTap, meta: TapMeta): void {
    setWrong(null);
    // Solo si se ha retirado y vuelto a acercar: apoyada sin moverla no confirma nada (confirmsWithFicha).
    if (at.kind === 'cashConfirm' && confirmsWithFicha({ waitedMs: meta.waitedMs, shownAt: stepShownAt.current, now: Date.now(), armMs: METHOD_ARM_MS })) {
      void run(() => payCash(at.read, at.amountCents, 'tap'));
    }
    if (at.kind === 'undo' && at.reason && tap.token && isFreshTap(meta.waitedMs)) {
      void run(() => undoNow(at.done, at.reason!, tap));
    }
  }

  /** B4: con la misma ficha delante, se anula (el servidor lo comprueba otra vez: quién, cuándo, la ficha y el saldo). */
  async function undoNow(done: Loaded, reason: CashUndoReason, tap: ChipTap): Promise<void> {
    if (!done.topUpId || !tap.token) return;
    const out = await undoCashTopUp(done.topUpId, { reason, card: tap.token, ...(tap.uid ? { uid: tap.uid } : {}) });
    setRecentCash((prev) => prev.filter((d) => d.topUpId !== done.topUpId));
    go({ kind: 'undone', reason, cents: out.amountCents + (out.serviceFeeCents ?? 0) });
  }

  /**
   * Otra ficha: en CARGADO es el siguiente cliente y se abre (B3), salvo con el
   * PIN pendiente o el QR de Face ID a la vista; en lo demás, solo el aviso (A3).
   */
  async function counterOther(at: Step, tap: ChipTap, text: string): Promise<void> {
    let aviso = text;
    if (at.kind === 'loaded') {
      const why = loadedOtherTap({ pinPending: loadedPinPending(at.done), faceQrOpen });
      if (why === 'next') {
        restart('entrada');
        // En blanco (o con otra cosa): la primera pantalla la vuelve a leer y la prepara (aquí no se graba).
        if (tap.token && !tap.other) await onTap(tap);
        return;
      }
      aviso = loadedBlockedText(text, why);
    }
    setWrong(aviso);
    playOutcomeSound('warn');
  }

  /** Qué hacer con el PIN en CARGADO (la ficha, su tope y quién carga). */
  function loadedPin(done: Loaded): PinAfterLoad {
    const view = done.read.view;
    return pinAfterLoad({
      wallet: done.wallet,
      hasFicha: (done.read.nfc !== null && done.linked) || (view?.kind === 'saldo' && view.fichaNumber !== null),
      canChoose: canChoosePinAfterLoad(view, user.role, done.read.nfc !== null),
      noPinMaxCents: noPinLimitCents(night),
    });
  }

  /** B3: el PIN está pendiente mientras su teclado está abierto (antes de «Ahora no»). */
  function loadedPinPending(done: Loaded): boolean {
    return loadedPin(done) === 'ask' && !done.pinSkipped;
  }

  /** «Efectivo» (o «Mejor en efectivo»): con ficha, se confirma acercándola otra vez (B2); sin ella, como siempre. */
  async function cashChosen(read: Read, amountCents: number): Promise<void> {
    if (needsFichaCheck(counterFicha(read))) return go({ kind: 'cashConfirm', read, amountCents });
    await payCash(read, amountCents);
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
    topUpId?: string,
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
    go({ kind: 'loaded', done: { read, amountCents, feeCents, method, wallet: w, linked, warn, ...(topUpId ? { topUpId, loadedAt: Date.now() } : {}) } });
  }

  /**
   * La recarga en efectivo con la clave de este intento: repetirla no carga dos
   * veces. `how`: cómo se confirmó con la ficha (B2; «sin leerla» queda apuntado).
   */
  async function sendCash(read: Read, amountCents: number, how?: FichaCheck): Promise<void> {
    const check = how ? { fichaCheck: how } : {};
    if (read.number) {
      const out = await cashWithFreshFee(
        () =>
          topUpByNumber({
            printedNumber: read.number!.printedNumber,
            amountCents,
            idempotencyKey: keyFor(amountCents, 'cash', read),
            ...topUpCharge(options, amountCents).body,
            ...check,
          }),
        { refresh: () => staffBackend.options(), onOptions: setOptions, amountCents },
      );
      attempt.current = null;
      return go({
        kind: 'loaded',
        done: {
          read,
          amountCents,
          feeCents: out.serviceFeeCents ?? 0,
          method: 'cash',
          wallet: null,
          linked: true,
          warn: null,
          reference: out.codeHint,
          topUpId: out.topUpId,
          loadedAt: Date.now(),
        },
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
          ...check,
        }),
      { refresh: () => staffBackend.options(), onOptions: setOptions, amountCents },
    );
    const hasPin = read.view?.kind === 'saldo' && read.view.hasPin;
    const wallet = { walletId: out.walletId, code: out.code, balanceCents: out.balanceCents, hasPin, hasCard: read.nfc !== null };
    await finish(read, amountCents, 'cash', wallet, out.cardLinked === true, out.serviceFeeCents ?? 0, out.topUpId);
  }

  /**
   * Efectivo. Sin respuesta (o con el servidor caído) no se sabe si se cargó:
   * en vez de «vuelve a intentarlo» (y pasar al siguiente cliente con la
   * ficha vacía), «Comprobando…» repitiéndola con la misma clave.
   */
  async function payCash(read: Read, amountCents: number, how?: FichaCheck): Promise<void> {
    try {
      await sendCash(read, amountCents, how);
    } catch (err) {
      if (!cashTopUpUnsure(err)) throw err;
      void checkCash(read, amountCents, CASH_CHECK_TRIES, how);
    }
  }

  /** Repite la recarga (misma clave) hasta saber qué pasó; si no hay manera, se pide comprobarlo a mano. */
  async function checkCash(read: Read, amountCents: number, tries: number, how?: FichaCheck): Promise<void> {
    const token = (cashCheck.current += 1);
    for (let i = 0; i < tries; i += 1) {
      go({ kind: 'cashUnsure', read, amountCents, checking: true, how });
      await sleep(CASH_CHECK_DELAY_MS);
      if (token !== cashCheck.current) return;
      try {
        await sendCash(read, amountCents, how);
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
    go({ kind: 'cashUnsure', read, amountCents, checking: false, how });
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
  const head = (onBack?: () => void) => <DeskHead title={home ? 'Recargar saldo' : 'Recepción'} sub={name} chip={chip} onBack={onBack} />;

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
          const next = await staffBackend.setPin(wallet, pin, done.read.nfc);
          go({ kind: 'loaded', done: { ...done, wallet: next, seen: true } });
          return null;
        }}
      />
    );
  }

  if (step.kind === 'setPin') {
    const { read, view } = step;
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${view.code}`}
        hint="Pásale el móvil al cliente para que elija su PIN"
        onCancel={() => go({ kind: 'amount', read })}
        onPin={async (pin) => {
          await staffBackend.setPin({ walletId: view.walletId, code: view.code, balanceCents: view.balanceCents, hasPin: false, hasCard: read.nfc !== null }, pin);
          go({ kind: 'amount', read: { ...read, view: { ...view, hasPin: true } } });
          return null;
        }}
      />
    );
  }

  if (step.kind === 'refunded') {
    return (
      <DeskLoaded
        word="Devuelto"
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
                  await cashChosen(read, amountCents);
                })
            : undefined
        }
        cashBusy={busy}
        onBack={() => go({ kind: 'method', read, amountCents })}
        error={error}
        aviso={wrong}
      />
    );
  }

  const topLevel = step.kind === 'tap' || step.kind === 'exit' || step.kind === 'exitNew' || step.kind === 'exitNumber';
  return (
    <div className={s.screen}>
      {topLevel ? (
        <>
          {head(step.kind === 'tap' ? home?.onExit : () => restart('salida'))}
          {/* B12: desde Inicio solo se recarga (la salida es de Recepción). */}
          {home ? null : (
            <div className={s.seg} role="group" aria-label="Entrada o salida">
              {(['entrada', 'salida'] as const).map((m) => (
                <button key={m} type="button" className={s.segBtn} aria-pressed={mode === m} onClick={() => restart(m)}>
                  {m === 'entrada' ? 'Entrada' : 'Salida'}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        head(() => go(backOf(step)))
      )}

      {wrong && step.kind !== 'tap' ? <CounterAviso text={wrong} /> : null}

      {step.kind === 'tap' ? (
        <>
          <TapStage
            mode={mode}
            noReader={!nfc.reader.loading && !nfc.reader.via ? noReaderStage(mode) : null}
            stopped={nfc.stopped}
            onRestart={nfc.restart}
            busy={busy}
            error={error}
            notice={notice}
          />
          <div className={s.foot}>
            {/* Lo que no es acercarla: filas de lista, sin competir con el NFC. */}
            <div className={s.rows}>
              {/* B5: quien cargó desde casa llega con su QR: su ficha, sin buscar en el pie. */}
              {onScanHome && mode === 'entrada' ? <DeskRowLink label="Escanear su QR (cargó en casa)" onClick={onScanHome} /> : null}
              {/* B4: «Me he equivocado» sigue a mano sus 2 minutos, aunque CARGADO ya se cerrara. */}
              {mode === 'entrada'
                ? recentCash.map((d) => (
                    <UndoRow
                      key={d.topUpId}
                      loadedAt={d.loadedAt ?? 0}
                      label={undoRowLabel(d)}
                      onUndo={() => go({ kind: 'undo', done: d, reason: null, fromTap: true })}
                    />
                  ))
                : null}
              <DeskRowLink label="Escribir el código" onClick={() => go({ kind: 'code' })} />
              <DeskRowLink label="Buscar número de ficha" onClick={() => go({ kind: 'number' })} />
            </div>
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
          lastTopUp={lastTopUpOf(step.read)}
          hasFicha={Boolean(step.read.number) || step.read.view?.kind === 'new' || (step.read.view?.kind === 'saldo' && step.read.view.fichaNumber !== null)}
          amounts={amounts}
          onPick={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })}
          onOther={() => go({ kind: 'keypad', read: step.read })}
          onPin={
            step.read.view?.kind === 'saldo' && !step.read.view.hasPin && canChoosePin(step.read.view, user.role)
              ? () => go({ kind: 'setPin', read: step.read, view: step.read.view as ReceptionDeskSaldo })
              : undefined
          }
          onGiveFicha={giveFichaOf(step.read)}
        />
      ) : null}

      {step.kind === 'keypad' ? <KeypadStep onDone={(cents) => go({ kind: 'method', read: step.read, amountCents: cents })} /> : null}

      {step.kind === 'method' ? renderMethod(step.read, step.amountCents) : null}

      {step.kind === 'undo' ? (
        <UndoStep
          reason={step.reason}
          chargeCents={step.done.amountCents + step.done.feeCents}
          ficha={readFicha(step.done.read)}
          busy={busy}
          onReason={(reason) => go({ kind: 'undo', done: step.done, reason })}
        />
      ) : null}

      {step.kind === 'undone' ? <UndoneStep reason={step.reason} cents={step.cents} onNext={() => restart('entrada')} /> : null}

      {step.kind === 'cashConfirm' ? (
        <CashConfirmStep
          amountCents={step.amountCents}
          chargeCents={topUpCharge(options, step.amountCents).totalCents}
          ficha={readFicha(step.read)}
          busy={busy}
          onManual={() => void run(() => payCash(step.read, step.amountCents, 'manual'))}
        />
      ) : null}

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
          <DeskBtn kind="pri" label="Siguiente cliente" onClick={() => restart('salida')} />
        </>
      ) : null}

      {step.kind === 'exitNew' ? (
        <>
          <DeskRowView title="NFC sin saldo" detail={deskRow(step.view, 'salida').detail} check={false} />
          <p className={s.lbl}>No tiene saldo: guárdalo con los del stock.</p>
          <DeskBtn
            kind="pri"
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
    const { read, amountCents, checking, leaveArmed, how } = st;
    return (
      <div className={s.screen}>
        {head()}
        {wrong ? <CounterAviso text={wrong} /> : null}
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
        <DeskBtn kind="pri" label={checking ? 'Comprobando…' : 'Comprobar otra vez'} busy={checking} onClick={() => void checkCash(read, amountCents, 1, how)} />
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
    const view = done.read.view;
    const pin = loadedPin(done);
    const pinText = pin === 'ask' || pin === 'manager' ? pinAfterLoadText(pin, noPinLimitCents(night)) : null;
    const askPin = { label: 'Que elija su PIN', onClick: () => go({ kind: 'pin', done }) };
    const next = { label: 'Siguiente cliente', onClick: () => restart('entrada') };
    const meta = done.read.number ? 'Devuélvele su ficha' : handOverLine(done.read.view, done.linked);
    // B1 (aprobado el 2-nov): por encima del tope sin PIN, el teclado sale solo, con «Ahora no».
    if (pin === 'ask' && done.wallet && !done.seen && !done.pinSkipped) {
      return renderPinFirst(done, done.wallet, `${money.label} ${money.amount} ${money.tail} · ${meta}`);
    }
    // La ficha (si se le dio o es la suya) y el código, en grande; por número, el código va tapado arriba (A1, A11).
    const ficha = done.linked || view?.kind === 'saldo' || done.read.number ? readFicha(done.read) : null;
    const code = done.read.number ? null : (done.wallet?.code ?? null);
    const ids = {
      ficha,
      code,
      hint: ficha && (done.read.nfc || done.read.number) ? FICHA_IN_HAND : null,
      photo: photoHint({ ficha: ficha !== null, code: code !== null }),
    };
    // Qué hacer ahora, en orden: el efectivo a la caja, la ficha y, si pasa del tope, su PIN.
    const help = loadedHelp({ method: done.method, handOver: handOverOf({ view, linked: done.linked, byNumber: Boolean(done.read.number) }), pin });
    // Pagó en efectivo aquí: su enlace privado no le llega; con este QR activa Face ID en su móvil.
    // Si hace falta el PIN, primero eso: el QR solo si prefiere pagar con el móvil (si no, deja el botón fuera de la pantalla).
    const activation =
      done.method === 'cash' && done.wallet && !done.read.number ? (
        pin === 'ask' ? (
          <PhoneOption walletId={done.wallet.walletId} read={done.read.nfc} onOpen={setFaceQrOpen} />
        ) : (
          <ActivationQr walletId={done.wallet.walletId} read={done.read.nfc} onOpen={setFaceQrOpen} />
        )
      ) : null;
    return (
      <DeskLoaded
        word="Cargado"
        amountCents={done.amountCents}
        reference={done.read.number ? (done.reference ?? null) : null}
        money={{ icon: done.method, ...money }}
        meta={meta}
        ids={ids}
        warn={done.warn}
        note={pinText}
        quiet={done.seen}
        extra={activation}
        help={help}
        aviso={wrong}
        tertiary={
          done.method === 'cash' && done.topUpId && done.loadedAt && needsFichaCheck(counterFicha(done.read)) ? (
            <UndoLink loadedAt={done.loadedAt} onUndo={() => go({ kind: 'undo', done, reason: null })} />
          ) : null
        }
        primary={pin === 'ask' && !done.pinSkipped ? askPin : next}
        secondary={pin === 'ask' ? (done.pinSkipped ? askPin : { label: 'Ahora no', onClick: next.onClick }) : pin === 'offer' ? askPin : null}
      />
    );
  }

  /**
   * B1: el teclado del PIN, solo, nada más cargar (la ficha pasa del tope sin
   * PIN). Encima, «Cargado 50 €» y qué hacer con el dinero y la ficha. «Ahora
   * no» lleva a CARGADO con el aviso de lo que pasa sin PIN.
   */
  function renderPinFirst(done: Loaded, wallet: ReceptionWallet, line: string) {
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${wallet.code}`}
        hint="Pásale el móvil al cliente para que elija su PIN"
        cancelLabel="Ahora no"
        top={<LoadedBand word="Cargado" amountCents={done.amountCents} line={line} aviso={wrong} />}
        onCancel={() => go({ kind: 'loaded', done: { ...done, seen: true, pinSkipped: true } })}
        onPin={async (pin) => {
          const next = await staffBackend.setPin(wallet, pin, done.read.nfc);
          go({ kind: 'loaded', done: { ...done, wallet: next, seen: true } });
          return null;
        }}
      />
    );
  }

  function renderMethod(read: Read, amountCents: number) {
    let buttons = read.number ? numberMethodButtons(options) : [];
    if (!read.number && options) buttons = methodButtons(options, deskTarget(read.view, read.nfc), amountCents, night.receptionDefaultMethod);
    const hasPin = read.number ? true : read.view?.kind === 'saldo' && read.view.hasPin;
    return (
      <MethodStep
        chip={read.number ? 'Recarga' : rechargeChip(read.view)}
        amountCents={amountCents}
        ficha={readFicha(read)}
        chargeCents={topUpCharge(options, amountCents).totalCents}
        feeText={topUpCharge(options, amountCents).feeCents > 0 ? topUpCharge(options, amountCents).text : null}
        loading={options === null}
        blocked={null}
        buttons={buttons}
        pinNote={hasPin ? null : pinNote(noPinLimitCents(night), canChoosePinAfterLoad(read.view, user.role, read.nfc !== null))}
        busy={busy}
        onPick={(method) => {
          if (method === 'cash') void run(() => cashChosen(read, amountCents));
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
