'use client';

import { useId, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { NightCash } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import { FLOAT_OWNER_ONLY_TEXT, cashOutcome, countReady, diffLabel, parseCashInput, partnerCashBlock, type CashDraft } from '@/lib/night-close';
import { OtpInput } from './OtpInput';

interface Props {
  cash: NightCash;
  draft: CashDraft;
  onDraft: (next: CashDraft) => void;
  cashNote: string;
  onCashNote: (note: string) => void;
  /** La diferencia está confirmada (aviso del paso «Efectivo»). */
  acked: boolean;
  onAck: (on: boolean) => void;
  /** Cierre a ciegas (B9): ya pulsó «Ver si cuadra» con lo contado escrito (desde ahí, lo contado queda fijo). */
  countDone: boolean;
  onCountDone: () => void;
  /** «Volver a contar»: el primer recuento se guarda y va al Z con el nuevo. */
  onRecount: () => void;
  /** El primer recuento, si ya se volvió a contar. */
  firstCountCents: number | null;
  disabled?: boolean;
  /** Cambiar el fondo apuntado al abrir: el dueño pone aquí su código 2FA. */
  isOwner: boolean;
  floatCode: string;
  onFloatCode: (code: string) => void;
  floatCodeLockedUntil: number | null;
}

/**
 * Paso «Efectivo»: el arqueo, a ciegas (B9). Primero el fondo y lo contado en
 * grande; con «Ver si cuadra», lo que entró y salió en efectivo por OxioPay,
 * lo que debería haber y la diferencia resaltada si no cuadra. Antes no sale
 * nada que deje calcular lo esperado: nadie (tampoco el dueño) cuadra a ojo.
 * Tras «Ver si cuadra», lo contado y el fondo quedan fijos; para corregirlo,
 * «Volver a contar», y el Z guarda el primer recuento y el nuevo.
 */
export function NightCashStep({
  cash,
  draft,
  onDraft,
  cashNote,
  onCashNote,
  acked,
  onAck,
  countDone,
  onCountDone,
  onRecount,
  firstCountCents,
  disabled,
  isOwner,
  floatCode,
  onFloatCode,
  floatCodeLockedUntil,
}: Props) {
  const countedId = useId();
  const floatId = useId();
  const noteId = useId();
  const ackId = useId();
  const [editFloat, setEditFloat] = useState(false);
  const outcome = cashOutcome(cash, draft);
  const counted = parseCashInput(draft.countedText);
  const float = parseCashInput(draft.floatText);
  const askFloat = cash.openingFloatCents === null || editFloat;
  // Tras «Ver si cuadra», lo contado y el fondo no se tocan: se vuelve a contar.
  const frozen = Boolean(disabled) || countDone;
  const diff = outcome.diffCents;
  const tone = diff === null ? 'none' : diff < 0 ? 'short' : diff > 0 ? 'over' : 'ok';
  const ready = countReady(draft);
  const showCount = () => {
    if (ready && !disabled) onCountDone();
  };

  return (
    <div className="np-cash">
      <p className="np-cash-why">
        Por OxioPay la caja sube con las recargas del saldo en efectivo (recepción) y baja con el saldo devuelto en
        efectivo y los pagos en efectivo a las compañeras. Lo que se cobre en efectivo fuera de OxioPay (barra, entradas)
        no está aquí: si lo guardas en esta caja, sale como «sobran».
      </p>

      <ul className="np-cash-moves">
        <li>
          <span>Fondo de caja</span>
          <span className="np-num">
            {cash.openingFloatCents === null ? 'sin apuntar' : formatEur(cash.openingFloatCents)}
            {cash.openingFloatCents !== null && !editFloat ? (
              <button type="button" className="np-close-link" onClick={() => setEditFloat(true)} disabled={frozen}>
                Corregir
              </button>
            ) : null}
          </span>
        </li>
        {countDone ? <CashMoves cash={cash} /> : null}
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
            disabled={frozen}
            aria-invalid={float === null}
          />
          {float === null ? <span className="np-cash-error">Escribe un importe, p. ej. 150 o 150,50.</span> : null}
        </div>
      ) : null}

      {outcome.floatChanged ? (
        isOwner ? (
          <OtpInput
            label="Tu código 2FA para cambiar el fondo apuntado al abrir"
            value={floatCode}
            onChange={onFloatCode}
            lockedUntil={floatCodeLockedUntil}
            hint="El Z guarda los dos fondos. Cada código vale una sola vez."
            disabled={disabled}
          />
        ) : (
          <p role="alert" className="np-cash-error">
            {FLOAT_OWNER_ONLY_TEXT}
          </p>
        )
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !countDone) showCount();
          }}
          disabled={frozen}
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

      {countDone ? (
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
      ) : (
        <div className="np-cash-blind">
          <Button onClick={showCount} disabled={!ready || disabled}>
            Ver si cuadra
          </Button>
          <p className="np-cash-blind-note">
            {firstCountCents !== null
              ? `Vuelves a contar: el primer recuento (${formatEur(firstCountCents)}) queda en el Z con el nuevo.`
              : 'Se cuenta a ciegas: lo que debería haber sale al pulsar «Ver si cuadra».'}
          </p>
        </div>
      )}

      {countDone ? (
        <div className="np-cash-recount">
          <Button variant="ghost" onClick={onRecount} disabled={disabled}>
            Volver a contar
          </Button>
          <p className="np-cash-blind-note">Lo contado ya no se cambia aquí: si te equivocaste, vuelve a contar. El Z guarda el primer recuento y el nuevo.</p>
        </div>
      ) : null}

      {countDone && diff !== null && diff !== 0 ? (
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
            <span>Confirmo lo contado: la diferencia queda fija en el Z.</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** Lo que entró y salió en efectivo por OxioPay: solo tras «Ver si cuadra» (deja calcular lo esperado). */
function CashMoves({ cash }: { cash: NightCash }) {
  // El efectivo de los cajeros de otras plataformas: aparte, no suma a lo que debería haber en este cajón.
  const partners = partnerCashBlock(cash.partnerCash);
  return (
    <>
      {(cash.walletCashTopUpsCount ?? 0) > 0 ? (
        <li>
          <span>Recargas del saldo en efectivo ({cash.walletCashTopUpsCount})</span>
          <span className="np-num">+{formatEur(cash.walletCashTopUpsCents)}</span>
        </li>
      ) : null}
      {cash.walletCashTopUpFeesCents ? (
        <li>
          <span>Comisión del servicio de esas recargas (se debe a OxioPay)</span>
          <span className="np-num">+{formatEur(cash.walletCashTopUpFeesCents)}</span>
        </li>
      ) : null}
      <li>
        <span>Saldo devuelto en efectivo ({cash.walletCashPayoutsCount})</span>
        <span className="np-num">{formatEur(-cash.walletCashPayoutsCents)}</span>
      </li>
      <li>
        <span>Pagos a las compañeras en efectivo ({cash.chicaCashPayoutsCount})</span>
        <span className="np-num">{formatEur(-cash.chicaCashPayoutsCents)}</span>
      </li>
      {(cash.camareroCashPayoutsCount ?? 0) > 0 ? (
        <li>
          <span>Pagos a los camareros en efectivo ({cash.camareroCashPayoutsCount})</span>
          <span className="np-num">{formatEur(-(cash.camareroCashPayoutsCents ?? 0))}</span>
        </li>
      ) : null}
      {(cash.bitcoinCashOutCount ?? 0) > 0 ? (
        <li>
          <span>Pagos con bitcoin devueltos en efectivo ({cash.bitcoinCashOutCount})</span>
          <span className="np-num">{formatEur(-(cash.bitcoinCashOutCents ?? 0))}</span>
        </li>
      ) : null}
      {partners ? (
        <>
          <li className="np-cash-partner-head">{partners.title}</li>
          {partners.lines.map((l) => (
            <li key={l.key} className="np-cash-partner">
              <span>{l.label}</span>
              <span className="np-num">{l.amount}</span>
            </li>
          ))}
          <li className="np-cash-partner-note">{partners.note}</li>
        </>
      ) : null}
    </>
  );
}
