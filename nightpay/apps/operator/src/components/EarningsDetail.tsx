'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Button, EmptyState, FormError, type IconName } from '@nightpay/ui';
import { fetchMyEarningsPage, fetchMyPayoutsPage, reportNotMine, type MyDebt, type MyEarning, type MyNight, type MyPayoutInfo } from '@/lib/api';
import { NO_DAYS, type DayRange } from '@/lib/history';
import {
  bankHeldItems,
  dayLabel,
  earningDetail,
  groupByNight,
  heldItems,
  notMineView,
  otherNightsUnpaid,
  splitDebts,
  sumNet,
  timeLabel,
  tonightBreakdown,
  tonightEarnings,
  tonightStatus,
  unlistedCents,
  type MoneySummary,
} from '@/lib/earnings-view';
import { formatEur, formatSignedEur } from '@/lib/money';
import { DateRange } from './DateRange';
import { SkelRows } from './loading-shapes';
import { PayoutList } from './PayoutsReceived';
import { useHistory } from './use-history';
import styles from './money.module.css';

export type DetailKind = 'tonight' | 'other' | 'held' | 'bank' | 'debts' | 'history' | 'payouts';

interface Props {
  kind: DetailKind;
  night: MyNight | null;
  summary: MoneySummary;
  /** Sus últimos cobros (null: cargando). */
  earnings: MyEarning[] | null;
  /** undefined: cargando; null: no se pudo cargar. */
  info: MyPayoutInfo | null | undefined;
  holdDays: number | null;
  /** La compañera con la casilla del local apagada: no cobra ella (cambia la frase del vacío de «Esta noche»). */
  cobraEncargado?: boolean;
  onBack: () => void;
}

/** El detalle de una de las cifras de «Ganancias»: de qué cobros sale. */
export function EarningsDetail(props: Props) {
  const { kind, onBack } = props;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <button type="button" className={styles.back} onClick={onBack}>
        <span aria-hidden>‹</span> Ganancias
      </button>
      {kind === 'tonight' ? <TonightDetail {...props} /> : null}
      {kind === 'other' ? <OtherNightsDetail {...props} /> : null}
      {kind === 'held' ? <HeldDetail {...props} /> : null}
      {kind === 'bank' ? <BankDetail {...props} /> : null}
      {kind === 'debts' ? <DebtsDetail {...props} /> : null}
      {kind === 'history' ? <EarningsHistory /> : null}
      {kind === 'payouts' ? <PayoutsHistory /> : null}
    </section>
  );
}

/** «Historial de ganancias»: todo, noche a noche y con su hora, por páginas y con fechas. */
function EarningsHistory() {
  const [days, setDays] = useState<DayRange>(NO_DAYS);
  const h = useHistory(fetchMyEarningsPage, days);
  const filtered = days.fromDay !== '' || days.toDay !== '';
  return (
    <>
      <Head title="Historial de ganancias">Lo que has ganado en cada noche, cobro a cobro, también lo ya pagado.</Head>
      <DateRange value={days} onChange={setDays} />
      <HistoryStatus
        items={h.items}
        error={h.error}
        empty={
          filtered ? (
            <EmptyState icon="chart" title="Nada ganado en esas fechas" />
          ) : (
            <EmptyState icon="chart" title="Aún no has ganado nada" text="Cada cobro tuyo suma aquí tu parte." />
          )
        }
      />
      <NightGroups earnings={h.items} items={h.items ?? []} />
      <MoreButton cursor={h.cursor} busy={h.moreBusy} onMore={h.more} />
    </>
  );
}

/** «Pagos recibidos», todos: con su justificante, por páginas y con fechas. */
function PayoutsHistory() {
  const [days, setDays] = useState<DayRange>(NO_DAYS);
  const h = useHistory(fetchMyPayoutsPage, days);
  const filtered = days.fromDay !== '' || days.toDay !== '';
  return (
    <>
      <Head title="Pagos recibidos">Cada pago que te ha hecho el local, con su referencia y su justificante si lo hay.</Head>
      <DateRange value={days} onChange={setDays} />
      <HistoryStatus
        items={h.items}
        error={h.error}
        empty={
          filtered ? (
            <EmptyState icon="bank" title="Ningún pago en esas fechas" />
          ) : (
            <EmptyState icon="bank" title="Aún no te han pagado por aquí" text="Cuando el local te pague, saldrá aquí." />
          )
        }
      />
      {h.items && h.items.length > 0 ? <PayoutList payouts={h.items} /> : null}
      <MoreButton cursor={h.cursor} busy={h.moreBusy} onMore={h.more} />
    </>
  );
}

