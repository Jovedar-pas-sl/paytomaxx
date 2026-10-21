'use client';

import type { CSSProperties, ReactNode } from 'react';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { formatEur } from '@/lib/money';
import { chargeable, itemLabel, cuentaSummary, cuentaTotals, qtyOf, type CartaItem, type Cuenta } from '@/lib/cuenta';
import {
  colorOf,
  itemAllowed,
  labelOf,
  offeredCodes,
  puestoChip,
  puestoSection,
  tipTiles,
  type CobrarContext,
} from './cobrar-context';
import { Chip, ScreenHeader, Stripe } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  cuenta: Cuenta;
  /** «Carlos · camarero». */
  who: string;
  onItem: (item: CartaItem) => void;
  onTip: (cents: number) => void;
  onOtro: () => void;
  onVerCuenta: () => void;
  onCobrar: () => void;
  busy: boolean;
  error: string | null;
  onLogo: () => void;
  /** Un botón más en la cabecera (la chica: «Mi QR»). */
  headerExtra?: ReactNode;
  onRetryCarta: () => void;
}

/**
 * «Cobrar», variante A (maqueta 1.1): losetas de color por sección, solo las
 * que su puesto cobra. Tocar suma a la cuenta (×N); abajo, el resumen y
 * «Cobrar N €». La chica ve Servicios y Propinas, más grandes; la habitación
 * no es suya («La cobra recepción»).
 */
