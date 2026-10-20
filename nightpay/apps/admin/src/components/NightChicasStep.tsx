'use client';

import { Button } from '@nightpay/ui';
import type { NightChicaPay } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';

interface Props {
  chicas: ReadonlyArray<NightChicaPay>;
  holdDays: number;
  onPay: (chica: NightChicaPay) => void;
  disabled?: boolean;
}

/**
 * Paso «Pagar al personal» (chicas y camareros): a cada uno, lo que se le paga ahora (con los
 * días de espera del local), lo ya pagado esta noche y su deuda. «Pagar»
 * abre el mismo modal de siempre (con 2FA): paga o lo pide al dueño.
 */
export function NightChicasStep({ chicas, holdDays, onPay, disabled }: Props) {
  if (chicas.length === 0) return null;
  return (
    <ul className="np-chicas">
      {chicas.map((c) => (
        <li key={c.operatorId} className="np-chica" data-due={c.toPayCents > 0 ? 'true' : 'false'}>
          <div className="np-chica-who">
            <span className="np-chica-name">{c.name}</span>
            <span className="np-chica-meta">{metaLine(c, holdDays)}</span>
          </div>
          <div className="np-chica-pay">
            {c.toPayCents > 0 ? (
              <>
                <span className="np-chica-amount">
                  Págale <strong className="np-num">{formatEur(c.toPayCents)}</strong>
                </span>
                <Button className="np-chica-btn" onClick={() => onPay(c)} disabled={disabled}>
                  Pagar
                </Button>
              </>
            ) : (
              <span className="np-chica-done">{c.paidTonightCents > 0 ? 'Pagado' : 'Nada que pagar ya'}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function metaLine(c: NightChicaPay, holdDays: number): string {
  const parts = [`esta noche ${formatEur(c.earnedTonightCents)}`];
  if (c.paidTonightCents > 0) {
    parts.push(`pagado ${formatEur(c.paidTonightCents)}${c.paidTonightCount > 1 ? ` (${c.paidTonightCount} pagos)` : ''}`);
  }
  if (c.heldCents > 0 && holdDays > 0) parts.push(`${formatEur(c.heldCents)} en espera (${holdDays} días)`);
  if (c.debtCents > 0) parts.push(`debe ${formatEur(c.debtCents)} por devoluciones`);
  return parts.join(' · ');
}
