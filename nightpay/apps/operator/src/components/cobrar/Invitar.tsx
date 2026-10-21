'use client';

import type { CSSProperties } from 'react';
import { formatEur } from '@/lib/money';
import { invitationSplit, soloLabel, splitCells } from '@/lib/cobro-view';
import type { CartaItem } from '@/lib/cuenta';
import { colorOf, labelOf, puestoChip, type CobrarContext } from './cobrar-context';
import { IconGlass, IconQr, IconStar } from './icons';
import { Chip, ScreenHeader, Stripe } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  who: string;
  invite: CartaItem;
  /** La copa que tocó (la «copa sola»). */
  solo: CartaItem | null;
  onInvite: () => void;
  onSolo: () => void;
  onBack: () => void;
}

/**
 * Al tocar una copa (maqueta 2.1): «Invitar a una copa» lo primero y lo más
 * grande, con el brillo lima de la tarjeta (es el mejor plan para la chica y
 * para la barra). La copa sola, debajo, pequeña, a un toque.
 */
export function Invitar({ ctx, who, invite, solo, onInvite, onSolo, onBack }: Props) {
  const chip = puestoChip(ctx);
  const split = ctx.rules ? invitationSplit(ctx.rules, invite.priceCents, ctx.user.role === 'WAITER') : null;
  const cells = split ? splitCells(split, { chica: 'La chica', barra: 'La barra' }) : [];
  return (
    <div className={styles.screen}>
      <ScreenHeader
        title={labelOf(ctx, invite.category)}
        subtitle={who}
        onBack={onBack}
        chip={chip ? <Chip colors={[chip.color]}>{chip.label}</Chip> : null}
      />
      <Stripe parts={[{ color: colorOf(invite.category), weight: 1 }]} />
      <div className={styles.body}>
        <div className={styles.invite}>
          <span className={styles.best}>
            <IconStar />
            La mejor opción
          </span>
          <span className={styles.glass} aria-hidden="true">
            <IconGlass />
          </span>
          <h2 className={styles.inviteTitle}>Invitar a una copa</h2>
          <span className={styles.invitePrice}>{formatEur(invite.priceCents, { compact: true })}</span>
          <p>Una copa para la chica, con su parte para ella.</p>
          {cells.length > 0 ? (
            <div className={styles.psplit}>
              {cells.map((c) => (
                <span key={c.label}>
                  <small>{c.label}</small>
                  <b>{formatEur(c.cents, { compact: true })}</b>
                </span>
              ))}
            </div>
          ) : null}
          <span className={styles.next}>
            <IconQr />
            {ctx.rules?.requireQr === false ? 'Luego: su QR o elegirla de la lista' : 'Luego: escanear el QR de la chica'}
          </span>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onInvite}>
            Invitar a una copa
          </button>
        </div>
        {solo ? <button type="button" className={styles.solo} onClick={onSolo} style={{ '--c': colorOf(solo.category) } as CSSProperties}>
          <span>{soloLabel(solo.name)}</span>
          <b>{formatEur(solo.priceCents, { compact: true })}</b>
        </button> : null}
      </div>
    </div>
  );
}