export function Carta({
  ctx,
  cuenta,
  who,
  onItem,
  onTip,
  onOtro,
  onVerCuenta,
  onCobrar,
  busy,
  error,
  onLogo,
  headerExtra,
  onRetryCarta,
}: Props) {
  const codes = offeredCodes(ctx);
  const inviteFirst = ctx.rules?.inviteFirst !== false;
  const items = ctx.carta
    .filter((i) => itemAllowed(i, codes) && !(i.isInvitation && inviteFirst))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => sectionOrder(codes, a.item.category) - sectionOrder(codes, b.item.category) || a.index - b.index)
    .map(({ item }) => item);
  const tips = tipTiles(ctx);
  const sectionsShown = new Set([...items.map((i) => i.category), ...(tips.length > 0 ? ['propinas'] : [])]);
  const big = sectionsShown.size <= 2;
  // La chica: la habitación, si el local la usa, la cobra recepción.
  const roomsElsewhere =
    ctx.user.role === 'OPERATOR' &&
    !codes.includes('VENUE_ROOM') &&
    (ctx.sections.find((s) => s.code === 'VENUE_ROOM')?.enabled ?? true);
  const chip = puestoChip(ctx);
  const totals = cuentaTotals(cuenta);
  const summary = cuentaSummary(cuenta, (s) => labelOf(ctx, s));
  const canCharge = chargeable(cuenta) && !busy;

  return (
    <div className={styles.screen}>
      <ScreenHeader
        title="Cobrar"
        subtitle={who}
        onLogo={onLogo}
        extra={headerExtra}
        chip={chip ? <Chip colors={[chip.color]}>{chip.label}</Chip> : null}
      />
      <Stripe parts={[{ color: colorOf(puestoSection(ctx)), weight: 1 }]} />
      <div className={styles.body}>
        <div className={styles.tiles}>
          {items.map((item) => (
            <ItemTile key={item.id} item={item} ctx={ctx} qty={qtyOf(cuenta, item.id)} big={big} onPick={() => onItem(item)} />
          ))}
          {tips.map((cents) => (
            <button
              key={`tip-${cents}`}
              type="button"
              className={`${styles.tile}${big ? ` ${styles.tileBig}` : ''}`}
              style={{ '--c': colorOf('propinas') } as CSSProperties}
              onClick={() => onTip(cents)}
            >
              <span className={styles.kicker}>Propinas</span>
              <span className={styles.tileName}>Propina</span>
              <span className={styles.price}>{formatEur(cents, { compact: true })}</span>
            </button>
          ))}
          <button type="button" className={`${styles.tile} ${styles.tileOther}${big ? ` ${styles.tileBig}` : ''}`} onClick={onOtro}>
            <span className={styles.tileName}>Otro importe</span>
            <span>{codes.length > 1 ? 'Teclearlo y elegir sección' : 'Teclearlo'}</span>
          </button>
          {roomsElsewhere ? (
            <div
              className={`${styles.tile} ${styles.tileAsk}${big ? ` ${styles.tileBig}` : ''}`}
              style={{ '--c': colorOf('VENUE_ROOM') } as CSSProperties}
            >
              <span className={styles.tileName}>{singular(labelOf(ctx, 'VENUE_ROOM'))}</span>
              <span>La cobra recepción</span>
            </div>
          ) : null}
        </div>
        {ctx.cartaFailed ? (
          <p role="status" className={styles.empty}>
            No se pudo cargar la carta: usa «Otro importe» o{' '}
            <button type="button" className={styles.link} onClick={onRetryCarta}>
              reintentar
            </button>
            .
          </p>
        ) : ctx.cartaLoaded && items.length === 0 ? (
          <p className={styles.empty}>No hay productos disponibles para tu puesto. El dueño o encargado debe configurar la carta en Administración → Carta y comprobar las secciones del puesto.{' '}
            <button type="button" className={styles.link} onClick={onRetryCarta}>Actualizar carta</button>
          </p>
        ) : null}
      </div>
      <div className={styles.foot} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        <div className={styles.sum}>
          {cuenta.length > 0 ? (
            <>
              <span className={styles.mbar} aria-hidden="true">
                {totals.bySection.map((s) => (
                  <i key={s.section} style={{ '--c': colorOf(s.section), flex: s.cents } as CSSProperties} />
                ))}
              </span>
              <span className={styles.grow}>{summary}</span>
              <button type="button" className={styles.link} onClick={onVerCuenta}>
                Ver cuenta
              </button>
            </>
          ) : (
            <span className={styles.grow} style={{ color: 'var(--np-text-label)' }}>
              Toca lo que te pide el cliente
            </span>
          )}
        </div>
        <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={!canCharge} onClick={onCobrar}>
          {busy ? 'Un momento…' : totals.totalCents > 0 ? `Cobrar ${formatEur(totals.totalCents, { compact: true })}` : 'Cobrar'}
        </button>
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

function sectionOrder(codes: readonly string[], code: string): number {
  const i = codes.indexOf(code);
  return i < 0 ? codes.length : i;
}

/** «Habitaciones» → «Habitación» (la loseta habla de una). */
function singular(label: string): string {
  if (/ones$/i.test(label)) return `${label.slice(0, -4)}ón`;
  return label.replace(/s$/i, '');
}

function ItemTile({
  item,
  ctx,
  qty,
  big,
  onPick,
}: {
  item: CartaItem;
  ctx: CobrarContext;
  qty: number;
  big: boolean;
  onPick: () => void;
}) {
  const parts = item.components && item.components.length > 1 ? item.components : null;
  const second = parts?.find((p) => p.category !== item.category)?.category;
  const style = { '--c': colorOf(item.category), ...(second ? { '--c2': colorOf(second) } : {}) } as CSSProperties;
  const cls = [styles.tile, big ? styles.tileBig : '', second ? styles.tileWide : '', qty > 0 ? styles.tileOn : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} style={style} onClick={onPick} aria-label={`${itemLabel(item)}, ${formatEur(item.priceCents)}${qty > 0 ? `, llevas ${qty}` : ''}`}>
      {qty > 0 ? <span className={styles.count}>×{qty}</span> : null}
      <span className={styles.kicker}>{labelOf(ctx, item.category)}</span>
      <span className={styles.tileName}>{itemLabel(item)}</span>
      <span className={styles.price}>{formatEur(item.priceCents, { compact: true })}</span>
    </button>
  );
}
