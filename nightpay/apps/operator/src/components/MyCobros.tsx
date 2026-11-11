'use client';

import { useEffect, useRef, useState } from 'react';
import type { CobroKind, OwnCobro } from '@nightpay/contracts';
import { Button, Card } from '@nightpay/ui';
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
  type OwnCobroIcon,
  type OwnCobrosSnapshot,
  type OwnNight,
} from '@/lib/my-cobros';
import {
  MY_COBROS_HELP_SCREEN,
  myCobrosHelpLine,
  myCobrosSituations,
  myCobrosStates,
  type MyCobrosViewer,
} from '@/lib/my-cobros-help';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';
import { CobroDetailSheet } from './CobroDetailSheet';
import { HelpAgain, HelpLine, useHelp } from './HelpLine';
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
 * `cancelPending`, cancela los suyos aún sin pagar. Arriba (Grafito 2), una
 * línea de ayuda que se cierra con «Entendido» y «¿Qué significa cada estado?».
 */
export function MyCobros({ cancelPending = false, pollMs = 15_000 }: Props) {
  const [{ items, cursor, error, moreBusy, night }, setState] = useState<OwnCobrosSnapshot>({ items: null, cursor: null, error: null, moreBusy: false, night: null });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  /** El cobro abierto («Detalle del pago»): se toca la fila. */
  const [opened, setOpened] = useState<{ kind: CobroKind; id: string } | null>(null);
  const help = useHelp(MY_COBROS_HELP_SCREEN);
  const feed = useRef<ReturnType<typeof createOwnCobrosFeed> | null>(null);
  useEffect(() => {
    const current = createOwnCobrosFeed(fetchOwnCobros, setState);
    feed.current = current;
    return () => { current.dispose(); if (feed.current === current) feed.current = null; };
  }, []);
  // Revalida todo lo cargado (y la noche entera): puede ser más de una página.
  // Un «no se pudo cancelar» se va con el refresco siguiente, que ya trae cómo quedó el cobro.
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
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const viewer: MyCobrosViewer = { cancelPending };
  return (
    <section className={styles.list} aria-label="Mis cobros">
      {/* Qué es la lista y qué se puede hacer (se cierra con «Entendido»; el «?» la vuelve a enseñar). */}
      <div className={styles.titleRow}>
        <h2 className={styles.title}>Mis cobros</h2>
        <HelpAgain help={help} />
      </div>
      <HelpLine help={help}>{myCobrosHelpLine(viewer)}</HelpLine>
      <StatesHelp viewer={viewer} />
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
      {items?.length === 0 ? <p className={styles.note}>Aún no has hecho cobros.</p> : null}
      {items?.map((r) => (
        <CobroRow
          key={`${r.kind}-${r.id}`}
          row={r}
          night={night}
          onOpen={() => setOpened({ kind: r.kind, id: r.id })}
          cancel={cancelPending && ownCobroCancelable(r) ? { busy: busyId === r.id, run: () => void onCancel(r.id) } : null}
        />
      ))}
      {cursor ? (
        <Button variant="ghost" onClick={() => void feed.current?.loadMore()} loading={moreBusy} disabled={moreBusy}>
          Ver anteriores
        </Button>
      ) : null}
      <CobroDetailSheet target={opened} onClose={() => setOpened(null)} />
    </section>
  );
}

/**
 * «¿Qué significa cada estado?», cerrado de entrada: cada estado que puede
 * salir en la lista con su chip (el mismo de las filas) y qué hacer; debajo,
 * «Si pasa esto»: el botón que hay que tocar o a quién avisar.
 */
function StatesHelp({ viewer }: { viewer: MyCobrosViewer }) {
  return (
    <details className={styles.help}>
      <summary>¿Qué significa cada estado?</summary>
      <div className={styles.helpBody}>
        <dl className={styles.legend}>
          {myCobrosStates(viewer).map((st) => (
            <div key={st.label} data-tone={st.tone}>
              <dt>
                <span className={styles.chip} data-tone={st.tone}>
                  <StateIcon icon={st.icon} />
                  {st.label}
                </span>
              </dt>
              <dd>{st.text}</dd>
            </div>
          ))}
        </dl>
        <h3 className={styles.helpTitle}>Si pasa esto</h3>
        <dl className={styles.cases}>
          {myCobrosSituations(viewer).map((c) => (
            <div key={c.when}>
              <dt>{c.when}</dt>
              <dd>{c.todo}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function NightTotal({ items, night, cursor }: { items: readonly OwnCobro[]; night: OwnNight; cursor: string | null }) {
  const t = ownNightTotals(items, night, cursor);
  const extras = [
    t.tipCents > 0 ? <span key="tip" className={styles.tipTag}>Propinas {formatEur(t.tipCents, { compact: true })}</span> : null,
    t.topUpCount > 0 ? <span key="topup" className={styles.saleTag}>Recargas {formatEur(t.topUpCents, { compact: true })} · no es venta</span> : null,
    t.pending > 0 ? <span key="pending" className={styles.waitTag}>{t.pending === 1 ? '1 pendiente' : `${t.pending} pendientes`}</span> : null,
  ].filter(Boolean);
  return (
    <div className={styles.night}>
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

function CobroRow({ row: r, night, onOpen, cancel }: { row: OwnCobro; night: OwnNight | null; onOpen: () => void; cancel: RowCancel | null }) {
  const state = ownCobroState(r.status);
  const when = new Date(r.createdAt);
  const tonight = night ? r.createdAt >= night.from : false;
  const left = ownChargedCents(r);
  const meta = [r.ref, r.methodLabel, r.via].filter(Boolean).join(' · ');
  const twice = ownPaidTwiceNote(r, (cents) => formatEur(cents, { compact: true }));
  return (
    <article className={`${styles.row} ${detailStyles.rowHost}`} data-tone={state.tone}>
      {/* Toda la fila abre el detalle; «Cancelar», por encima. */}
      <button
        type="button"
        className={detailStyles.rowOpen}
        onClick={onOpen}
        aria-label={`Ver el cobro ${r.ref ? `${r.ref} ` : ''}de ${formatEur(r.amountCents, { compact: true })}`}
      />
      <div className={styles.rowTop}>
        <span className={styles.chip} data-tone={state.tone}>
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
      {cancel ? (
        <div className={`${styles.actions} ${detailStyles.rowAbove}`}>
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
