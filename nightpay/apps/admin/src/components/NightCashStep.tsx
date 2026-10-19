'use client';

import { useId, useState } from 'react';
import type { NightCash } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import { cashOutcome, diffLabel, parseCashInput, type CashDraft } from '@/lib/night-close';

interface Props {
  cash: NightCash;
  draft: CashDraft;
  onDraft: (next: CashDraft) => void;
  cashNote: string;
  onCashNote: (note: string) => void;
  /** La diferencia está confirmada (aviso del paso «Efectivo»). */
  acked: boolean;
  onAck: (on: boolean) => void;
  disabled?: boolean;
}

/**
 * Paso «Efectivo»: el arqueo. Lo que debería haber (fondo − lo que salió en
 * efectivo por OxioPay), lo contado en grande y la diferencia resaltada si
 * no cuadra. OxioPay no cobra en efectivo: la caja, por el sistema, solo baja.
 */
export function NightCashStep({ cash, draft, onDraft, cashNote, onCashNote, acked, onAck, disabled }: Props) {
  const countedId = useId();
  const floatId = useId();
  const noteId = useId();
  const ackId = useId();
  const [editFloat, setEditFloat] = useState(false);
  const outcome = cashOutcome(cash, draft);
  const counted = parseCashInput(draft.countedText);
  const float = parseCashInput(draft.floatText);
  const askFloat = cash.openingFloatCents === null || editFloat;
  const diff = outcome.diffCents;
  const tone = diff === null ? 'none' : diff < 0 ? 'short' : diff > 0 ? 'over' : 'ok';

  return (
    <div className="np-cash">
      <p className="np-cash-why">
        Por OxioPay la caja sube con las recargas del saldo en efectivo (recepción) y baja con el saldo devuelto en
        efectivo y los pagos en efectivo a las chicas. Lo que se cobre en efectivo fuera de OxioPay (barra, entradas)
        no está aquí: si lo guardas en esta caja, sale como «sobran».
      </p>

      <ul className="np-cash-moves">
        <li>
          <span>Fondo de caja</span>
          <span className="np-num">
            {cash.openingFloatCents === null ? 'sin apuntar' : formatEur(cash.openingFloatCents)}
            {cash.openingFloatCents !== null && !editFloat ? (
              <button type="button" className="np-close-link" onClick={() => setEditFloat(true)} disabled={disabled}>
                Corregir
              </button>
            ) : null}
          </span>
        </li>
        {(cash.walletCashTopUpsCount ?? 0) > 0 ? (
          <li>
            <span>Recargas del saldo en efectivo ({cash.walletCashTopUpsCount})</span>
            <span className="np-num">+{formatEur(cash.walletCashTopUpsCents)}</span>
          </li>
        ) : null}
        <li>
          <span>Saldo devuelto en efectivo ({cash.walletCashPayoutsCount})</span>
          <span className="np-num">{formatEur(-cash.walletCashPayoutsCents)}</span>
        </li>
        <li>
          <span>Pagos a las chicas en efectivo ({cash.chicaCashPayoutsCount})</span>
          <span className="np-num">{formatEur(-cash.chicaCashPayoutsCents)}</span>
        </li>
      </ul>

      {askFloat ? (
        <div className="np-cash-field">
          <label htmlFor={floatId} className="np-cash-label">
            ¿Con cuánto efectivo empezó la caja?
          </label>
          <input
            id={floatId}
            className="np-cash-input np-cash-input-sm"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,00"
            value={draft.floatText}
            onChange={(e) => onDraft({ ...draft, floatText: e.target.value })}
            disabled={disabled}
            aria-invalid={float === null}
          />
          {float === null ? <span className="np-cash-error">Escribe un importe, p. ej. 150 o 150,50.</span> : null}
        </div>
      ) : null}

      <div className="np-cash-field">
        <label htmlFor={countedId} className="np-cash-label">
          Efectivo contado en la caja{outcome.required ? '' : ' (opcional)'}
        </label>
        <input
          id={countedId}
          className="np-cash-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          value={draft.countedText}
          onChange={(e) => onDraft({ ...draft, countedText: e.target.value })}
          disabled={disabled}
          aria-invalid={counted === null}
          aria-describedby={`${countedId}-echo`}
        />
        <span id={`${countedId}-echo`} className={counted === null ? 'np-cash-error' : 'np-cash-echo'}>
          {counted === null
            ? 'Escribe un importe, p. ej. 1.234,50.'
            : counted === undefined
              ? 'En euros: 150 · 150,50 · 1.234,50'
              : `= ${formatEur(counted)}`}
        </span>
      </div>

      <dl className="np-cash-figures">
        <div>
          <dt>Debería haber</dt>
          <dd>{formatEur(outcome.expectedCents)}</dd>
        </div>
        <div>
          <dt>Contado</dt>
          <dd>{outcome.countedCents === null ? '—' : formatEur(outcome.countedCents)}</dd>
        </div>
        <div className="np-cash-diff" data-tone={tone}>
          <dt>Diferencia</dt>
          <dd>{diff === null ? '—' : diff === 0 ? 'Cuadra' : formatEur(diff)}</dd>
        </div>
      </dl>

      {diff !== null && diff !== 0 ? (
        <div className="np-cash-mismatch">
          <p className="np-cash-mismatch-title">{diffLabel(diff)}</p>
          <label htmlFor={noteId} className="np-cash-label">
            Explica la diferencia (queda en el Z)
          </label>
          <input
            id={noteId}
            className="np-close-text"
            value={cashNote}
            maxLength={300}
            placeholder="ej: cambio mal dado en barra"
            onChange={(e) => onCashNote(e.target.value)}
            disabled={disabled}
          />
          <label htmlFor={ackId} className="np-close-ack">
            <input
              id={ackId}
              type="checkbox"
              checked={acked}
              onChange={(e) => onAck(e.target.checked)}
              disabled={disabled}
            />
            <span>Confirmo lo contado: la diferencia queda congelada en el Z.</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
