'use client';

import type { CSSProperties } from 'react';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { formatEur } from '@/lib/money';
import { pinExpected, pinWarning } from '@/lib/cobro-view';
import { chargeable, itemLabel, cuentaTotals, lineCents, lineSection, type Cuenta, type CuentaLine } from '@/lib/cuenta';
import { colorOf, labelOf, type CobrarContext } from './cobrar-context';
import { IconLock, IconMinus, IconPlus } from './icons';
import { Chip, ScreenHeader, Stripe } from './ScreenHeader';
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
 * «La cuenta» (maqueta 1.4): cada línea a su sección, con sus pasos; la
 * franja de arriba se parte con los colores de la cuenta y «Cómo se reparte»
 * lo enseña. Si pasa del tope sin PIN, el aviso sale antes.
 */
export function LaCuenta({ ctx, cuenta, who, onQty, onRemove, onAdd, onBack, onCobrar, onPos, busy, error, nfc }: Props) {
  const totals = cuentaTotals(cuenta);
  const parts = totals.bySection;
  const label = (s: string) => labelOf(ctx, s);
  const chip =
    parts.length > 1 ? (
      <Chip colors={parts.slice(0, 2).map((p) => colorOf(p.section))}>{`${parts.length} secciones`}</Chip>
    ) : parts[0] ? (
      <Chip colors={[colorOf(parts[0].section)]}>{label(parts[0].section)}</Chip>
    ) : null;
  const canCharge = chargeable(cuenta) && !busy;

  return (
    <div className={styles.screen}>
      <ScreenHeader title="La cuenta" subtitle={who} onBack={onBack} chip={chip} />
      <Stripe parts={parts.length > 0 ? parts.map((p) => ({ color: colorOf(p.section), weight: p.cents })) : [{ color: 'var(--np-border)', weight: 1 }]} />
      <div className={styles.body}>
        <div className={styles.lines}>
          {cuenta.map((line) => (
            <Line key={line.key} line={line} label={label} onQty={onQty} onRemove={onRemove} />
          ))}
        </div>
        <button type="button" className={styles.addRow} onClick={onAdd}>
          <IconPlus />
          Añadir algo de la carta
        </button>
        {parts.length > 0 ? (
          <div className={styles.panel}>
            <span className={styles.label}>Cómo se reparte</span>
            <div className={styles.sbar} aria-hidden="true">
              {parts.map((p) => (
                <i key={p.section} style={{ '--c': colorOf(p.section), flex: p.cents } as CSSProperties} />
              ))}
            </div>
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
        <div className={styles.total}>
          <span>Total</span>
          <b>{formatEur(totals.totalCents, { compact: true })}</b>
        </div>
      </div>
      <div className={styles.foot} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!canCharge} onClick={onCobrar}>
          {busy ? 'Un momento…' : `Cobrar ${formatEur(totals.totalCents, { compact: true })}`}
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
            className={`${styles.stepBtn} ${styles.stepAdd}`}
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
