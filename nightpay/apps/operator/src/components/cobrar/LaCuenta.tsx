'use client';

import type { CSSProperties } from 'react';
import { BusyWord, ScreenHelp } from '@nightpay/ui';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { TOURS } from '@/lib/tours';
import { formatEur } from '@/lib/money';
import { cobrarLabel } from '@/lib/carta-view';
import { pinExpected, pinWarning } from '@/lib/cobro-view';
import { chargeable, itemLabel, cuentaTotals, lineCents, lineSection, type Cuenta, type CuentaLine } from '@/lib/cuenta';
import { colorOf, labelOf, type CobrarContext } from './cobrar-context';
import { IconLock, IconMinus, IconPlus } from './icons';
import { Chip, ScreenHeader } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  cuenta: Cuenta;
  who: string;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onAdd: () => void;
  onBack: () => void;
  onCobrar: () => void;
  /** Con datáfono (solo si el local lo tiene). */
  onPos?: () => void;
  busy: boolean;
  error: string | null;
  /** El cliente podrá pagar con su NFC (para avisar del PIN). */
  nfc: boolean;
}

/**
 * «La cuenta» (maqueta 1.4), en Grafito: una lista sin tarjetas, cada línea
 * con el punto de su sección y un solo tipo de paso («−» y «+» iguales);
 * «Cómo se reparte», en una línea. Si pasa del tope sin PIN, el aviso sale antes.
 */
export function LaCuenta({ ctx, cuenta, who, onQty, onRemove, onAdd, onBack, onCobrar, onPos, busy, error, nfc }: Props) {
  const totals = cuentaTotals(cuenta);
  const parts = totals.bySection;
  const label = (s: string) => labelOf(ctx, s);
  // Con varias secciones, sin color: sus nombres van en las líneas y en «Cómo se reparte».
  const chip =
    parts.length > 1 ? (
      <Chip>{`${parts.length} secciones`}</Chip>
    ) : parts[0] ? (
      <Chip color={colorOf(parts[0].section)}>{label(parts[0].section)}</Chip>
    ) : null;
  const canCharge = chargeable(cuenta) && !busy;

  return (
    <div className={styles.screen}>
      <ScreenHeader title="La cuenta" subtitle={who} onBack={onBack} chip={chip} help={<ScreenHelp {...TOURS.cuenta} ready={!busy} />} />
      <div className={styles.body}>
        <div className={styles.lines} data-tour="cuenta-lineas">
          {cuenta.map((line) => (
            <Line key={line.key} line={line} label={label} onQty={onQty} onRemove={onRemove} />
          ))}
        </div>
        <button type="button" className={styles.addRow} onClick={onAdd} data-tour="cuenta-anadir">
          <IconPlus />
          Añadir algo de la carta
        </button>
        {parts.length > 0 ? (
          <div className={styles.split} data-tour="cuenta-reparto">
            <span className={styles.label}>Cómo se reparte</span>
            <div className={styles.sleg}>
              {parts.map((p) => (
                <span key={p.section} style={{ '--c': colorOf(p.section) } as CSSProperties}>
                  {label(p.section)} <b>{formatEur(p.cents, { compact: true })}</b>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {nfc && pinExpected(totals.totalCents, ctx.night) ? (
          <div className={styles.warnline}>
            <IconLock />
            {pinWarning(ctx.night)}
          </div>
        ) : null}
        <div className={styles.total} data-tour="cuenta-total">
          <span>Total</span>
          <b>{formatEur(totals.totalCents, { compact: true })}</b>
        </div>
      </div>
      <div className={styles.foot} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        <button
          type="button"
          className={`${styles.btn} ${styles.primary}`}
          disabled={!canCharge}
          aria-busy={busy || undefined}
          onClick={onCobrar}
          data-tour="cuenta-cobrar"
        >
          {busy ? <BusyWord word={cobrarLabel({ busy, empty: false, totalCents: 0 })} /> : cobrarLabel({ busy, empty: false, totalCents: totals.totalCents })}
        </button>
        {onPos ? (
          <button type="button" className={`${styles.btn} ${styles.ghost}`} disabled={!canCharge} onClick={onPos}>
            Con datáfono
          </button>
        ) : null}
        {cuenta.length > 0 && !chargeable(cuenta) ? (
          <p className={styles.error}>Una propina sola no se cobra: añade lo que se lleva.</p>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Line({
  line,
  label,
  onQty,
  onRemove,
}: {
  line: CuentaLine;
  label: (s: string) => string;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
}) {
  const section = lineSection(line);
  const color = { '--c': colorOf(section) } as CSSProperties;
  const name = line.kind === 'carta' ? itemLabel(line.item) : line.kind === 'propina' ? 'Propina' : 'Otro importe';
  const sub = line.kind === 'carta' && line.qty > 1 ? `${label(section)} · ${formatEur(line.item.priceCents, { compact: true })}` : label(section);
  const qty = line.kind === 'carta' ? line.qty : 1;
  const minus = () => (line.kind === 'carta' ? onQty(line.key, line.qty - 1) : onRemove(line.key));
  return (
    <div className={styles.line} style={color}>
      <i className={styles.sw} aria-hidden="true" />
      <div className={styles.lineText}>
        <b>{name}</b>
        <span>{sub}</span>
      </div>
      <div className={styles.stepper}>
        <button type="button" className={styles.stepBtn} onClick={minus} aria-label={`Una menos: ${name}`}>
          <IconMinus />
        </button>
        <span className={styles.stepValue}>{qty}</span>
        {line.kind === 'carta' ? (
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => onQty(line.key, line.qty + 1)}
            aria-label={`Una más: ${name}`}
          >
            <IconPlus />
          </button>
        ) : null}
      </div>
      <b className={styles.lineValue}>{formatEur(lineCents(line), { compact: true })}</b>
    </div>
  );
}
