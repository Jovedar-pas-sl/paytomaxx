'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { callReader, type BridgeResponse, type PaytefResult } from '@/lib/pax-bridge';
import {
  PENDING_CONFIRM_TEXT,
  clearPendingResult,
  hasPendingResults,
  isFinalRejection,
  isResultForReference,
  reportPaxResult,
  reportPaxVoid,
  savePendingResult,
  startPaxCharge,
  type PaxCharge,
  type SaleOutcome,
} from '@/lib/pax-api';
import { formatEur } from '@/lib/money';

type Step =
  | { kind: 'reading' }
  | { kind: 'sending' }
  | { kind: 'outcome'; outcome: SaleOutcome }
  | { kind: 'readerError'; message: string; canRecover: boolean }
  /** Aprobada en el lector pero sin llegar a OxioPay: se reenvía; nunca se vuelve a cobrar. */
  | { kind: 'unsent'; message: string; result: PaytefResult }
  | { kind: 'voided'; message: string };

/** Vuelta automática a la lista tras un cobro pagado. */
const BACK_AFTER_PAID_MS = 4000;

/** Errores del lector tras los que el cliente pudo haber pagado igualmente. */
const MAYBE_CHARGED = new Set(['timeout', 'serviceIsDown', 'httpError', 'deviceError']);

const PENDING_BLOCK_TEXT =
  'Hay un cobro aprobado que aún no ha llegado a OxioPay: espera a que se envíe antes de cobrar otro.';
const UNKNOWN_TEXT =
  'No sabemos si se cobró: la última operación del datáfono no es la de este cobro. Revísalo en el datáfono antes de volver a cobrar.';

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
 * admitía (doble cobro, importe distinto), ofrece anular la operación.
 */
export function PaxChargeFlow({ charge, onDone, start, onPaid }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  // «Recuperar el resultado» ya contestó: hasta entonces no se ofrece cobrar
  // otra vez (si la primera se aprobó, el cliente pagaría dos veces).
  const [recoverAnswered, setRecoverAnswered] = useState(false);
  const reference = useRef<string | null>(null);
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
      showReaderFailure(r);
      return;
    }
    await deliver(r.result);
  }

  function showReaderFailure(r: BridgeResponse): void {
    const message = r.ok ? 'El lector no devolvió resultado.' : (r.message ?? readerErrorText(r.error));
    setStep({ kind: 'readerError', message, canRecover: !r.ok && r.error !== 'cancelled' });
  }

  /** El resultado del lector a OxioPay. Si está aprobado, se guarda antes: si la red falla, se reenvía. */
  async function deliver(result: PaytefResult): Promise<void> {
    setStep({ kind: 'sending' });
    if (result.approved) savePendingResult(charge.id, result);
    try {
      const outcome = await reportPaxResult(charge.id, result);
      clearPendingResult(charge.id, result);
      setStep({ kind: 'outcome', outcome });
    } catch (err) {
      const final = isFinalRejection(err);
      if (final) clearPendingResult(charge.id, result);
      const message = sentence((err as Error).message);
      if (result.approved && !final) setStep({ kind: 'unsent', message, result });
      else setStep({ kind: 'readerError', message, canRecover: false });
    }
  }

  async function begin() {
    // Con una venta aprobada sin enviar, no se empieza otra: se cobraría dos veces.
    if (hasPendingResults()) {
      setStep({ kind: 'readerError', message: PENDING_BLOCK_TEXT, canRecover: false });
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

  async function recover(manual = true) {
    setBusy(true);
    const r = await callReader('lastResult');
    setBusy(false);
    if (manual) setRecoverAnswered(true);
    if (r.ok && r.result) {
      // Otra operación (o sin referencia): no se sabe si este se cobró. Nunca
      // "no se cobró": volver a cobrar podría cobrarle dos veces.
      if (isResultForReference(r.result, reference.current)) await deliver(r.result);
      else setStep({ kind: 'readerError', message: UNKNOWN_TEXT, canRecover: true });
      return;
    }
    if (!manual && !r.ok) {
      setStep({
        kind: 'readerError',
        message: 'No sabemos si se cobró. Mira el datáfono antes de volver a cobrar.',
        canRecover: true,
      });
      return;
    }
    showReaderFailure(r);
  }

  async function voidOperation(operationNumber: string) {
    setBusy(true);
    const r = await callReader('voidSale', {
      operationNumber,
      amountCents: charge.amountCents,
      reference: reference.current ?? '',
    });
    const approved = r.ok && Boolean(r.result?.approved);
    try {
      await reportPaxVoid(charge.id, {
        operationNumber,
        approved,
        ...(r.ok ? {} : { resultText: r.message ?? r.error }),
      });
    } catch {
      // queda en el datáfono; la incidencia sigue abierta en el panel
    }
    setBusy(false);
    setStep({
      kind: 'voided',
      message: approved
        ? 'Operación anulada en el datáfono: al cliente no se le cobra dos veces.'
        : 'No se pudo anular. Hazlo desde el menú del datáfono y avisa al encargado.',
    });
  }

  // Operación a anular cuando el dinero se cobró pero el cobro no lo admitía.
  const toVoid =
    step.kind === 'outcome' && (step.outcome.status === 'DUPLICATE' || step.outcome.status === 'MISMATCH')
      ? step.outcome.operationNumber
      : null;

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'center' }}>
      <p style={muted}>
        {charge.createdByName}
        {charge.code ? ` · código ${charge.code}` : null}
      </p>
      <p className="np-num" style={{ margin: 0, fontSize: '3rem', fontWeight: 700 }}>
        {formatEur(charge.amountCents)}
      </p>

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
          <p style={muted}>{step.message} Se vuelve a enviar solo: no lo cobres otra vez.</p>
          <Button onClick={() => void deliver(step.result)}>Reenviar ahora</Button>
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

function readerErrorText(error: string): string {
  switch (error) {
    case 'deviceIsBusy':
      return 'El datáfono está ocupado con otra operación.';
    case 'serviceIsDown':
      return 'El servicio de pago del datáfono no responde.';
    case 'cancelled':
      return 'Cobro cancelado.';
    case 'timeout':
      return 'El lector no responde.';
    default:
      return 'El lector dio un error.';
  }
}

const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
