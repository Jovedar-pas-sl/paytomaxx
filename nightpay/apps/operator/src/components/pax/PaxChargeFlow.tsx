'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { callReader, type BridgeResponse } from '@/lib/pax-bridge';
import {
  clearPendingResult,
  isFinalRejection,
  reportPaxResult,
  reportPaxVoid,
  savePendingResult,
  startPaxCharge,
  type PaxCharge,
  type SaleOutcome,
} from '@/lib/pax-api';

type Step =
  | { kind: 'reading' }
  | { kind: 'sending' }
  | { kind: 'outcome'; outcome: SaleOutcome }
  | { kind: 'readerError'; message: string; canRecover: boolean }
  | { kind: 'voided'; message: string };

/** Vuelta automática a la lista tras un cobro pagado. */
const BACK_AFTER_PAID_MS = 4000;

/** Errores del lector tras los que el cliente pudo haber pagado igualmente. */
const MAYBE_CHARGED = new Set(['timeout', 'serviceIsDown', 'httpError', 'deviceError']);

/**
 * Un cobro en el lector: importe al datáfono, el cliente acerca la tarjeta,
 * el resultado va a NightPay. Si el dinero se cobró pero el cobro no lo
 * admitía (doble cobro, importe distinto), ofrece anular la operación.
 */
export function PaxChargeFlow({ charge, onDone }: { charge: PaxCharge; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  const reference = useRef<string | null>(null);
  const started = useRef(false);

  async function handleReader(r: BridgeResponse, autoRecover = true): Promise<void> {
    if (!r.ok || !r.result) {
      // Si pudo cobrarse (corte, lector sin respuesta), se pregunta al lector
      // por la última operación antes de dar nada por perdido.
      if (autoRecover && !r.ok && MAYBE_CHARGED.has(r.error)) {
        await recover(false);
        return;
      }
      const message = r.ok ? 'El lector no devolvió resultado.' : (r.message ?? readerErrorText(r.error));
      setStep({ kind: 'readerError', message, canRecover: !r.ok && r.error !== 'cancelled' });
      return;
    }
    setStep({ kind: 'sending' });
    // Se guarda antes de enviar: si la red falla, la pantalla lo reenvía sola.
    if (r.result.approved) savePendingResult(charge.id, r.result);
    try {
      const outcome = await reportPaxResult(charge.id, r.result);
      clearPendingResult();
      setStep({ kind: 'outcome', outcome });
    } catch (err) {
      const final = isFinalRejection(err);
      if (final) clearPendingResult();
      const retryNote = r.result.approved && !final ? ' El cobro está aprobado: se volverá a enviar solo.' : '';
      setStep({ kind: 'readerError', message: `${(err as Error).message}.${retryNote}`, canRecover: false });
    }
  }

  async function begin() {
    setStep({ kind: 'reading' });
    try {
      const s = await startPaxCharge(charge.id);
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

  useEffect(() => {
    if (step.kind === 'outcome' && step.outcome.status === 'PAID') {
      const t = setTimeout(onDone, BACK_AFTER_PAID_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [step, onDone]);

  async function recover(manual = true) {
    setBusy(true);
    const r = await callReader('lastResult');
    setBusy(false);
    if (r.ok && r.result && r.result.transactionReference !== reference.current) {
      setStep({
        kind: 'readerError',
        message: 'La última operación del datáfono es de otro cobro: este no se cobró.',
        canRecover: false,
      });
      return;
    }
    await handleReader(r, false);
    if (!manual && !r.ok) {
      setStep({
        kind: 'readerError',
        message: 'No sabemos si se cobró. Mira el datáfono antes de volver a cobrar.',
        canRecover: true,
      });
    }
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
        {charge.createdByName} · código {charge.code}
      </p>
      <p className="np-num" style={{ margin: 0, fontSize: '3rem', fontWeight: 700 }}>
        {eur(charge.amountCents)}
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
          <Button onClick={onDone}>Volver</Button>
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
            </>
          ) : null}
          <Button variant="ghost" onClick={() => void begin()}>
            Volver a intentar
          </Button>
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

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
