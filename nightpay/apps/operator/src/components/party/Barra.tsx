'use client';

import { useState, type CSSProperties } from 'react';
import { BusyWord, EmptyState, Icon } from '@nightpay/ui';
import { formatEur } from '@/lib/money';
import { chargeable, cuentaTotals, qtyOf, type CartaItem, type Cuenta } from '@/lib/cuenta';
import {
  barraCobrarLabel,
  barraFilters,
  barraTileAria,
  barraTiles,
  filterTiles,
  resolveFilter,
  ticketCount,
  ticketLines,
  ticketTitle,
  tileIconOf,
  ALL,
} from '@/lib/party-barra';
import { placeInitials, placeName, useVenueIdentity } from '@/lib/venue-identity';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { labelOf, offeredCodes, type CobrarContext } from '../cobrar/cobrar-context';
import { OnlinePill } from './OnlinePill';
import s from './party.module.css';

interface Props {
  ctx: CobrarContext;
  cuenta: Cuenta;
  /** Tocar una loseta: una más en el ticket. */
  onItem: (item: CartaItem) => void;
  /** − o + en una línea del ticket. */
  onStep: (key: string, delta: 1 | -1) => void;
  onVaciar: () => void;
  onOtro: () => void;
  /** «Cobrar X €»: la pantalla de cobro de siempre (QR y pulsera a la vez). */
  onCobrar: () => void;
  busy: boolean;
  error: string | null;
  /** El «⋯» de la cabecera: el menú (Mi perfil, Salir…). */
  onMenu: () => void;
  onRetryCarta: () => void;
}

/**
 * OxioParty · la barra de una caseta (maqueta Main.dc.html, «Carta»): la
 * cabecera con la caseta y «En línea», el filtro por sección, las losetas en
 * tres columnas con su icono, su precio y cuántas lleva, y abajo el ticket con
 * − y + y «Cobrar X €». Cobra la cuenta de siempre (varias líneas, un cobro).
 */
export function Barra({ ctx, cuenta, onItem, onStep, onVaciar, onOtro, onCobrar, busy, error, onMenu, onRetryCarta }: Props) {
  const identity = useVenueIdentity();
  const [picked, setPicked] = useState<string>(ALL);
  const tiles = barraTiles(ctx.carta, offeredCodes(ctx));
  const filters = barraFilters(tiles, (code) => labelOf(ctx, code));
  const filter = resolveFilter(picked, filters);
  const shown = filterTiles(tiles, filter);
  const lines = ticketLines(cuenta);
  const total = cuentaTotals(cuenta).totalCents;
  const empty = lines.length === 0;
  const canCharge = chargeable(cuenta) && !busy;
  const title = placeName(identity, 'Barra');
  const who = ctx.user.displayName?.trim() || null;
  const sub = [who, identity.stallName ? identity.venueName : null].filter(Boolean).join(' · ') || 'Barra';

  return (
    <div className={s.screen}>
      <header className={s.head}>
        <span className={s.place} aria-hidden="true">
          {placeInitials(title)}
        </span>
        <div className={s.headText}>
          <b>{title}</b>
          <span>{sub}</span>
        </div>
        <OnlinePill />
        <button type="button" className={s.menuBtn} onClick={onMenu} aria-label="Menú">
          <Icon name="dots" />
        </button>
      </header>

      {filters.length > 0 ? (
        <div className={s.seg} role="group" aria-label="Filtrar la carta" style={{ '--n': filters.length } as CSSProperties}>
          {filters.map((f) => (
            <button key={f.key} type="button" className={s.segBtn} aria-pressed={filter === f.key} onClick={() => setPicked(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className={s.tiles}>
        {shown.map((item) => (
          <BarraTile key={item.id} item={item} qty={qtyOf(cuenta, item.id)} onPick={() => onItem(item)} />
        ))}
        <button type="button" className={`${s.tile} ${s.tileOther}`} onClick={onOtro}>
          <Icon name="plus" size={20} />
          Otro importe
        </button>
      </div>

      {ctx.cartaFailed ? (
        <p role="status" className={s.note}>
          No se pudo cargar la carta: usa «Otro importe» o{' '}
          <button type="button" className={s.link} onClick={onRetryCarta}>
            reintentar
          </button>
          .
        </p>
      ) : ctx.cartaLoaded && tiles.length === 0 ? (
        <EmptyState icon="list" title="Tu caseta aún no tiene carta" text="La pone el organizador en su panel." action={{ label: 'Actualizar carta', onClick: onRetryCarta }} />
      ) : null}

      <div className={s.grow} />

      <section className={s.ticket} aria-label="Ticket" style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        <div className={s.ticketHead}>
          <p className={s.kicker}>{ticketTitle(ticketCount(cuenta))}</p>
          <button type="button" className={s.vaciar} onClick={onVaciar} disabled={empty || busy}>
            Vaciar
          </button>
        </div>
        {empty ? (
          <p className={s.ticketEmpty}>Toca lo que pide el cliente</p>
        ) : (
          <ul className={s.lines}>
            {lines.map((l) => (
              <li key={l.key} className={s.line}>
                <p className={s.lineName}>{l.name}</p>
                <div className={s.stepper}>
                  <button type="button" onClick={() => onStep(l.key, -1)} aria-label={l.canAdd ? `Uno menos: ${l.name}` : `Quitar: ${l.name}`} disabled={busy}>
                    <Icon name="minus" size={20} />
                  </button>
                  <span className={s.lineQty} aria-label={`${l.qty} ${l.qty === 1 ? 'unidad' : 'unidades'}`}>
                    {l.qty}
                  </span>
                  <button type="button" onClick={() => onStep(l.key, 1)} aria-label={`Uno más: ${l.name}`} disabled={!l.canAdd || busy}>
                    <Icon name="plus" size={20} />
                  </button>
                </div>
                <p className={s.lineAmount}>{formatEur(l.cents)}</p>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={s.cobrar} disabled={!canCharge} aria-busy={busy || undefined} onClick={onCobrar}>
          <Icon name="nfc" />
          {busy ? <BusyWord word="Cobrando" /> : <span>{barraCobrarLabel(total)}</span>}
        </button>
        {error ? (
          <p role="alert" className={s.error}>
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function BarraTile({ item, qty, onPick }: { item: CartaItem; qty: number; onPick: () => void }) {
  const icon = tileIconOf(item.category);
  return (
    <button type="button" className={s.tile} data-on={qty > 0 ? 'true' : undefined} onClick={onPick} aria-label={barraTileAria(item.name, item.priceCents, qty)}>
      <span className={s.tileIcon} data-icon={icon} aria-hidden="true">
        <Icon name={icon === 'other' ? 'tag' : icon} size={20} />
      </span>
      <span className={s.tileText}>
        <span className={s.tileName}>{item.name}</span>
        <span className={s.tilePrice}>{formatEur(item.priceCents)}</span>
      </span>
      {qty > 0 ? (
        <span className={s.bubble} aria-hidden="true">
          {qty}
        </span>
      ) : null}
    </button>
  );
}
