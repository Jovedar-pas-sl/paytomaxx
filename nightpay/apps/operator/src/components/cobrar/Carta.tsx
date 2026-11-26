'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { BusyWord, Icon, ScreenHelp } from '@nightpay/ui';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { TOURS } from '@/lib/tours';
import { formatEur } from '@/lib/money';
import { createLongPress } from '@/lib/long-press';
import { cartaGroups, cartaTileColor, cartaTiles, tapOf } from '@/lib/carta-tiles';
import { cobrarLabel, itemTileKey, pickable, tileLabel, undoFocusTarget, type UndoTap } from '@/lib/carta-view';
import { chargeable, itemLabel, cuentaSummary, cuentaTotals, qtyOf, type CartaItem, type Cuenta } from '@/lib/cuenta';
import { colorOf, labelOf, offeredCodes, puestoChip, type CobrarContext } from './cobrar-context';
import { ItemThumb } from './ItemThumb';
import { Chip, ScreenHeader } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  cuenta: Cuenta;
  /** «Carlos · camarero». */
  who: string;
  /** Una loseta de la carta: «Copa» (y el resto) se suma a la cuenta; «Copa con invitación» va a escanear el QR de la chica. */
  onItem: (item: CartaItem) => void;
  /** Mantener pulsada una loseta (o «Agotados»): marca o quita «Agotado». */
  onSoldOut: (item: CartaItem, soldOut: boolean) => void;
  onOtro: () => void;
  onVerCuenta: () => void;
  onCobrar: () => void;
  /** Lo último que se tocó («+1 Nachos»), durante 4 s: el pie ofrece «Deshacer». */
  undo?: Pick<UndoTap, 'label' | 'spoken' | 'tile'> | null;
  onUndo?: () => void;
  busy: boolean;
  error: string | null;
  onLogo: () => void;
  /** Un botón más en la cabecera (la chica: «Mi QR»). */
  headerExtra?: ReactNode;
  onRetryCarta: () => void;
  /** Encima de las losetas (el RRPP: «Tus reservas de RRPP»). */
  banner?: ReactNode;
}

/**
 * «Cobrar», variante A (maqueta 1.1), en Grafito: cada loseta del color sólido
 * de su sección con el texto en tinta (Grafito 2: el tinte del 26 % se veía
 * apagado) y el título de cada sección una sola vez, solo las que su
 * puesto cobra. Tocar suma a la cuenta (×N); abajo, el resumen y «Cobrar N €». «Copa con invitación» es una loseta más (en la carta de
 * referencia, justo después de «Copa»): tocarla abre el escáner del QR de la
 * chica. La chica ve Servicios y Propinas, más grandes; la habitación no es
 * suya («La cobra recepción»).
 */
