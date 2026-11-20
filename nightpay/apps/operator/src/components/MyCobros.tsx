'use client';

import { useEffect, useRef, useState } from 'react';
import type { CobroKind, OwnCobro } from '@nightpay/contracts';
import { Button, Card, useNow } from '@nightpay/ui';
import { cancelPayment } from '@/lib/api';
import { paymentTimeLabel, timeLabel } from '@/lib/earnings-view';
import {
  createOwnCobrosFeed,
  fetchOwnCobros,
  ownChargedCents,
  ownCobroCancelable,
  ownCobroState,
  ownNightTotals,
  ownPaidTwiceNote,
  ownCobrosPollMs,
  ownRowBank,
  pendingLabel,
  staffVia,
  type OwnCobroIcon,
  type OwnCobrosSnapshot,
  type OwnNight,
} from '@/lib/my-cobros';
import { AT_BANK_PAYING_TEXT, AT_BANK_SLOW_TEXT, HELD_ON_READER_TEXT, offersCancel, type BankCancel } from '@/lib/cancel-at-bank';
import { NO_DAYS, type DayRange } from '@/lib/history';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';
import { CancelCobroConfirm } from './CancelCobroConfirm';
import { CobroDetailSheet } from './CobroDetailSheet';
import { DateRange } from './DateRange';
import { UnpaidInVenue } from './UnpaidInVenue';
import { useUnpaidInVenue } from './use-unpaid-in-venue';
import detailStyles from './cobro-detail.module.css';
import styles from './my-cobros.module.css';

interface Props {
  /** Cancelar ahí los cobros con tarjeta aún sin pagar (la chica). */
  cancelPending?: boolean;
  /** Cada cuánto se refresca (roles.ts). */
  pollMs?: number;
}

/**
 * «Cobros» del personal (la chica, el camarero…): su historial (tarjeta y
 * saldo, también las invitaciones), el mismo que el panel: un cobro = una
 * fila (el cobro único pagado con el saldo es el del saldo, pagado; el cobro
 * con tarjeta que se canceló solo no sale). Para mirarlo de un vistazo a
 * oscuras: arriba el total de la noche y, en cada cobro, un chip de color con
 * icono y palabra, la propina en su línea, las recargas marcadas «no es
 * venta» y el «cobrado dos veces» del panel. No autoriza devoluciones; con
 * `cancelPending`, cancela los suyos aún sin pagar. Su ayuda es el tutorial del
 * «?» de la cabecera (lib/tours.ts).
 */
export function MyCobros(props: Props) {
  const [days, setDays] = useState<DayRange>(NO_DAYS);
  return (
    <section className={styles.list} aria-label="Mis cobros" data-tour="cobros-lista">
      <h2 className={styles.title}>Mis cobros</h2>
      <DateRange value={days} onChange={setDays} />
      {/* Otras fechas, otra lista: se empieza de cero (con su sondeo y sus páginas). */}
      <CobrosFeed key={`${days.fromDay}|${days.toDay}`} {...props} days={days} />
    </section>
  );
}