function HistoryStatus({ items, error, empty }: { items: readonly unknown[] | null; error: string | null; empty: ReactNode }) {
  if (error) return <FormError>{error}</FormError>;
  if (items === null) return <SkelRows />;
  return items.length === 0 ? <div style={emptyBox}>{empty}</div> : null;
}

function MoreButton({ cursor, busy, onMore }: { cursor: string | null; busy: boolean; onMore: () => void }) {
  if (!cursor) return null;
  return (
    <Button variant="ghost" onClick={onMore} loading={busy} disabled={busy}>
      Ver anteriores
    </Button>
  );
}

function TonightDetail({ night, summary, earnings, holdDays, cobraEncargado }: Props) {
  const items = tonightEarnings(earnings ?? [], night);
  const status = night ? tonightStatus(night, summary, holdDays, Date.now()) : null;
  return (
    <>
      <Head title="Esta noche" amount={signedOrPlain(summary.tonightCents)} tone={summary.tonightCents < 0 ? 'danger' : 'text'}>
        {status ? `${status.when}. ${status.state}.` : null}
        {night ? <><br />{tonightBreakdown(night)}</> : null}
      </Head>
      <EarningList
        earnings={earnings}
        items={items}
        empty={<EmptyState icon="receipt" title={cobraEncargado ? 'Aún no llevas nada esta noche' : 'Aún no has cobrado esta noche'} />}
      />
    </>
  );
}

function OtherNightsDetail({ night, summary, earnings }: Props) {
  const items = otherNightsUnpaid(earnings ?? [], night);
  const rest = unlistedCents(summary.otherNightsCents, sumNet(items));
  return (
    <>
      <Head title="Pendiente de otras noches" amount={formatEur(summary.otherNightsCents, { compact: true })}>
        Lo que ganaste otras noches y aún no te han pagado. Va en tu próximo pago.
      </Head>
      {earnings === null ? <SkelRows /> : null}
      {earnings !== null && items.length === 0 && rest === 0 ? <Nothing icon="calendar" title="No te deben nada de otras noches" /> : null}
      <NightGroups earnings={earnings} items={items} />
      {earnings !== null && rest > 0 ? (
        <p style={noteStyle}>
          Y <strong className="np-num">{formatEur(rest, { compact: true })}</strong> de cobros más antiguos que no salen en esta lista.
        </p>
      ) : null}
    </>
  );
}

