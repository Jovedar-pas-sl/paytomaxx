'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { callReader, type BridgeResponse, type PaytefResult } from '@/lib/pax-bridge';
import {
  PENDING_CONFIRM_TEXT,
  clearPendingResult,
  hasPendingResults,
  isChargeOnHold,
  isFinalRejection,
  notAcceptedReview,
  reportPaxResult,
  reviewOfOutcome,
  savePendingResult,
  saveSaleToReview,
  startPaxCharge,
  type PaxCharge,
  type SaleOutcome,
} from '@/lib/pax-api';
import {
  NOT_ACCEPTED_TEXT,
  UNSENT_NOTE,
  deliverFailure,
  readerFailure,
  recoverOutcome,
  resendDelayMs,
} from '@/lib/pax-flow';
import { voidSaleOnReader } from '@/lib/pax-void';
import { formatEur } from '@/lib/money';
import { posChargeLine } from '@/lib/cobro-view';

type Step =
  | { kind: 'reading' }
  | { kind: 'sending' }
  | { kind: 'outcome'; outcome: SaleOutcome }
  | { kind: 'readerError'; message: string; canRecover: boolean }
  /** Aprobada en el lector pero sin llegar a OxioPay: se reenvía sola (`tries` fallos ya); nunca se vuelve a cobrar. */
  | { kind: 'unsent'; message: string; result: PaytefResult; tries: number }
  /** Aprobada en el lector y rechazada del todo por OxioPay (4xx): el cliente ya pagó; nunca se repite. */
  | { kind: 'notAccepted'; message: string; operationNumber: string | null }
  | { kind: 'voided'; message: string };

/** Vuelta automática a la lista tras un cobro pagado. */
const BACK_AFTER_PAID_MS = 4000;

/** Errores del lector tras los que el cliente pudo haber pagado igualmente. */
const MAYBE_CHARGED = new Set(['timeout', 'serviceIsDown', 'httpError', 'deviceError']);

const PENDING_BLOCK_TEXT =
  'Hay un cobro aprobado que aún no ha llegado a OxioPay: espera a que se envíe antes de cobrar otro.';
const ON_HOLD_TEXT =
  'Este cobro tiene una venta del datáfono por revisar (en la lista): resuélvela antes de volver a cobrarlo.';

interface Props {
  charge: PaxCharge;
  onDone: () => void;
  /**
   * La referencia y el importe para el lector. Por defecto, /charges/:id/start
   * (cobro de una chica); la recarga de la recepción ya los trae al crearse.
   */
  start?: () => Promise<{ reference: string; amountCents: number }>;
  /** Pagado: quien lo usa sigue (la recepción pasa a la ficha y el PIN) en vez de volver a la lista. */
  onPaid?: () => void;
}

/**
 * Un cobro en el lector: importe al datáfono, el cliente acerca la tarjeta,
 * el resultado va a NightPay. Si el dinero se cobró pero el cobro no lo
 * admitía (doble cobro, importe distinto, rechazo), ofrece anular la
 * operación; y eso queda también en la lista de /pax hasta resolverlo.
 */
