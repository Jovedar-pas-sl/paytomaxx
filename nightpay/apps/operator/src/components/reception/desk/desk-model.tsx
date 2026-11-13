'use client';

// La recepción exprés: sus pasos (Step), lo leído y lo cargado, y lo que no
// necesita el estado de la pantalla (qué ficha hay en el mostrador, volver un
// paso, la clave guardada del efectivo). Lo usa ReceptionDesk.

import { useRef, useState } from 'react';
import type { CashUndoReason, FichaCheck, ReceptionDeskNew } from '@nightpay/contracts';
import type { CreatedPayment } from '@/lib/api';
import { counterFicha, type CounterFicha } from '@/lib/counter-tap';
import { browserSessionStorage, cashAttemptRef, type PayMethod, type ReceptionAttempt, type ReceptionWallet } from '@/lib/reception';
import type { CashExitNfc, ReceptionPayoutPlan } from '@/lib/reception-cash-payout';
import { entryRow, type NumberSaldo, type ReceptionDeskSaldo, type ReceptionDeskView } from '@/lib/reception-desk';
import { ActivationQr } from './ActivationQr';
import { DeskBtn } from './desk-parts';

export type Mode = 'entrada' | 'salida';

/**
 * Lo leído: su saldo (null: saldo nuevo sin NFC), el NFC acercado (null: por
 * el código) o la ficha buscada por su número (solo saldos que ya existen,
 * tapados: se recargan en efectivo).
 */
export interface Read {
  view: ReceptionDeskView | null;
  nfc: { card: string; uid: string | null } | null;
  number?: NumberSaldo;
}

/** La recarga hecha (4.4). */
export interface Loaded {
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
  /** B1: el teclado del PIN salió solo y el cliente dijo «Ahora no». */
  pinSkipped?: boolean;
  /** La referencia de arriba si no hay saldo entero (por número: K7Q-•••). */
  reference?: string | null;
  /** B4: la recarga en efectivo (para «Me he equivocado») y cuándo salió CARGADO (ms). */
  topUpId?: string;
  loadedAt?: number;
}

export type Exit = { kind: 'exit'; view: ReceptionDeskSaldo; nfc: CashExitNfc; requestKey: string };

export type Step =
  | { kind: 'tap' }
  | { kind: 'code' }
  | { kind: 'number' }
  /** `amountCents`: OxioParty, el importe tecleado en «Otro» (la taquilla lo marca). */
  | { kind: 'amount'; read: Read; amountCents?: number }
  | { kind: 'keypad'; read: Read }
  | { kind: 'method'; read: Read; amountCents: number }
  /** B2: el efectivo, a la espera de que se acerque otra vez la misma ficha (o «Cargar sin leerla»). */
  | { kind: 'cashConfirm'; read: Read; amountCents: number }
  | { kind: 'card'; read: Read; amountCents: number; payment: CreatedPayment | null }
  | { kind: 'loaded'; done: Loaded }
  | { kind: 'pin'; done: Loaded }
  /** Encargado o dueño: el PIN de una ficha que ya tenía saldo, sin cargar nada. */
  | { kind: 'setPin'; read: Read; view: ReceptionDeskSaldo }
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
  | { kind: 'cashUnsure'; read: Read; amountCents: number; checking: boolean; leaveArmed?: boolean; how?: FichaCheck }
  /** B4: «Me he equivocado»: el motivo y, después, la misma ficha. */
  | { kind: 'undo'; done: Loaded; reason: CashUndoReason | null; fromTap?: boolean }
  /** B4: anulada; `cents`: lo que se quitó (saldo + comisión). */
  | { kind: 'undone'; reason: CashUndoReason; cents: number };

/** Desde que se cobra hasta el resultado: si la sesión caduca, se entra encima sin perderlo. */
export const CHARGING = new Set<Step['kind']>(['card', 'loaded', 'pin', 'cashUnsure', 'exitPasskey', 'exitTotp', 'exitPin', 'managerPending', 'refunded']);

/** Quien prefiere pagar con el móvil: el QR de Face ID, solo si lo pide (gasta un enlace de un solo uso). */
export function PhoneOption({ walletId, read, onOpen }: { walletId: string; read: Read['nfc']; onOpen?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  if (open) return <ActivationQr walletId={walletId} read={read} onOpen={onOpen} />;
  return <DeskBtn kind="gho" label="Prefiere pagar con el móvil" onClick={() => setOpen(true)} />;
}

/** La fila de 4.2: su ficha (con su número en grande), su código o la ficha buscada por su número (tapada). */
export function readRow(read: Read) {
  return entryRow(read);
}

/** En el mostrador, un fallo al leer otra ficha no se enseña: no se estaba leyendo para nada (A3). */
export function ignoreCounterError(): void {}

/**
 * La ficha del cliente que se atiende en cada pantalla (A3): mientras hay una,
 * el lector escucha. Sin ella (primera pantalla, el código, el PIN…), null.
 */
export function counterOf(step: Step): CounterFicha | null {
  switch (step.kind) {
    case 'amount':
    case 'keypad':
    case 'method':
    case 'cashConfirm':
    case 'card':
    case 'cashUnsure':
      return counterFicha(step.read);
    case 'loaded':
      return counterFicha(step.done.read);
    case 'undo':
      return step.reason ? counterFicha(step.done.read) : null;
    case 'exit':
    case 'exitNew':
      return counterFicha({ view: step.view, nfc: step.nfc });
    case 'exitNumber':
      return counterFicha({ view: null, nfc: null, number: step.view });
    default:
      return null;
  }
}

/** Volver un paso (la cabecera): del importe al NFC, del teclado y de cómo paga al importe; de la salida, a lo que le queda. */
export function backOf(step: Step): Step {
  if (step.kind === 'keypad') return { kind: 'amount', read: step.read };
  if (step.kind === 'method') return { kind: 'amount', read: step.read };
  if (step.kind === 'cashConfirm') return { kind: 'method', read: step.read, amountCents: step.amountCents };
  // Desde la primera pantalla, a ella; desde CARGADO, a CARGADO (sin sonar otra vez).
  if (step.kind === 'undo') return step.fromTap ? { kind: 'tap' } : { kind: 'loaded', done: { ...step.done, seen: true } };
  if (step.kind === 'exitPasskey' || step.kind === 'exitTotp' || step.kind === 'exitManager' || step.kind === 'managerPending') return step.exit;
  return { kind: 'tap' };
}

/** El `ref` de la recarga en curso, con la de efectivo guardada en la pestaña (cashAttemptRef). */
export function useCashAttemptRef(): { current: ReceptionAttempt | null } {
  const ref = useRef<{ current: ReceptionAttempt | null } | null>(null);
  if (ref.current === null) ref.current = cashAttemptRef(browserSessionStorage());
  return ref.current;
}