function HeldDetail({ summary, earnings, holdDays }: Props) {
  const items = holdDays ? heldItems(earnings ?? [], holdDays, Date.now()) : [];
  const days = holdDays ? `${holdDays} ${holdDays === 1 ? 'día' : 'días'}` : 'unos días';
  return (
    <>
      <Head title="En espera" amount={formatEur(summary.heldCents, { compact: true })} tone="warning">
        El local espera {days} antes de pagar cada cobro: si el cliente lo devuelve en ese tiempo, se descuenta antes de
        pagarte y no te queda deuda.
      </Head>
      {earnings === null ? <SkelRows /> : null}
      {earnings !== null && items.length === 0 ? <Nothing icon="clock" title="Nada en espera" /> : null}
      {items.length > 0 ? (
        <ul style={listStyle}>
          {items.map(({ earning, releaseAt }) => (
            <Item
              key={earning.id}
              title={`Cobro del ${dayLabel(earning.createdAt)}`}
              detail={`Se puede pagar desde el ${dayLabel(releaseAt)} · ${earningDetail(earning)}`}
              amount={formatSignedEur(earning.netCents, { compact: true })}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Pendiente de cuadrar: cobros por datáfono que el local aún no ha cuadrado con el banco (H-1). */
function BankDetail({ summary, earnings }: Props) {
  const items = bankHeldItems(earnings ?? []);
  return (
    <>
      <Head title="Pendiente de cuadrar" amount={formatEur(summary.bankHeldCents, { compact: true })} tone="warning">
        Son cobros por datáfono que el local aún no ha cuadrado con el banco. No se pierden: se pagan en cuanto el local
        los cuadre con el extracto (o el dueño los dé por buenos).
      </Head>
      {earnings === null ? <SkelRows /> : null}
      {earnings !== null && items.length === 0 ? <Nothing icon="bank" title="Nada por comprobar con el banco" /> : null}
      {items.length > 0 ? (
        <ul style={listStyle}>
          {items.map((e) => (
            <Item
              key={e.id}
              title={`Cobro del ${dayLabel(e.createdAt)} · ${timeLabel(e.createdAt)}`}
              detail={`Por datáfono · ${earningDetail(e)}`}
              amount={formatSignedEur(e.netCents, { compact: true })}
              tone="warning"
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

function DebtsDetail({ summary, info }: Props) {
  const { open, settled } = splitDebts(info?.debts ?? []);
  const rest = unlistedCents(summary.debtCents, open.reduce((sum, d) => sum + d.cents, 0));
  return (
    <>
      <Head
        title="Deudas y descuentos"
        amount={summary.debtCents > 0 ? formatSignedEur(-summary.debtCents, { compact: true }) : formatEur(0, { compact: true })}
        tone={summary.debtCents > 0 ? 'danger' : 'mute'}
      >
        Si devuelven un cobro que ya te habían pagado, tu parte de ese cobro se descuenta de tu siguiente pago.
      </Head>
      {info === undefined ? <SkelRows /> : null}
      {info === null ? <p style={emptyText}>No se ha podido cargar el detalle. Vuelve a entrar en Ganancias.</p> : null}
      {info && open.length === 0 && rest === 0 ? <Nothing icon="wallet" title="Nada que descontarte" /> : null}
      {open.length > 0 ? (
        <ul style={listStyle}>
          {open.map((d) => (
            <DebtItem key={d.id} debt={d} />
          ))}
        </ul>
      ) : null}
      {rest > 0 && info ? (
        <p style={noteStyle}>
          Y <strong className="np-num">{formatSignedEur(-rest, { compact: true })}</strong> de devoluciones más antiguas.
        </p>
      ) : null}
      {settled.length > 0 ? (
        <>
          <h3 style={subTitle}>Ya descontadas</h3>
          <ul style={listStyle}>
            {settled.map((d) => (
              <DebtItem key={d.id} debt={d} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function DebtItem({ debt }: { debt: MyDebt }) {
  const when = debt.settledAt ? `descontada en el pago del ${dayLabel(debt.settledAt)}` : 'se descuenta del próximo pago';
  return (
    <Item
      title={`Devolución del cobro de ${formatEur(debt.chargeCents, { compact: true })}`}
      detail={`Cobro del ${dayLabel(debt.chargedAt)} · devuelto el ${dayLabel(debt.at)} · ${when}`}
      amount={formatSignedEur(-debt.cents, { compact: true })}
      tone={debt.settledPayoutId ? 'mute' : 'danger'}
    />
  );
}

/** Por noches: «Noche del sáb 12 oct · 3 cobros», su total y cada cobro con su hora. */
function NightGroups({ earnings, items }: { earnings: MyEarning[] | null; items: MyEarning[] }) {
  return (
    <>
      {groupByNight(items).map((g) => (
        <div key={g.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={groupHead}>
            <span style={{ fontWeight: 600 }}>
              Noche del {g.label} <span style={muted}>· {g.earnings.length} {g.earnings.length === 1 ? 'cobro' : 'cobros'}</span>
            </span>
            <span className="np-num" style={{ fontWeight: 600 }}>
              {formatEur(g.totalCents, { compact: true })}
            </span>
          </div>
          <EarningList earnings={earnings} items={g.earnings} />
        </div>
      ))}
    </>
  );
}

function EarningList({ earnings, items, empty }: { earnings: MyEarning[] | null; items: MyEarning[]; empty?: ReactNode }) {
  if (earnings === null) return <SkelRows />;
  if (items.length === 0) return empty ? <div style={emptyBox}>{empty}</div> : null;
  return (
    <ul style={listStyle}>
      {items.map((e) => {
        // Un servicio que otra persona le cobró a su nombre: quién, y «No es mío».
        const served = notMineView(e);
        return (
          <Item
            key={e.id}
            title={`${timeLabel(e.createdAt)} · ${e.paymentId ? 'Cobro' : 'Del saldo'}${e.payoutId ? ' · pagado' : e.bankHeld ? ' · pendiente de cuadrar' : ''}`}
            detail={served ? `Te lo cobró ${served.by} · ${earningDetail(e)}` : earningDetail(e)}
            amount={formatSignedEur(e.netCents, { compact: true })}
            tone={e.netCents < 0 ? 'danger' : e.reversedCents > 0 ? 'warning' : 'text'}
          >
            {served ? <NotMine earningId={e.id} reported={served.reported} /> : null}
          </Item>
        );
      })}
    </ul>
  );
}

/**
 * «No es mío»: avisa al encargado y al dueño (Incidencias y Telegram) de un
 * servicio que otra persona le cobró a su nombre. Pregunta antes, en la misma
 * fila. No mueve dinero ni retiene su parte.
 */
function NotMine({ earningId, reported }: { earningId: string; reported: boolean }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'sending' | 'done'>(reported ? 'done' : 'idle');
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setStep('sending');
    setError(null);
    try {
      await reportNotMine(earningId);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo avisar. Vuelve a intentarlo.');
      setStep('confirm');
    }
  }

  if (step === 'done') return <p style={{ ...metaText, color: 'var(--np-text)', fontWeight: 500 }}>Avisado</p>;
  if (step === 'idle') {
    return (
      <div style={notMineRow}>
        <Button variant="ghost" size="sm" onClick={() => setStep('confirm')}>
          No es mío
        </Button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
      <p style={{ ...metaText, color: 'var(--np-text)' }}>Avisamos al encargado y al dueño. ¿Seguro?</p>
      <div style={{ ...notMineRow, marginTop: 0 }}>
        <Button size="sm" loading={step === 'sending'} onClick={() => void send()}>
          Sí, avisar
        </Button>
        <Button variant="ghost" size="sm" disabled={step === 'sending'} onClick={() => setStep('idle')}>
          No
        </Button>
      </div>
      {error ? <FormError>{error}</FormError> : null}
    </div>
  );
}

/** Un vacío dentro de un detalle: compacto (icono y título). */
function Nothing({ icon, title }: { icon: IconName; title: string }) {
  return (
    <div style={emptyBox}>
      <EmptyState compact icon={icon} title={title} />
    </div>
  );
}

type Tone = 'danger' | 'warning' | 'mute' | 'text';

// Grafito: lo que ganas, en t1 (la lima es para actuar, nunca para un total).
const TONE_COLOR: Record<Tone, string> = {
  danger: 'var(--np-danger)',
  warning: 'var(--np-warning)',
  mute: 'var(--np-text-mute)',
  text: 'var(--np-text)',
};

function Head({ title, amount, tone = 'text', children }: { title: string; amount?: string; tone?: Tone; children: ReactNode }) {
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <h2 style={kicker}>{title}</h2>
      {amount !== undefined ? (
        <p className="np-num" style={{ ...bigAmount, color: TONE_COLOR[tone] }}>
          {amount}
        </p>
      ) : null}
      <p style={explainStyle}>{children}</p>
    </header>
  );
}

function Item({ title, detail, amount, tone = 'text', children }: { title: string; detail: string; amount: string; tone?: Tone; children?: ReactNode }) {
  return (
    <li style={itemStyle}>
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 500 }}>{title}</p>
        <p style={metaText}>{detail}</p>
        {children}
      </div>
      <span className="np-num" style={{ ...itemAmount, color: TONE_COLOR[tone] }}>
        {amount}
      </span>
    </li>
  );
}

function signedOrPlain(cents: number): string {
  return cents < 0 ? formatSignedEur(cents, { compact: true }) : formatEur(cents, { compact: true });
}

// Grafito: etiquetas 14/500 en t2, sin mayúsculas ni espaciado.
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  fontWeight: 500,
};

// Cifra grande y suelta: Manrope 600 proporcional, sin apretar.
const bigAmount: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(2.5rem, 11vw, 4rem)',
  fontWeight: 600,
  fontVariantNumeric: 'proportional-nums',
  lineHeight: 1.1,
};

const explainStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-text-mute)',
  lineHeight: 1.45,
};

const subTitle: CSSProperties = { ...kicker, marginTop: '0.5rem' };

const groupHead: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: '1rem',
  padding: '0.75rem 0.25rem 0.5rem',
  fontSize: 'var(--np-fs-16)',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  borderTop: '1px solid var(--np-border)',
};

const itemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  padding: '0.75rem 0.25rem',
  borderBottom: '1px solid var(--np-border)',
};

const itemAmount: CSSProperties = {
  fontSize: 'var(--np-fs-16)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const notMineRow: CSSProperties = { display: 'flex', gap: '0.5rem', marginTop: '0.5rem' };

const metaText: CSSProperties = {
  margin: '0.125rem 0 0',
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const muted: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 500 };

const noteStyle: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-16)' };

const emptyBox: CSSProperties = { padding: '1.5rem 0' };

const emptyText: CSSProperties = {
  margin: 0,
  padding: '1.5rem 0',
  textAlign: 'center',
  color: 'var(--np-text-mute)',
};
