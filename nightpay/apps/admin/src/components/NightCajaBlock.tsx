'use client';

import { Icon } from '@nightpay/ui';
import type { NightCaja } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { cajaInText, cajaOutText, diffLabel, partnerCashBlock } from '@/lib/night-close';
import { useVenueTimezone } from '@/lib/venue-context';

/**
 * Bloque «Caja» de un Z congelado: fondo, lo que entró (recargas del saldo en
 * efectivo) y salió en efectivo, lo que debería haber, lo contado y la
 * diferencia, con el candado y la hora a la que se congeló. Ya no cambia.
 * Con cajeros de otras plataformas, «Fuera de este cajón»: su efectivo, que
 * se cuenta aparte (no entra en lo que debería haber).
 */
export function NightCajaBlock({ caja }: { caja: NightCaja }) {
  const tz = useVenueTimezone();
  const counted = caja.countedCents !== null;
  const diff = caja.diffCents ?? 0;
  const tone = !counted ? 'none' : diff < 0 ? 'short' : diff > 0 ? 'over' : 'ok';
  const partners = partnerCashBlock(caja.partnerCash);
  return (
    <section className="np-caja" aria-label="Caja de la noche">
      <header className="np-caja-head">
        <Icon name="lock" size={20} />
        <span className="np-caja-kicker">Caja</span>
        <span className="np-caja-time">Congelada a las {formatDateTime(caja.frozenAt, tz, 'time')}</span>
      </header>
      <dl className="np-caja-grid">
        <div>
          <dt>Fondo</dt>
          <dd>{caja.openingFloatCents === null ? '—' : formatEur(caja.openingFloatCents)}</dd>
        </div>
        {caja.cashInCents > 0 ? (
          <div>
            <dt>Entró en efectivo</dt>
            <dd>+{formatEur(caja.cashInCents)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Salió en efectivo</dt>
          <dd>{caja.cashOutCents > 0 ? formatEur(-caja.cashOutCents) : formatEur(0)}</dd>
        </div>
        <div>
          <dt>Debería haber</dt>
          <dd>{formatEur(caja.expectedCents)}</dd>
        </div>
        {caja.firstCountedCents !== undefined ? (
          <div>
            <dt>Primer recuento</dt>
            <dd>{formatEur(caja.firstCountedCents)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{caja.firstCountedCents !== undefined ? 'Contado al volver a contar' : 'Contado'}</dt>
          <dd>{counted ? formatEur(caja.countedCents ?? 0) : 'Sin contar'}</dd>
        </div>
        <div className="np-caja-diff" data-tone={tone}>
          <dt>Diferencia</dt>
          <dd>{counted ? (diff === 0 ? 'Cuadra' : formatEur(diff)) : '—'}</dd>
        </div>
      </dl>
      <p className="np-caja-note">
        {caja.cashInCents > 0 ? `${cajaInText(caja)} ` : ''}
        {caja.cashOutCents > 0
          ? cajaOutText(caja)
          : caja.cashInCents > 0
            ? 'No salió efectivo por OxioPay.'
            : 'No entró ni salió efectivo por OxioPay.'}
        {counted && diff !== 0 ? ` ${diffLabel(diff)}.` : ''}
        {counted ? '' : ' Nadie contó la caja (cierre automático o sin efectivo).'}
      </p>
      {caja.note ? <p className="np-caja-quote">«{caja.note}»</p> : null}
      {partners ? (
        <div className="np-caja-partner" aria-label={partners.title}>
          <p className="np-caja-partner-title">{partners.title}</p>
          <ul className="np-cash-moves">
            {partners.lines.map((l) => (
              <li key={l.key}>
                <span>{l.label}</span>
                <span className="np-num">{l.amount}</span>
              </li>
            ))}
          </ul>
          <p className="np-caja-note">{partners.note}</p>
        </div>
      ) : null}
    </section>
  );
}
