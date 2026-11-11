'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { MyDebt, MyEarning, MyNight, MyPayoutInfo } from '@/lib/api';
import {
  bankHeldItems,
  dayLabel,
  earningDetail,
  groupByNight,
  heldItems,
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
import styles from './money.module.css';

export type DetailKind = 'tonight' | 'other' | 'held' | 'bank' | 'debts';

interface Props {
  kind: DetailKind;
  night: MyNight | null;
  summary: MoneySummary;
  /** Sus últimos cobros (null: cargando). */
  earnings: MyEarning[] | null;
  info: MyPayoutInfo | null;
  holdDays: number | null;
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
    </section>
  );
}

function TonightDetail({ night, summary, earnings, holdDays }: Props) {
  const items = tonightEarnings(earnings ?? [], night);
  const status = night ? tonightStatus(night, summary, holdDays, Date.now()) : null;
  return (
    <>
      <Head title="Esta noche" amount={signedOrPlain(summary.tonightCents)} tone={summary.tonightCents < 0 ? 'danger' : 'text'}>
        {status ? `${status.when}. ${status.state}.` : null}
        {night ? <><br />{tonightBreakdown(night)}</> : null}
      </Head>
      <EarningList earnings={earnings} items={items} empty="Aún no tienes cobros esta noche." />
    </>
  );
}

function OtherNightsDetail({ night, summary, earnings }: Props) {
  const items = otherNightsUnpaid(earnings ?? [], night);
  const groups = groupByNight(items);
  const rest = unlistedCents(summary.otherNightsCents, sumNet(items));
  return (
    <>
      <Head title="Pendiente de otras noches" amount={formatEur(summary.otherNightsCents, { compact: true })}>
        Lo que ganaste otras noches y aún no te han pagado. Va en tu próximo pago.
      </Head>
      {earnings === null ? <p style={emptyText}>Cargando…</p> : null}
      {earnings !== null && groups.length === 0 && rest === 0 ? <p style={emptyText}>Nada pendiente de otras noches.</p> : null}
      {groups.map((g) => (
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
      {earnings === null ? <p style={emptyText}>Cargando…</p> : null}
      {earnings !== null && items.length === 0 ? <p style={emptyText}>Nada en espera.</p> : null}
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
      {earnings === null ? <p style={emptyText}>Cargando…</p> : null}
      {earnings !== null && items.length === 0 ? <p style={emptyText}>Nada pendiente de cuadrar.</p> : null}
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
      {info === null ? <p style={emptyText}>No se ha podido cargar el detalle. Vuelve a entrar en Ganancias.</p> : null}
      {info !== null && open.length === 0 && rest === 0 ? <p style={emptyText}>No tienes nada que descontar.</p> : null}
      {open.length > 0 ? (
        <ul style={listStyle}>
          {open.map((d) => (
            <DebtItem key={d.id} debt={d} />
          ))}
        </ul>
      ) : null}
      {rest > 0 && info !== null ? (
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

function EarningList({ earnings, items, empty }: { earnings: MyEarning[] | null; items: MyEarning[]; empty?: string }) {
  if (earnings === null) return <p style={emptyText}>Cargando…</p>;
  if (items.length === 0) return empty ? <p style={emptyText}>{empty}</p> : null;
  return (
    <ul style={listStyle}>
      {items.map((e) => (
        <Item
          key={e.id}
          title={`${timeLabel(e.createdAt)} · ${e.paymentId ? 'Cobro' : 'Del saldo'}${e.payoutId ? ' · pagado' : e.bankHeld ? ' · pendiente de cuadrar' : ''}`}
          detail={earningDetail(e)}
          amount={formatSignedEur(e.netCents, { compact: true })}
          tone={e.netCents < 0 ? 'danger' : e.reversedCents > 0 ? 'warning' : 'text'}
        />
      ))}
    </ul>
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

function Head({ title, amount, tone = 'text', children }: { title: string; amount: string; tone?: Tone; children: ReactNode }) {
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <h2 style={kicker}>{title}</h2>
      <p className="np-num" style={{ ...bigAmount, color: TONE_COLOR[tone] }}>
        {amount}
      </p>
      <p style={explainStyle}>{children}</p>
    </header>
  );
}

function Item({ title, detail, amount, tone = 'text' }: { title: string; detail: string; amount: string; tone?: Tone }) {
  return (
    <li style={itemStyle}>
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 500 }}>{title}</p>
        <p style={metaText}>{detail}</p>
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

const metaText: CSSProperties = {
  margin: '0.125rem 0 0',
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const muted: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 500 };

const noteStyle: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-16)' };

const emptyText: CSSProperties = {
  margin: 0,
  padding: '1.5rem 0',
  textAlign: 'center',
  color: 'var(--np-text-mute)',
};
