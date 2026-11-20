'use client';

import { useId, type CSSProperties } from 'react';
import type { SavedPayout } from '@/lib/payout-address';
import { holderWarning, type PayoutPath } from './onboarding-path';
import type { PayoutValues } from './onboarding-payout';
import { PayoutSection } from './PayoutSection';

const PATHS: Readonly<Record<PayoutPath, { title: string; text: string }>> = {
  IBAN: { title: 'Mi cuenta del banco (IBAN)', text: 'Una cuenta a tu nombre, de un banco de España o de otro país SEPA.' },
  OXIOCARD: { title: 'OxioCard', text: 'Una tarjeta a tu nombre para cobrar aunque no tengas cuenta de banco.' },
  BASICA: { title: 'No tengo cuenta: quiero abrir una', text: 'Una cuenta de pago básica: te explicamos cómo pedirla en un banco.' },
  OTRA: { title: 'Otra forma', text: 'Cripto, Revolut, Pix, efectivo…' },
  NADA: { title: 'Aún no lo sé', text: 'Lo hablas con el dueño del local.' },
};

interface Props {
  paths: PayoutPath[];
  path: PayoutPath;
  onPath: (path: PayoutPath) => void;
  payout: PayoutValues;
  onPayout: (values: PayoutValues) => void;
  saved: SavedPayout;
  showErrors: boolean;
  disabled: boolean;
  /** El nombre legal que acaba de escribir: si el titular no coincide, se le avisa. */
  legalName: string;
  /** false: su cuenta la pone el dueño (enlace de un encargado, o ya tiene una). */
  canSetPayout: boolean;
}

/**
 * «¿Cómo quieres cobrar?» en el alta: su IBAN (a su nombre), la OxioCard,
 * abrir una cuenta de pago básica (la guía, /cuenta-basica) u otra forma.
 */
export function PayoutPathSection({ paths, path, onPath, payout, onPayout, saved, showErrors, disabled, legalName, canSetPayout }: Props) {
  const group = useId();
  const withAccount = path === 'IBAN' || path === 'OTRA';
  const warning = withAccount ? holderWarning(legalName, payout.accountHolder) : null;

  return (
    <section>
      <h2 id={`${group}-t`} style={sectionHead}>
        ¿Cómo quieres cobrar?
      </h2>
      {canSetPayout ? null : <p style={hintStyle}>Tu cuenta de cobro la pone el dueño del local: si quieres cambiarla, díselo.</p>}
      <div role="radiogroup" aria-labelledby={`${group}-t`} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
        {paths.map((p) => (
          <label key={p} style={optionStyle(p === path, disabled)}>
            <input
              type="radio"
              name={group}
              value={p}
              checked={p === path}
              onChange={() => onPath(p)}
              disabled={disabled}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              <span style={optionTitle}>{PATHS[p].title}</span>
              <span style={optionText}>{PATHS[p].text}</span>
            </span>
          </label>
        ))}
      </div>

      {withAccount ? (
        <PayoutSection
          values={payout}
          onChange={onPayout}
          saved={saved}
          showErrors={showErrors}
          disabled={disabled}
          methodLocked={path === 'IBAN'}
        />
      ) : null}
      {warning ? (
        <p role="status" style={{ ...hintStyle, color: 'var(--np-warning)' }}>
          {warning}
        </p>
      ) : null}
      {path === 'OXIOCARD' ? (
        <p style={hintStyle}>Al guardar la pedimos. En la app, en «Ganancias», verás cómo va. Ahora no tienes que mandar nada.</p>
      ) : null}
      {path === 'BASICA' ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ ...hintStyle, marginTop: 0 }}>
            Si vives en España legalmente o has pedido asilo, un banco tiene que abrírtela, y cuesta como mucho 3 € al mes.
            Cuando la tengas, pásale tu IBAN al dueño.
          </p>
          <a
            href="/cuenta-basica"
            target="_blank"
            rel="noopener noreferrer"
            className="np-btn"
            data-variant="ghost"
            data-size="md"
            style={{ marginTop: '0.5rem' }}
          >
            Cómo pedirla, paso a paso
          </a>
        </div>
      ) : null}
    </section>
  );
}

function optionStyle(checked: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-start',
    padding: '0.7rem 0.875rem',
    minHeight: '2.75rem',
    borderRadius: 'var(--np-r-md)',
    background: 'var(--np-surface-2)',
    border: `1px solid ${checked ? 'var(--np-border-hi)' : 'var(--np-border)'}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  };
}

const optionTitle: CSSProperties = { display: 'block', fontSize: 'var(--np-fs-14)', fontWeight: 500, color: 'var(--np-text)' };

const optionText: CSSProperties = { display: 'block', marginTop: '0.15rem', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };

const sectionHead: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const hintStyle: CSSProperties = {
  margin: '0.4rem 0 0',
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-dim)',
};
