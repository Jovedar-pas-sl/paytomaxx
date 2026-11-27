'use client';

import { useId, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, FormError, Input, Modal, Select } from '@nightpay/ui';
import { confirmPayoutManual, verifyPayout, type OperatorPayout, type PayoutMethod } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { isAutoVerifiable } from '@/lib/payout-address';
import {
  RECONCILIATION_LABELS,
  describeVerifyResult,
  payoutReferenceError,
  type VerifyOutcome,
} from '@/lib/payout-verify';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { PayoutMethodOptions } from './PayoutMethodForm';

interface Props {
  payout: OperatorPayout;
  /** Método guardado de la chica (por si la liquidación no lo tiene). */
  operatorMethod: PayoutMethod | null;
  onClose: () => void;
  /** Algo cambió (verificado, confirmado o referencia apuntada): refrescar la lista. */
  onChanged: () => void;
}

/**
 * Verificar una liquidación ya hecha: cripto contra la red (con el hash) y el
 * resto confirmando a mano con una prueba (referencia, recibo o nota).
 */
export function PayoutVerifyModal({ payout, operatorMethod, onClose, onChanged }: Props) {
  const tz = useVenueTimezone();
  const [rail, setRail] = useState<PayoutMethod | ''>(payout.externalRail ?? operatorMethod ?? '');
  const [externalTxId, setExternalTxId] = useState(payout.externalTxId ?? '');
  const [receiptUrl, setReceiptUrl] = useState(payout.receiptUrl ?? '');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const railId = useId();

  const chosenRail = rail === '' ? null : rail;
  const auto = isAutoVerifiable(chosenRail);
  const status = payout.reconciliationStatus ?? 'UNRECONCILED';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!chosenRail) return setError('Elige por dónde se pagó.');
    const txId = externalTxId.trim();
    const receipt = receiptUrl.trim();
    const problem = payoutReferenceError({ externalTxId: txId, receiptUrl: receipt });
    if (problem) return setError(problem);
    if (auto && !txId) return setError('Pon el hash de la transacción para verificarla en la red.');
    if (!auto && !txId && !receipt && !notes.trim()) {
      return setError('Pon una prueba del pago: referencia, enlace al recibo o una nota.');
    }

    setSubmitting(true);
    try {
      if (auto) {
        const result = await verifyPayout(payout.id, {
          externalTxId: txId,
          externalRail: chosenRail,
          receiptUrl: receipt || undefined,
        });
        setOutcome(describeVerifyResult(result));
      } else {
        await confirmPayoutManual(payout.id, {
          ...(txId ? { externalTxId: txId } : {}),
          ...(receipt ? { receiptUrl: receipt } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        setOutcome({ tone: 'success', message: 'Pago confirmado a mano.' });
      }
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const done = outcome?.tone === 'success';

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Verificar liquidación" width="32rem">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={metaStyle}>
          <strong className="np-num" style={{ color: 'var(--np-text)' }}>
            {formatEur(payout.totalCents)}
          </strong>{' '}
          · {formatDateTime(payout.createdAt, tz, 'datetime')} · {RECONCILIATION_LABELS[status].label}
        </p>

        {outcome ? <Notice tone={outcome.tone}>{outcome.message}</Notice> : null}

        {done ? (
          <Button onClick={onClose}>Cerrar</Button>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label htmlFor={railId} style={fieldLabel}>
                Pagado por
              </label>
              <Select id={railId} value={rail} onChange={(e) => setRail(e.target.value as PayoutMethod | '')} required>
                <option value="">— Elige el método —</option>
                <PayoutMethodOptions />
              </Select>
            </div>
            <Input
              label={auto ? 'Hash de la transacción on-chain' : 'Referencia (opcional si hay recibo o nota)'}
              value={externalTxId}
              onChange={(e) => setExternalTxId(e.target.value)}
              placeholder={auto ? '0x... o TxId Tron' : 'Receipt ID, número SEPA, etc.'}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              required={auto}
            />
            <Input
              label="Receipt URL (opcional)"
              value={receiptUrl}
              onChange={(e) => setReceiptUrl(e.target.value)}
              placeholder="https://..."
              inputMode="url"
              maxLength={500}
            />
            {auto ? null : (
              <Input
                label="Nota (opcional)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder='"Pagado en mano el 14/10", etc.'
                maxLength={500}
              />
            )}
            {error ? (
              <FormError>
                {error}
              </FormError>
            ) : null}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Button variant="ghost" type="button" onClick={onClose} disabled={submitting} style={{ flex: 1 }}>
                {outcome ? 'Cerrar' : 'Cancelar'}
              </Button>
              <Button type="submit" loading={submitting} style={{ flex: 1 }}>
                {auto ? (outcome ? 'Volver a verificar' : 'Verificar en la red') : 'Confirmar a mano'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

const metaStyle: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' };

const fieldLabel: CSSProperties = {
  display: 'block',
  marginBottom: '0.4rem',
  fontSize: '0.875rem',
  fontWeight: 400,
  color: 'var(--np-text-mute)',
};