export function Carta({
  ctx,
  cuenta,
  who,
  onItem,
  onSoldOut,
  onOtro,
  onVerCuenta,
  onCobrar,
  undo = null,
  onUndo,
  busy,
  error,
  onLogo,
  headerExtra,
  onRetryCarta,
  banner,
}: Props) {
  const codes = offeredCodes(ctx);
  const items = cartaTiles(ctx.carta, codes);
  // B1: sin losetas de propina (la elige el cliente al pagar).
  const sectionsShown = new Set(items.map((i) => i.category));
  const big = sectionsShown.size <= 2;
  // La chica: la habitación, si el local la usa, la cobra recepción.
  const roomsElsewhere =
    ctx.user.role === 'OPERATOR' &&
    !codes.includes('VENUE_ROOM') &&
    (ctx.sections.find((s) => s.code === 'VENUE_ROOM')?.enabled ?? true);
  const chip = puestoChip(ctx);
  const groups = cartaGroups(items);
  const totals = cuentaTotals(cuenta);
  const summary = cuentaSummary(cuenta, (s) => labelOf(ctx, s));
  const canCharge = chargeable(cuenta) && !busy;
  const undoFocus = useUndoFocus(undo?.tile ?? null);

  return (
    <div className={styles.screen} ref={undoFocus.root}>
      <ScreenHeader
        title="Cobrar"
        subtitle={who}
        onLogo={onLogo}
        extra={headerExtra}
        help={<ScreenHelp {...TOURS.cobrar} ready={!busy && cuenta.length === 0} />}
        chip={chip ? <Chip color={chip.color}>{chip.label}</Chip> : null}
      />
      <div className={styles.body}>
        {banner}
        <div className={styles.tiles} data-tour="cobrar-carta">
          {/* Clave con el orden: un pack de una sección ajena puede repetir sección más abajo. */}
          {groups.map((group, i) => (
            <Fragment key={`${group.section}-${i}`}>
              {/* El título de la sección, una vez: su punto y su nombre (el color nunca va solo). */}
              <h2 className={styles.group} style={{ '--c': colorOf(group.section) } as CSSProperties}>
                {labelOf(ctx, group.section)}
              </h2>
              {group.items.map((item) => (
                <ItemTile key={item.id} item={item} qty={qtyOf(cuenta, item.id)} big={big} onPick={() => onItem(item)} onSoldOut={(v) => onSoldOut(item, v)} />
              ))}
            </Fragment>
          ))}
          {/* «Otro importe», encima de «Cobrar» también con la carta entera (sin propinas: las elige el cliente al pagar). */}
          <div className={styles.lastRow} style={{ '--n': 2 } as CSSProperties} data-n={1} data-big={big || undefined} data-tour="cobrar-otro">
            <button type="button" className={`${styles.tile} ${styles.tileOther}${big ? ` ${styles.tileBig}` : ''}`} onClick={onOtro}>
              <span className={styles.tileName}>Otro importe</span>
              <span>{codes.length > 1 ? 'Teclearlo y elegir sección' : 'Teclearlo'}</span>
            </button>
          </div>
          {roomsElsewhere ? (
            <div className={`${styles.tile} ${styles.tileAsk}${big ? ` ${styles.tileBig}` : ''}`}>
              <span className={styles.tileName}>{singular(labelOf(ctx, 'VENUE_ROOM'))}</span>
              <span>La cobra recepción</span>
            </div>
          ) : null}
        </div>
        {items.length > 0 ? (
          // La alternativa a mantener pulsada una loseta: nativa, con teclado y lector de pantalla.
          <details className={styles.agotados}>
            <summary>Agotados</summary>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" aria-pressed={item.soldOut === true} onClick={() => onSoldOut(item, item.soldOut !== true)}>
                    {itemLabel(item)}
                    <span>{item.soldOut ? 'Agotado · toca para quitarlo' : 'Hay'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {ctx.cartaFailed ? (
          <p role="status" className={styles.empty}>
            No se pudo cargar la carta: usa «Otro importe» o{' '}
            <button type="button" className={styles.link} onClick={onRetryCarta}>
              reintentar
            </button>
            .
          </p>
        ) : ctx.cartaLoaded && items.length === 0 ? (
          <p className={styles.empty}>No hay productos disponibles para tu puesto. El dueño o encargado debe configurar la carta en Ajustes → Carta y comprobar las secciones del puesto.{' '}
            <button type="button" className={styles.link} onClick={onRetryCarta}>Actualizar carta</button>
          </p>
        ) : null}
      </div>
      <div className={`${styles.foot}${cuenta.length === 0 && !busy ? ` ${styles.footEmpty}` : ''}`} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties} data-np-foot="">
        {/* Lo que se acaba de añadir, para el lector de pantalla (la región existe siempre: así se anuncia). */}
        <span className="np-sr-only" aria-live="polite">
          {undo ? undo.spoken : ''}
        </span>
        {cuenta.length > 0 ? (
          // data-sum + tabIndex -1: si «Deshacer» se va con el foco y la loseta no está, el foco viene aquí.
          <div className={styles.sum} data-sum="" tabIndex={-1} data-tour="cobrar-resumen">
            {undo && onUndo ? (
              <>
                <span className={`${styles.grow} ${styles.added}`}>{undo.label}</span>
                <button
                  type="button"
                  ref={undoFocus.button}
                  className={styles.undoBtn}
                  onClick={onUndo}
                  aria-label={`Deshacer: ${undo.label}`}
                >
                  <Icon name="undo" size={20} />
                  Deshacer
                </button>
              </>
            ) : (
              // El resumen ya nombra lo que lleva: sin barra de colores al lado.
              <span className={styles.grow}>{summary}</span>
            )}
            <button type="button" className={styles.link} onClick={onVerCuenta}>
              Ver cuenta
            </button>
          </div>
        ) : null}
        {/* Vacío: solo la instrucción, en una línea fina (en un datáfono de 360×720 el botón
            gris tapaba la fila de abajo de la carta); con algo en la cuenta, «Cobrar» en lima. */}
        {cuenta.length === 0 && !busy ? (
          <p className={styles.footHint} data-tour="cobrar-cobrar">
            {cobrarLabel({ busy, empty: true, totalCents: 0 })}
          </p>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={!canCharge}
            aria-busy={busy || undefined}
            onClick={onCobrar}
            data-tour="cobrar-cobrar"
          >
            {busy ? <BusyWord word={cobrarLabel({ busy, empty: false, totalCents: 0 })} /> : cobrarLabel({ busy, empty: false, totalCents: totals.totalCents })}
          </button>
        )}
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

/**
 * Si «Deshacer» desaparece teniendo el foco (caduca a los 4 s o se toca), el
 * foco va a la loseta que se tocó (o al resumen), no al body. El botón se mira
 * al soltarse su ref, antes de quitarlo de la página.
 */
function useUndoFocus(tile: string | null) {
  const root = useRef<HTMLDivElement | null>(null);
  const node = useRef<HTMLButtonElement | null>(null);
  const lastTile = useRef<string | null>(tile);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (tile !== null) lastTile.current = tile;
  }, [tile]);
  const button = useCallback((el: HTMLButtonElement | null) => {
    if (!el && node.current && document.activeElement === node.current) pending.current = lastTile.current;
    node.current = el;
  }, []);
  useEffect(() => {
    const target = pending.current;
    if (target === null) return;
    pending.current = null;
    if (root.current) undoFocusTarget<HTMLElement>(root.current, target)?.focus();
  });
  return { root, button };
}

/** «Habitaciones» → «Habitación» (la loseta habla de una). */
function singular(label: string): string {
  if (/ones$/i.test(label)) return `${label.slice(0, -4)}ón`;
  return label.replace(/s$/i, '');
}

export function ItemTile({
  item,
  qty,
  big,
  onPick,
  onSoldOut,
}: {
  item: CartaItem;
  qty: number;
  big: boolean;
  onPick: () => void;
  onSoldOut: (soldOut: boolean) => void;
}) {
  const soldOut = item.soldOut === true;
  // Mantener pulsada: marca o quita «Agotado» (el mismo gesto lo deshace). Siempre con lo último.
  const toggle = useRef(onSoldOut);
  useEffect(() => {
    toggle.current = onSoldOut;
  });
  const soldRef = useRef(soldOut);
  useEffect(() => {
    soldRef.current = soldOut;
  });
  const press = useMemo(() => createLongPress(() => toggle.current(!soldRef.current)), []);
  useEffect(() => press.cancel, [press]);
  // El color sólido de su sección (un pack, la suya), con tinta encima: el nombre de la sección va en el título del grupo.
  const style = { '--c': cartaTileColor(item.category) } as CSSProperties;
  const cls = [styles.tile, styles.tileItem, big ? styles.tileBig : '', qty > 0 ? styles.tileOn : '', soldOut ? styles.tileSoldOut : ''].filter(Boolean).join(' ');
  // La copa con invitación no va a la cuenta: se cobra aparte, con el QR de la chica.
  const invite = tapOf(item) === 'invitar';
  const label = soldOut ? `${itemLabel(item)}, ${formatEur(item.priceCents)}, agotado` : tileLabel(itemLabel(item), item.priceCents, { qty, invite });
  return (
    <button
      type="button"
      className={cls}
      style={style}
      data-tile={itemTileKey(item.id)}
      // aria-disabled (no disabled): sigue enfocable y se puede mantener pulsada para quitar «Agotado».
      aria-disabled={soldOut || undefined}
      onClick={() => {
        if (press.click() && pickable(item)) onPick();
      }}
      onPointerDown={(e) => press.down(e.clientX, e.clientY)}
      onPointerMove={(e) => press.move(e.clientX, e.clientY)}
      onPointerUp={press.cancel}
      onPointerLeave={press.cancel}
      onPointerCancel={press.cancel}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={label}
    >
      {qty > 0 ? (
        <span className={styles.count} aria-hidden="true">
          {qty}
        </span>
      ) : null}
      {invite && !soldOut ? (
        <span className={styles.tileQr} aria-hidden="true">
          <Icon name="qr" size={20} />
        </span>
      ) : null}
      <ItemThumb item={item} />
      <span className={styles.tileText}>
        <span className={`${styles.tileName}${qty > 0 || invite ? ` ${styles.tileNameBadge}` : ''}`}>{itemLabel(item)}</span>
        <span className={styles.price}>{formatEur(item.priceCents, { compact: true })}</span>
        {soldOut ? <span className={styles.soldOutTag}>Agotado</span> : null}
      </span>
    </button>
  );
}