/** La lista en sí: con fechas, solo los de esas noches y sin el total de «Esta noche». */
function CobrosFeed({ cancelPending = false, pollMs = 15_000, days }: Props & { days: DayRange }) {
  const [{ items, cursor, error, moreBusy, night }, setState] = useState<OwnCobrosSnapshot>({ items: null, cursor: null, error: null, moreBusy: false, night: null });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // «¿Cancelar este cobro?» de una fila suya: siempre se confirma.
  const [confirmRow, setConfirmRow] = useState<OwnCobro | null>(null);
  /** El cobro abierto («Detalle del pago»): se toca la fila. */
  const [opened, setOpened] = useState<{ kind: CobroKind; id: string } | null>(null);
  const feed = useRef<ReturnType<typeof createOwnCobrosFeed> | null>(null);
  // Los cobros sin pagar del local (para «Sin pagar» y, con el cliente en su banco, para las filas suyas).
  const unpaid = useUnpaidInVenue();
  // Un solo reloj para toda la pantalla: corre solo mientras algún cobro está en su banco.
  const now = useNow(unpaid.items?.some((u) => u.atBank) ?? false);
  useEffect(() => {
    const current = createOwnCobrosFeed((page, signal) => fetchOwnCobros(page, signal, days), setState);
    feed.current = current;
    return () => { current.dispose(); if (feed.current === current) feed.current = null; };
    // Las fechas no cambian sin volver a montar (key en MyCobros).
  }, []);
  // Revalida todo lo cargado (y la noche entera): puede ser más de una página.
  // Un «no se pudo cancelar» se va con el refresco siguiente, que ya trae cómo quedó el cobro.
  const firstCancelable = cancelPending && items ? items.findIndex((x) => ownCobroCancelable(x)) : -1;
  const refresh = usePolling(
    async (signal) => {
      if (!(await feed.current?.refresh(signal))) return 'slow';
      setCancelError(null);
      return undefined;
    },
    { intervalMs: ownCobrosPollMs({ cancelPending, pollMs }, items), timeoutMs: 45_000 },
  );

  async function onCancel(id: string) {
    setBusyId(id);
    setCancelError(null);
    try {
      await cancelPayment(id);
      refresh();
      unpaid.refresh();
    } catch (err) {
      setCancelError((err as Error).message);
      unpaid.refresh();
    } finally {
      setBusyId(null);
      setConfirmRow(null);
    }
  }

  return (
    <>
      <UnpaidInVenue items={unpaid.items} nowMs={now} refresh={unpaid.refresh} ownListCancels={cancelPending} onCanceled={refresh} />
      {night && items ? <NightTotal items={items} night={night} cursor={cursor} /> : null}
      {error ? (
        <Card role="alert" style={{ padding: '1rem' }}>
          <p style={{ marginTop: 0 }}>{error}</p>
          <Button variant="ghost" onClick={refresh}>Reintentar</Button>
        </Card>
      ) : null}
      {cancelError ? (
        <Card role="alert" style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0 }}>{cancelError}</p>
        </Card>
      ) : null}
      {items === null && !error ? <p className={styles.note}>Cargando tu historial…</p> : null}
      {items?.length === 0 ? (
        <p className={styles.note}>{days.fromDay || days.toDay ? 'No hay cobros en esas fechas.' : 'Aún no has hecho cobros.'}</p>
      ) : null}
      {items?.map((r, i) => {
        // En su banco: los primeros 2 minutos sin botón; después, con «El banco tarda…» (null: aún no se sabe).
        // Cobrado en el datáfono sin comprobar: sin botón, nunca.
        const bank = cancelPending && ownCobroCancelable(r) ? ownRowBank(r, unpaid.items, now) : null;
        return (
          <CobroRow
            key={`${r.kind}-${r.id}`}
            first={i === 0}
            row={r}
            night={night}
            onOpen={() => setOpened({ kind: r.kind, id: r.id })}
            bank={bank}
            cancel={offersCancel(bank) ? { busy: busyId === r.id, run: () => setConfirmRow(r) } : null}
            cancelFirst={cancelPending && ownCobroCancelable(r) && i === firstCancelable}
          />
        );
      })}
      {cursor ? (
        <Button variant="ghost" onClick={() => void feed.current?.loadMore()} loading={moreBusy} disabled={moreBusy}>
          Ver anteriores
        </Button>
      ) : null}
      <CobroDetailSheet target={opened} onClose={() => setOpened(null)} />
      <CancelCobroConfirm
        open={confirmRow !== null}
        atBank={confirmRow !== null && ownRowBank(confirmRow, unpaid.items, now) === 'late'}
        busy={confirmRow !== null && busyId === confirmRow.id}
        detail={confirmRow ? [confirmRow.ref, formatEur(confirmRow.amountCents, { compact: true })].filter(Boolean).join(' · ') : null}
        onConfirm={() => confirmRow && void onCancel(confirmRow.id)}
        onClose={() => setConfirmRow(null)}
      />
    </>
  );
}

function NightTotal({ items, night, cursor }: { items: readonly OwnCobro[]; night: OwnNight; cursor: string | null }) {
  const t = ownNightTotals(items, night, cursor);
  const extras = [
    t.tipCents > 0 ? <span key="tip" className={styles.tipTag}>Propinas {formatEur(t.tipCents, { compact: true })}</span> : null,
    t.topUpCount > 0 ? <span key="topup" className={styles.saleTag}>Recargas {formatEur(t.topUpCents, { compact: true })} · no es venta</span> : null,
    t.pending > 0 ? <span key="pending" className={styles.waitTag}>{pendingLabel(t.pending)}</span> : null,
  ].filter(Boolean);
  return (
    <div className={styles.night} data-tour="cobros-total">
      <span className={styles.kicker}>
        {night.open ? 'Esta noche' : 'Desde el último cierre'} · desde las {timeLabel(night.from)}
      </span>
      <b className={`np-num ${styles.nightTotal}`}>{t.complete ? '' : 'Al menos '}{formatEur(t.salesCents, { compact: true })}</b>
      <span className={styles.nightLine}>
        {t.count === 1 ? '1 cobro' : `${t.count} cobros`} · con propinas, sin devoluciones
      </span>
      {extras.length > 0 ? <span className={styles.tags}>{extras}</span> : null}
      {t.complete ? null : <span className={styles.note}>Faltan cobros de la noche por cargar: toca «Ver anteriores».</span>}
    </div>
  );
}

