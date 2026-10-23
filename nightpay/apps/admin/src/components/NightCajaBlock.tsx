'use client';

import type { NightCaja } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { cajaInText, cajaOutText, diffLabel } from '@/lib/night-close';
import { useVenueTimezone } from '@/lib/venue-context';

/**
 * Bloque «Caja» de un Z congelado: fondo, lo que entró (recargas del saldo en
 * efectivo) y salió en efectivo, lo que debería haber, lo contado y la
 * diferencia, con el candado y la hora a la que se congeló. Ya no cambia.
 */
export function NightCajaBlock({ caja }: { caja: NightCaja }) {
  const tz = useVenueTimezone();
  const counted = caja.countedCents !== null;
  const diff = caja.diffCents ?? 0;
  const tone = !counted ? 'none' : diff < 0 ? 'short' : diff > 0 ? 'over' : 'ok';
  return (
    <section className="np-caja" aria-label="Caja de la noche">
      <header className="np-caja-head">
        <LockIcon />
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
        <div>
          <dt>Contado</dt>
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
    </section>
  );
}

function LockIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
