'use client';

import { useState, type CSSProperties } from 'react';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { formatEur } from '@/lib/money';
import { PROPINAS, type CuentaSection } from '@/lib/cuenta';
import { IMPORTE_KEYS, importeCents, importeShown, pressImporte, type ImporteKey } from '@/lib/importe';
import { colorOf, labelOf, offeredCodes, puestoChip, puestoSection, tipTiles, type CobrarContext } from './cobrar-context';
import { IconDel } from './icons';
import { Chip, ScreenHeader } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  who: string;
  /** La cuenta ya lleva algo: el importe se añade (si no, se cobra ya). */
  adding: boolean;
  onDone: (section: CuentaSection, cents: number) => void;
  onBack: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * «Otro importe» (maqueta 1.3): teclado grande y la sección obligatoria, con
 * la de su puesto ya marcada. Solo salen sus secciones (y Propinas si las
 * lleva): sin sección no se cobra, así nada cae en «Otros».
 */
export function OtroImporte({ ctx, who, adding, onDone, onBack, busy, error }: Props) {
  const codes = offeredCodes(ctx);
  const options: CuentaSection[] = [...codes, ...(tipTiles(ctx).length > 0 || (ctx.tips && ctx.methods.tips) ? [PROPINAS] : [])];
  const mine = puestoSection(ctx);
  const [section, setSection] = useState<CuentaSection>(codes.includes(mine) ? mine : (options[0] ?? 'VENUE_BAR'));
  const [typed, setTyped] = useState('');
  const cents = importeCents(typed);
  const chip = puestoChip(ctx);
  const tipOnly = section === PROPINAS && !adding;

  function press(key: ImporteKey) {
    if ('vibrate' in navigator) navigator.vibrate(8);
    setTyped((t) => pressImporte(t, key));
  }

  const what = labelOf(ctx, section);
  const action = `${adding ? 'Añadir' : 'Cobrar'} ${cents > 0 ? `${formatEur(cents, { compact: true })} · ` : ''}${what}`;

  return (
    <div className={styles.screen}>
      <ScreenHeader
        title="Otro importe"
        subtitle={who}
        onBack={onBack}
        chip={chip ? <Chip color={chip.color}>{chip.label}</Chip> : null}
      />
      <div className={styles.body}>
        <div className={styles.amountShow} aria-live="polite">
          <span className={styles.num}>{importeShown(typed)}</span>
          <span className={styles.caret} aria-hidden="true" />
          <span className={styles.cur}>€</span>
        </div>
        <p className={styles.label} id="otro-seccion">
          ¿De qué es? · obligatorio
        </p>
        <div
          className={`${styles.secs}${options.length > 4 ? ` ${styles.secs3}` : ''}`}
          role="radiogroup"
          aria-labelledby="otro-seccion"
        >
          {options.map((s) => {
            const on = s === section;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                className={`${styles.sec}${on ? ` ${styles.secOn}` : ''}`}
                style={{ '--c': colorOf(s) } as CSSProperties}
                onClick={() => setSection(s)}
              >
                {labelOf(ctx, s)}
                {on && s === mine ? <small>tu puesto</small> : null}
              </button>
            );
          })}
        </div>
        <div className={styles.keys}>
          {IMPORTE_KEYS.map((k) => (
            <button key={k} type="button" className={styles.key} onClick={() => press(k)} aria-label={k === 'back' ? 'Borrar' : k === ',' ? 'Coma' : k}>
              {k === 'back' ? <IconDel /> : k}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.foot} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          disabled={cents <= 0 || busy || tipOnly}
          aria-busy={busy || undefined}
          onClick={() => onDone(section, cents)}
        >
          {busy ? 'Un momento…' : action}
        </button>
        {tipOnly ? <p className={styles.error}>Una propina sola no se cobra: añade lo que se lleva.</p> : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

