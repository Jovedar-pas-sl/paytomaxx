'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AmountKeypad, outcomeKindOf, useWakeLock, type PaymentStatus } from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { cancelPayment, type CreatedPayment } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { useOpenCharge, type ChargeSpot } from '@/lib/open-charges';
import { advanceStatus, isFinalStatus } from '@/lib/payment-status';
import { StaffOutcome } from '../../StaffOutcome';
import { usePaymentLive } from '../../use-payment-live';
import { DeskBtn, Icon } from './desk-parts';
import s from './desk.module.css';

/**
 * Retirar el QR de la recarga (otro importe, «Mejor en efectivo», volver): una
 * vez por cobro. Si después algo falla y se repite, no se retira dos veces.
 * Si el cliente ya lo pagó, el servidor no deja retirarlo (y sale su CARGADO).
 */
export function useRetirePayment(): (payment: CreatedPayment | null) => Promise<void> {
  const retired = useRef(new Set<string>());
  return useCallback(async (payment) => {
    if (!payment || retired.current.has(payment.id)) return;
    await cancelPayment(payment.id);
    retired.current.add(payment.id);
  }, []);
}

interface Props {
  /** La cabecera de la pantalla (recepción o «Recargar saldo»). */
  head: ReactNode;
  /** Dónde está abierto (si la sesión caduca, se vuelve a esa pestaña). Por defecto, Recepción. */
  spot?: ChargeSpot;
  /** El cobro de la recarga (null: aún sin importe, o retirado). */
  payment: CreatedPayment | null;
  /** El importe elegido (null: aún ninguno). */
  amountCents: number | null;
  /** Los importes rápidos del local (encima del QR). */
  amounts: readonly number[];
  /** Otro importe: quien lo usa crea el cobro nuevo (y retira el anterior). */
  onAmount: (cents: number) => void;
  /** Creando o cambiando el cobro. */
  changing: boolean;
  /** «Se carga en K7Q-4M2.» */
  forWhom: string;
  /** Pagado (una vez). */
  onPaid: (payment: CreatedPayment) => void;
  /**
   * «Mejor en efectivo» (solo si quien cobra puede: recepción). `qrSettled`: el
   * QR ya no se puede pagar (no pagado o caducado): no hay que retirarlo.
   */
  onCash?: (qrSettled: boolean) => void;
  cashBusy?: boolean;
  /** No pagado o caducado: otro QR con el mismo importe. */
  onRetry: () => void;
  onBack: () => void;
  error: string | null;
}

/**
 * 4.7: la recarga con tarjeta, que el cliente paga en su móvil (tarjeta,
 * Apple Pay o Google Pay). El importe se cambia con un toque encima del QR,
 * sin volver atrás; el saldo de destino, escrito arriba. Si se corta, queda
 * pendiente en su saldo. Mientras está abierto la pantalla no se apaga y, si
 * la sesión caduca, se entra encima sin perderlo.
 */
export function TopUpQr(props: Props) {
  const { payment, amounts } = props;
  const [status, setStatus] = useState<PaymentStatus>((payment?.status as PaymentStatus) ?? 'CREATED');
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState(0);
  const paymentId = payment?.id ?? null;

  // Un cobro nuevo (otro importe u otro QR) empieza en su estado.
  useEffect(() => {
    setStatus((payment?.status as PaymentStatus) ?? 'CREATED');
  }, [paymentId]);

  usePaymentLive(payment, (update) => setStatus((current) => advanceStatus(current, update.status)));
  const open = payment !== null && !isFinalStatus(status);
  useWakeLock(open);
  useOpenCharge(props.spot ?? 'recepcion', payment !== null, open);

  const outcome = payment ? outcomeKindOf(status) : null;
  useEffect(() => {
    if (outcome === 'paid' && payment) props.onPaid(payment);
    // Una vez por cobro pagado.
  }, [outcome, paymentId]);

  if (payment && (outcome === 'failed' || outcome === 'expired')) {
    return (
      <StaffOutcome
        kind={outcome}
        amountCents={payment.amountCents}
        message={outcome === 'failed' ? 'Que pruebe con otra tarjeta, o en efectivo.' : undefined}
        primary={{ label: 'Otro QR · mismo importe', onClick: props.onRetry, loading: props.changing }}
        secondary={
          props.onCash
            ? { label: 'Mejor en efectivo', onClick: () => props.onCash?.(true), disabled: props.changing }
            : { label: 'Volver', onClick: props.onBack }
        }
        error={props.error}
      />
    );
  }

  const selected = props.amountCents;
  const other = selected !== null && !amounts.includes(selected);
  return (
    <div className={s.screen}>
      {props.head}
      <div className={s.amts} role="group" aria-label="Cuánto carga">
        {amounts.slice(0, 3).map((c) => (
          <button
            key={c}
            type="button"
            className={s.amt}
            aria-pressed={!typing && selected === c}
            disabled={props.changing}
            onClick={() => {
              setTyping(false);
              // El mismo importe sin QR (se retiró o falló): otro QR.
              if (selected !== c || payment === null) props.onAmount(c);
            }}
          >
            {formatEur(c, { compact: true })}
          </button>
        ))}
        <button
          type="button"
          className={`${s.amt} ${s.amtTxt}`}
          aria-pressed={typing || other}
          disabled={props.changing}
          onClick={() => {
            setTyped(0);
            setTyping(true);
          }}
        >
          {other && !typing ? formatEur(selected ?? 0, { compact: true }) : 'Otro'}
        </button>
      </div>

      {typing ? (
        <>
          <AmountKeypad valueCents={typed} onChange={setTyped} maxCents={MAX_TYPED_AMOUNT_CENTS} label="Importe a cargar" />
          <DeskBtn
            kind="pri"
            label={typed > 0 ? `Cargar ${formatEur(typed, { compact: true })}` : 'Pon el importe'}
            disabled={typed <= 0}
            busy={props.changing}
            onClick={() => {
              setTyping(false);
              props.onAmount(typed);
            }}
          />
        </>
      ) : (
        <>
          <div className={`${s.qr} ${payment && !props.changing ? '' : s.qrWait}`} aria-busy={props.changing || undefined}>
            {payment && !props.changing ? (
              <img src={payment.qrPngDataUrl} alt="QR de la recarga" />
            ) : (
              <p className={s.qrEmpty}>{props.changing ? 'Un momento…' : selected === null ? 'Elige cuánto carga' : 'Toca el importe para sacar el QR'}</p>
            )}
          </div>
          <p className={s.waitT}>Que lo pague en su móvil</p>
          <p className={s.lbl}>Tarjeta, Apple Pay o Google Pay. {props.forWhom}</p>
          <p className={s.note}>
            <Icon name="clock" />
            Si se corta, queda pendiente en su saldo. No se pierde.
          </p>
        </>
      )}

      {props.error ? (
        <p role="alert" className={s.error}>
          {props.error}
        </p>
      ) : null}

      {props.onCash && !typing ? (
        <div className={s.foot}>
          <DeskBtn
            kind="gho"
            icon="cash"
            label="Mejor en efectivo"
            disabled={selected === null || props.changing}
            busy={props.cashBusy}
            onClick={() => props.onCash?.(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