export function PaxChargeFlow({ charge, onDone, start, onPaid }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  // «Recuperar el resultado» ya contestó: hasta entonces no se ofrece cobrar
  // otra vez (si la primera se aprobó, el cliente pagaría dos veces).
  const [recoverAnswered, setRecoverAnswered] = useState(false);
  const reference = useRef<string | null>(null);
  /** Lo que hay que anular en el lector (lo que cobró él, no el importe del cobro). */
  const voidable = useRef<{ amountCents: number; reference: string } | null>(null);
  const started = useRef(false);
  // La lista de fondo se refresca sola: la vuelta tras "Pagado" no puede
  // depender de que onDone sea siempre la misma función (antes nunca saltaba).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  async function handleReader(r: BridgeResponse, autoRecover = true): Promise<void> {
    if (!r.ok || !r.result) {
      // Si pudo cobrarse (corte, lector sin respuesta), se pregunta al lector
      // por la última operación antes de dar nada por perdido.
      if (autoRecover && !r.ok && MAYBE_CHARGED.has(r.error)) {
        await recover(false);
        return;
      }
      setStep({ kind: 'readerError', ...readerFailure(r) });
      return;
    }
    await deliver(r.result);
  }

  /**
   * El resultado del lector a OxioPay. Si está aprobado, se guarda antes: si la
   * red falla, se reenvía. `quiet`: el reenvío automático (sin «Confirmando…»).
   */
  async function deliver(result: PaytefResult, opts: { quiet?: boolean; tries?: number } = {}): Promise<void> {
    if (!opts.quiet) setStep({ kind: 'sending' });
    const sale = { paymentId: charge.id, result, amountCents: charge.amountCents };
    if (result.approved) savePendingResult(charge.id, result, charge.amountCents);
    try {
      const outcome = await reportPaxResult(charge.id, result);
      // «Anula esta operación»: también en la lista, por si se vuelve sin anularla (A2-02).
      const review = reviewOfOutcome(sale, outcome);
      if (review) saveSaleToReview(review);
      voidable.current = review?.voidable ?? null;
      clearPendingResult(charge.id, result);
      setStep({ kind: 'outcome', outcome });
    } catch (err) {
      const message = sentence((err as Error).message);
      const next = deliverFailure({ approved: result.approved, final: isFinalRejection(err) });
      if (next === 'unsent') {
        setStep({ kind: 'unsent', message, result, tries: opts.tries ?? 0 });
        return;
      }
      if (next === 'notAccepted') {
        // Cobrada y rechazada: se guarda para revisar/anular; nunca «Volver a intentar» (A2-03).
        const review = notAcceptedReview(sale, message);
        saveSaleToReview(review);
        voidable.current = review.voidable;
        clearPendingResult(charge.id, result);
        setStep({ kind: 'notAccepted', message, operationNumber: review.operationNumber });
        return;
      }
      setStep({ kind: 'readerError', message, canRecover: false });
    }
  }

  async function begin() {
    // Con una venta aprobada sin enviar, no se empieza otra: se cobraría dos veces.
    if (hasPendingResults()) {
      setStep({ kind: 'readerError', message: PENDING_BLOCK_TEXT, canRecover: false });
      return;
    }
    // Ni con una venta de este cobro por anular o revisar (el cliente ya pagó en el datáfono).
    if (isChargeOnHold(charge.id)) {
      setStep({ kind: 'readerError', message: ON_HOLD_TEXT, canRecover: false });
      return;
    }
    setStep({ kind: 'reading' });
    setRecoverAnswered(false);
    try {
      const s = start ? await start() : await startPaxCharge(charge.id);
      reference.current = s.reference;
      await handleReader(await callReader('startSale', { amountCents: s.amountCents, reference: s.reference }));
    } catch (err) {
      setStep({ kind: 'readerError', message: (err as Error).message, canRecover: false });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
    // Solo al abrir el cobro.
  }, []);

  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  });
  useEffect(() => {
    if (step.kind !== 'outcome' || step.outcome.status !== 'PAID') return undefined;
    const paid = onPaidRef.current;
    if (paid) {
      paid();
      return undefined;
    }
    const t = setTimeout(() => onDoneRef.current(), BACK_AFTER_PAID_MS);
    return () => clearTimeout(t);
  }, [step]);

  // Aprobada y sin llegar a OxioPay: se reenvía sola, cada vez más espaciado (A2-05).
  useEffect(() => {
    if (step.kind !== 'unsent') return undefined;
    const { result, tries } = step;
    const t = setTimeout(() => void deliver(result, { quiet: true, tries: tries + 1 }), resendDelayMs(tries));
    return () => clearTimeout(t);
  }, [step]);

  async function recover(manual = true) {
    setBusy(true);
    const r = await callReader('lastResult');
    setBusy(false);
    if (manual) setRecoverAnswered(true);
    // Otra operación, sin referencia o sin resultado: no se sabe si este se
    // cobró. Nunca "no se cobró": volver a cobrar podría cobrarle dos veces.
    const out = recoverOutcome(r, reference.current, manual);
    if (out.kind === 'deliver') await deliver(out.result);
    else setStep({ kind: 'readerError', message: out.message, canRecover: out.canRecover });
  }

  async function voidOperation(operationNumber: string) {
    setBusy(true);
    const out = await voidSaleOnReader({
      paymentId: charge.id,
      operationNumber,
      amountCents: voidable.current?.amountCents ?? charge.amountCents,
      reference: reference.current ?? voidable.current?.reference ?? '',
    });
    setBusy(false);
    setStep({ kind: 'voided', message: out.message });
  }

  // Operación a anular cuando el dinero se cobró pero el cobro no lo admitía.
  const toVoid =
    step.kind === 'outcome' && (step.outcome.status === 'DUPLICATE' || step.outcome.status === 'MISMATCH')
      ? step.outcome.operationNumber
      : step.kind === 'notAccepted'
        ? step.operationNumber
        : null;

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'center' }}>
      <p style={muted}>
        {charge.createdByName}
        {charge.code ? ` · código ${charge.code}` : null}
      </p>
      <p className="np-num" style={{ margin: 0, fontSize: 'var(--np-fs-40)', fontWeight: 700 }}>
        {formatEur(charge.amountCents)}
      </p>
      {/* El lector pide el total: con la «Comisión del servicio», su desglose. */}
      {charge.serviceFeeCents ? <p style={muted}>{posChargeLine(charge)}</p> : null}

      {step.kind === 'reading' ? (
        <>
          <p style={big}>Acerca la tarjeta o el móvil al lector</p>
          <Button variant="ghost" onClick={() => void callReader('cancel')}>
            Cancelar
          </Button>
        </>
      ) : null}

      {step.kind === 'sending' ? <p style={big}>Confirmando…</p> : null}

      {step.kind === 'outcome' && step.outcome.status === 'PAID' ? (
        <>
          <p style={{ ...big, color: 'var(--np-success)' }}>Pagado ✓</p>
          <p style={muted}>Código de confirmación {step.outcome.code}</p>
          {/* Con onPaid quien lo usa ya sigue (la recepción, a la ficha y el PIN): «Volver» competiría. */}
          {onPaid ? <p style={muted}>Siguiendo…</p> : <Button onClick={onDone}>Volver</Button>}
        </>
      ) : null}

      {step.kind === 'outcome' && step.outcome.status === 'DECLINED' ? (
        <>
          <p style={{ ...big, color: 'var(--np-danger)' }}>Denegada</p>
          <p style={muted}>{step.outcome.message}</p>
          <Button onClick={() => void begin()}>Probar otra tarjeta</Button>
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'outcome' && step.outcome.status === 'PENDING' ? (
        <>
          {/* Cobrado en el lector: lo confirma el encargado con Paytef. Sin reintentar ni anular. */}
          <p role="status" style={{ ...big, color: 'var(--np-warning)' }}>
            {PENDING_CONFIRM_TEXT}
          </p>
          <p style={muted}>Operación {step.outcome.operationNumber}</p>
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'outcome' && (step.outcome.status === 'DUPLICATE' || step.outcome.status === 'MISMATCH') ? (
        <>
          <p style={{ ...big, color: 'var(--np-warning)' }}>Hay que anular esta operación</p>
          <p style={muted}>{step.outcome.message}</p>
          {toVoid ? (
            <Button loading={busy} onClick={() => void voidOperation(toVoid)}>
              Anular en el datáfono
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'notAccepted' ? (
        <>
          {/* El cliente ya pagó: nada de «Volver a intentar». Anular o avisar (queda en la lista). */}
          <p role="alert" style={{ ...big, color: 'var(--np-warning)' }}>
            {NOT_ACCEPTED_TEXT}
          </p>
          <p style={muted}>{step.message}</p>
          {step.operationNumber ? <p style={muted}>Operación {step.operationNumber}</p> : null}
          {toVoid ? (
            <Button loading={busy} onClick={() => void voidOperation(toVoid)}>
              Anular en el datáfono
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'readerError' ? (
        <>
          <p style={{ ...big, color: 'var(--np-warning)' }}>{step.message}</p>
          {step.canRecover ? (
            <>
              <p style={muted}>Si el cliente ya pasó la tarjeta, recupera el resultado antes de volver a cobrar.</p>
              <Button loading={busy} onClick={() => void recover(true)}>
                Recuperar el resultado
              </Button>
              {/* Solo tras preguntar al lector, y diciendo que se ha mirado: si se cobró, sería cobrarle dos veces. */}
              {recoverAnswered ? (
                <Button variant="ghost" disabled={busy} onClick={() => void begin()}>
                  He mirado el datáfono y no se cobró: cobrar otra vez
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant="ghost" onClick={() => void begin()}>
              Volver a intentar
            </Button>
          )}
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'unsent' ? (
        <>
          <p style={{ ...big, color: 'var(--np-warning)' }}>Cobrado en el datáfono, falta que llegue a OxioPay</p>
          <p style={muted}>
            {step.message} {UNSENT_NOTE}
          </p>
          <Button onClick={() => void deliver(step.result, { tries: step.tries + 1 })}>Reenviar ahora</Button>
          <Button variant="ghost" onClick={onDone}>
            Volver
          </Button>
        </>
      ) : null}

      {step.kind === 'voided' ? (
        <>
          <p style={big}>{step.message}</p>
          <Button onClick={onDone}>Volver</Button>
        </>
      ) : null}
    </Card>
  );
}

/** Un mensaje como frase (con su punto, sin duplicarlo). */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-16)' };
const big: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 700 };