interface RowCancel {
  busy: boolean;
  run: () => void;
}

function CobroRow({
  row: r,
  night,
  onOpen,
  cancel,
  bank = null,
  first = false,
  cancelFirst = false,
}: {
  row: OwnCobro;
  night: OwnNight | null;
  onOpen: () => void;
  cancel: RowCancel | null;
  /** Con el cliente en su banco: «wait» (sin botón) o «late» (con el botón); cobrado en el datáfono sin comprobar: «held». */
  bank?: BankCancel | null;
  /** La primera fila lleva las marcas del tutorial (data-tour). */
  first?: boolean;
  /** El primer cobro que se puede cancelar lleva la marca de «Cancelar». */
  cancelFirst?: boolean;
}) {
  const state = ownCobroState(r.status);
  const when = new Date(r.createdAt);
  const tonight = night ? r.createdAt >= night.from : false;
  const left = ownChargedCents(r);
  const meta = [r.ref, r.methodLabel, staffVia(r.via)].filter(Boolean).join(' · ');
  const twice = ownPaidTwiceNote(r, (cents) => formatEur(cents, { compact: true }));
  return (
    <article className={`${styles.row} ${detailStyles.rowHost}`} data-tone={state.tone} {...(first ? { 'data-tour': 'cobros-fila' } : {})}>
      {/* Toda la fila abre el detalle; «Cancelar», por encima. */}
      <button
        type="button"
        className={detailStyles.rowOpen}
        onClick={onOpen}
        aria-label={`Ver el cobro ${r.ref ? `${r.ref} ` : ''}de ${formatEur(r.amountCents, { compact: true })}`}
      />
      <div className={styles.rowTop}>
        <span className={styles.chip} data-tone={state.tone} {...(first ? { 'data-tour': 'cobros-estado' } : {})}>
          <StateIcon icon={state.icon} />
          {state.label}
        </span>
        <time dateTime={r.createdAt} className={styles.time}>{tonight ? timeLabel(when) : paymentTimeLabel(when)}</time>
      </div>
      <b className={`np-num ${styles.amount}`} data-gone={(state.tone === 'bad' || (state.tone === 'void' && left === 0)) || undefined}>
        {formatEur(r.amountCents, { compact: true })}
      </b>
      {twice ? (
        <span className={styles.twice} data-refunded={r.paidTwice?.refunded || undefined} role="note">
          {twice}
        </span>
      ) : null}
      {r.tipCents > 0 ? <span className={styles.tip}>+ {formatEur(r.tipCents, { compact: true })} de propina</span> : null}
      {r.refundedCents > 0 && r.status === 'PARTIALLY_REFUNDED' ? (
        <span className={styles.refund}>Devuelto {formatEur(r.refundedCents, { compact: true })} · quedan {formatEur(left, { compact: true })}</span>
      ) : null}
      <span className={styles.what}>
        {r.service ?? (r.isTopUp ? 'Recarga de saldo' : 'Cobro')}
        {r.isTopUp ? <span className={styles.saleTag}>no es venta</span> : null}
      </span>
      {r.invitedName ? <span className={styles.invited}>Invitación a {r.invitedName}</span> : null}
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      {bank === 'wait' || bank === 'late' || bank === 'held' ? (
        <span className={styles.meta} role="status">
          {bank === 'held' ? HELD_ON_READER_TEXT : bank === 'wait' ? AT_BANK_PAYING_TEXT : AT_BANK_SLOW_TEXT}
        </span>
      ) : null}
      {cancel ? (
        <div className={`${styles.actions} ${detailStyles.rowAbove}`} {...(cancelFirst ? { 'data-tour': 'cobros-cancelar' } : {})}>
          <Button
            variant="ghost"
            size="md"
            onClick={cancel.run}
            loading={cancel.busy}
            disabled={cancel.busy}
            aria-label={`Cancelar el cobro ${r.ref ? `${r.ref} ` : ''}de ${formatEur(r.amountCents, { compact: true })}`}
          >
            Cancelar
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function StateIcon({ icon }: { icon: OwnCobroIcon }) {
  const path = {
    check: 'M5 12.5l4.5 4.5L19 7.5',
    clock: 'M12 7v5l3 2M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z',
    x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    back: 'M9 7L4.5 11.5 9 16M5 11.5h9.5a5 5 0 0 1 0 10H12',
  }[icon];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}
