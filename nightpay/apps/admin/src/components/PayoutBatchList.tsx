'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Checkbox, EmptyState, IconButton, Importe, Skeleton } from '@nightpay/ui';
import type { PayoutBatchProblem } from '@nightpay/contracts';
import { fetchApprovalRules, fetchMyPermissions, fetchOperators, type Operator } from '@/lib/api';
import { payoutHoldNote } from '@/lib/bank-holds';
import { holderNotice } from '@/lib/payout-account-view';
import {
  BATCH_2FA_TEXT,
  BATCH_LOST_TEXT,
  BATCH_MAX,
  NO_PERMISSION_TEXT,
  NEEDS_2FA_TEXT,
  allToggle,
  barText,
  batchAccess,
  keepTicked,
  methodWord,
  payoutModeFor,
  personName,
  problemText,
  rowState,
  tickAll,
  tickDisabled,
  type BatchAccess,
  type RowState,
} from '@/lib/payout-batch';
import type { TabKey } from '@/lib/roles';
import { useApprovals } from '@/lib/use-approvals';
import { useStepUpMethod } from '@/lib/use-step-up-method';
import { useVenueTimezone } from '@/lib/venue-context';
import { useFichas } from './fichas/fichas-context';
import { PayoutBatchReview, type BatchAfter, type BatchItem } from './PayoutBatchReview';
import { PayoutConfirmModal } from './PayoutConfirmModal';

interface Props {
  isOwner: boolean;
  /** «Decidir» (a Avisos) e «Ir a Seguridad». */
  onNavigate?: (tab: TabKey) => void;
}

interface Person {
  op: Operator;
  waiter: boolean;
  name: string;
}

interface Loaded {
  people: Person[];
  /** Qué lista falló (la otra se enseña). */
  failed: 'girls' | 'waiters' | 'both' | null;
  rule: string | undefined;
  /** Permiso «pagos» del encargado; undefined si no se pudo saber. */
  canPay: boolean | undefined;
}

const SKELETON_ROWS = 5;
/** Tras un lote sin respuesta: lo que se espera antes de volver a cargar y poder repetir. */
export const UNCERTAIN_WAIT_MS = 60_000;

/**
 * «A quién hay que pagar»: las compañeras y los camareros con algo que cobrar
 * ya, por nombre. El dueño (o el encargado que paga directo) marca a quién y
 * repasa y confirma con un solo código. Se carga al entrar, al volver del
 * repaso, con «Entendido» y tras un pago suelto; nunca sola, para que nada se
 * mueva mientras se marca.
 */
export function PayoutBatchList({ isOwner, onNavigate }: Props) {
  const tz = useVenueTimezone();
  const fichas = useFichas();
  const { pending } = useApprovals();
  const method = useStepUpMethod(true);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [ticked, setTicked] = useState<Map<string, number>>(new Map());
  /** Lo que dio problema en el último repaso: su texto, hasta la próxima carga. */
  const [notes, setNotes] = useState<Map<string, PayoutBatchProblem>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [payFor, setPayFor] = useState<Person | null>(null);
  /** Cuándo quedó sin respuesta el último lote; null cuando ya se ha vuelto a cargar pasado el minuto. */
  const [uncertainSince, setUncertainSince] = useState<number | null>(null);
  const generation = useRef(0);

  async function load(after?: BatchAfter, clearsUncertain = false): Promise<void> {
    const gen = ++generation.current;
    setLoading(true);
    const [girls, waiters, rules, perms] = await Promise.allSettled([
      fetchOperators(),
      fetchOperators('WAITER'),
      isOwner ? Promise.resolve(null) : fetchApprovalRules(),
      isOwner ? Promise.resolve(null) : fetchMyPermissions(),
    ]);
    if (gen !== generation.current) return;
    const people: Person[] = [
      ...(girls.status === 'fulfilled' ? girls.value.map((op) => ({ op, waiter: false })) : []),
      ...(waiters.status === 'fulfilled' ? waiters.value.map((op) => ({ op, waiter: true })) : []),
    ]
      .filter(({ op }) => (op.balance.availableCents ?? op.balance.pendingCents) > 0)
      .map((p) => ({ ...p, name: personName(p.op, p.waiter) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const failed =
      girls.status === 'rejected' && waiters.status === 'rejected'
        ? 'both'
        : girls.status === 'rejected'
          ? 'girls'
          : waiters.status === 'rejected'
            ? 'waiters'
            : null;
    const problemNotes = new Map((after?.notes ?? []).map((p) => [p.operatorId, p]));
    const nowCents = new Map(people.map(({ op }) => [op.id, op.balance.availableCents ?? -1]));
    setData({
      people,
      failed,
      rule: rules.status === 'fulfilled' ? rules.value?.payout : undefined,
      canPay: isOwner ? true : perms.status === 'fulfilled' ? perms.value?.payouts : undefined,
    });
    setTicked((prev) => keepTicked(prev, nowCents, new Set([...problemNotes.keys(), ...(after?.untick ?? [])])));
    setNotes(problemNotes);
    setNotice(after?.notice ?? null);
    if (clearsUncertain && failed === null) setUncertainSince(null);
    setLoading(false);
  }

  /** «Volver a cargar la lista» del aviso: solo cuenta pasado el minuto y si cargan las dos listas. */
  function reloadAfterUncertain(): void {
    void load(undefined, uncertainSince !== null && Date.now() - uncertainSince >= UNCERTAIN_WAIT_MS);
  }

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [isOwner]);

  // Pendientes de aprobar (solo el dueño las ve): de quién es cada una.
  const pendingBy = useMemo(() => {
    const m = new Map<string, string>();
    if (!isOwner) return m;
    for (const a of pending ?? []) {
      if (a.kind === 'PAYOUT' && a.status === 'PENDING') m.set(a.payout.operatorId, a.requestedBy.name);
    }
    return m;
  }, [isOwner, pending]);

  const access: BatchAccess = data ? batchAccess({ isOwner, rule: data.rule, canPay: data.canPay, method }) : 'look';
  const mode = payoutModeFor(isOwner, data?.rule);
  const now = Date.now();
  const rows = (data?.people ?? []).map((p) => ({ ...p, state: rowState(p.op, now, pendingBy.get(p.op.id)) }));
  const tickable = access === 'tick' ? rows.filter((r) => r.state.kind === 'tick') : [];
  const tickableIds = tickable.map((r) => r.op.id);
  const centsOf = new Map(tickable.map((r) => [r.op.id, (r.state as { cents: number }).cents]));
  // Solo cuentan las que siguen en la lista y marcables.
  const marked = new Map([...ticked].filter(([id]) => centsOf.has(id)));
  const all = allToggle(tickableIds, marked);

  function toggle(id: string, on: boolean): void {
    setTicked((prev) => {
      const next = new Map([...prev].filter(([k]) => centsOf.has(k)));
      const cents = centsOf.get(id);
      if (on && cents !== undefined && next.size < BATCH_MAX) next.set(id, cents);
      else next.delete(id);
      return next;
    });
  }

  const reviewItems: BatchItem[] = tickable
    .filter((r) => marked.has(r.op.id))
    .map(({ op, name }) => {
      const holder = holderNotice(op);
      return {
        operatorId: op.id,
        name,
        method: op.payoutMethod!,
        accountMasked: op.payoutAddressMasked!,
        cents: marked.get(op.id)!,
        ...(holder?.tone === 'warning' ? { holderWarning: holder.text } : {}),
        ...(payoutHoldNote(op.balance) ? { bankHeldNote: payoutHoldNote(op.balance)! } : {}),
      };
    });

  function afterReview(after: BatchAfter): void {
    setReviewing(false);
    if (after.uncertain) setUncertainSince(Date.now());
    void load(after);
  }

  const failedText =
    data?.failed === 'waiters' ? 'No se pudieron cargar los camareros.' : data?.failed === 'girls' ? 'No se pudieron cargar las compañeras.' : null;

  return (
    <section className="np-lote" aria-busy={loading && !data ? 'true' : undefined}>
      <div className="np-lote-head">
        <h3 className="np-lote-title">A quién hay que pagar</h3>
        <Button variant="quiet" size="sm" onClick={() => void load()} disabled={loading}>
          Volver a cargar
        </Button>
      </div>

      {uncertainSince !== null ? (
        <Banner tone="warning" action={loading ? undefined : { label: 'Volver a cargar la lista', onClick: reloadAfterUncertain }}>
          {BATCH_LOST_TEXT}
        </Banner>
      ) : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}
      {data && access === 'one-by-one' ? (
        <Banner tone="info" action={onNavigate ? { label: 'Ir a Seguridad', onClick: () => onNavigate('security') } : undefined}>
          {BATCH_2FA_TEXT}
        </Banner>
      ) : null}
      {data && access === 'needs-2fa' ? (
        <Banner tone="info" action={onNavigate ? { label: 'Ir a Seguridad', onClick: () => onNavigate('security') } : undefined}>
          {NEEDS_2FA_TEXT}
        </Banner>
      ) : null}
      {data && access === 'request' ? <Banner tone="info">En este local los pagos los aprueba el dueño</Banner> : null}
      {data && access === 'no-permission' ? <Banner tone="neutral">{NO_PERMISSION_TEXT}</Banner> : null}

      {!data ? (
        <ul className="np-lote-list">
          <li className="np-sr-only" role="status">
            Cargando…
          </li>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <li key={i} className="np-lote-row np-lote-skel">
              <Skeleton height="1.25rem" />
            </li>
          ))}
        </ul>
      ) : data.failed === 'both' ? (
        <Banner tone="warning" action={{ label: 'Reintentar', onClick: () => void load() }}>
          No se pudo cargar a quién hay que pagar.
        </Banner>
      ) : (
        <>
          {failedText ? (
            <Banner tone="warning" action={{ label: 'Reintentar', onClick: () => void load() }}>
              {failedText}
            </Banner>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState icon="check" title="No hay nada que pagar ahora" />
          ) : (
            <ul className="np-lote-list" data-tick={access === 'tick' ? '' : undefined}>
              {tickable.length > 0 ? (
                <li className="np-lote-row np-lote-all">
                  <div className="np-lote-main">
                    <Checkbox
                      label="Todas"
                      hint={tickable.length > BATCH_MAX ? `Como mucho ${BATCH_MAX} de una vez` : undefined}
                      checked={all.checked}
                      indeterminate={all.indeterminate}
                      onChange={() => setTicked(tickAll(tickableIds, centsOf, marked))}
                    />
                  </div>
                </li>
              ) : null}
              {rows.map((r) => (
                <Row
                  key={r.op.id}
                  person={r}
                  state={r.state}
                  access={access}
                  checked={marked.has(r.op.id)}
                  disabled={tickDisabled(r.op.id, marked)}
                  note={notes.get(r.op.id)}
                  tz={tz}
                  onToggle={(on) => toggle(r.op.id, on)}
                  onPay={() => setPayFor(r)}
                  onDecide={onNavigate ? () => onNavigate('incidents') : undefined}
                  onOpen={fichas ? () => fichas.openOperator(r.op.id, () => void load()) : undefined}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {data && access === 'tick' && tickable.length > 0 ? (
        <div className="np-lote-bar" data-np-foot="">
          <span className="np-lote-bar-text">{barText(marked)}</span>
          <Button size="lg" disabled={marked.size === 0 || loading || uncertainSince !== null} onClick={() => setReviewing(true)}>
            Repasar y pagar
          </Button>
        </div>
      ) : null}

      <PayoutBatchReview open={reviewing} items={reviewItems} method={method} onClose={() => afterReview({})} onDone={afterReview} />

      {payFor ? (
        <PayoutConfirmModal
          operatorId={payFor.op.id}
          operatorName={payFor.op.displayName ?? payFor.op.email}
          balanceCents={payFor.op.balance.availableCents ?? payFor.op.balance.pendingCents}
          bankHeld={{ bankHeldCents: payFor.op.balance.bankHeldCents, bankHeldCount: payFor.op.balance.bankHeldCount }}
          payoutMethod={payFor.op.payoutMethod ?? null}
          payoutAddressMasked={payFor.op.payoutAddressMasked ?? null}
          payoutHolderMasked={payFor.op.payoutHolderMasked ?? null}
          payoutHolderMismatch={(payFor.op.payoutHolderMismatch ?? false) && !payFor.op.legalNameMasked}
          payoutHolderUnconfirmed={payFor.op.payoutHolderUnconfirmed ?? false}
          payoutHoldUntil={payFor.op.payoutHoldUntil ?? null}
          canReveal={isOwner}
          payoutLabel={payFor.op.payoutLabel ?? null}
          mode={mode ?? 'pay'}
          onClose={() => setPayFor(null)}
          onDone={() => {
            setPayFor(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function Row({
  person,
  state,
  access,
  checked,
  disabled,
  note,
  tz,
  onToggle,
  onPay,
  onDecide,
  onOpen,
}: {
  person: Person;
  state: RowState;
  access: BatchAccess;
  checked: boolean;
  disabled: boolean;
  note: PayoutBatchProblem | undefined;
  tz: string;
  onToggle: (on: boolean) => void;
  onPay: () => void;
  onDecide?: () => void;
  onOpen?: () => void;
}) {
  const { op, name } = person;
  const cents = op.balance.availableCents ?? op.balance.pendingCents;
  const hint = op.payoutMethod && op.payoutMethod !== 'MANUAL_CASH' && op.payoutAddressMasked ? `${methodWord(op.payoutMethod)} · ${op.payoutAddressMasked}` : null;
  const holder = holderNotice(op);
  const holderWarning = holder?.tone === 'warning' && !op.payoutHolderUnconfirmed ? holder.text : null;
  const tick = access === 'tick' && state.kind === 'tick';

  // Lo que se dice debajo y el botón de la fila (si lo hay).
  let why: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  if (state.kind === 'pending') {
    why = `Te lo ha pedido ${state.by}: decídelo en Avisos`;
    if (onDecide) action = { label: 'Decidir', onClick: onDecide };
  } else if (access === 'request') {
    if (state.kind === 'blocked') why = problemText(state, { tz });
    action = { label: 'Pedir al dueño', onClick: onPay };
  } else if (access === 'tick' || access === 'one-by-one') {
    if (state.kind === 'blocked') why = problemText(state, { tz });
    if (!tick) action = { label: 'Pagar', onClick: onPay };
  }

  return (
    <li className="np-lote-row">
      <div className="np-lote-main">
        {tick ? (
          <Checkbox label={name} hint={hint ?? undefined} checked={checked} disabled={disabled} onChange={onToggle} />
        ) : (
          <div className="np-lote-text">
            <span className="np-lote-name">{name}</span>
            {hint ? <span className="np-lote-hint">{hint}</span> : null}
          </div>
        )}
        {holderWarning ? (
          <p className="np-lote-note" data-tone="warning">
            {holderWarning}
          </p>
        ) : null}
        {why ? <p className="np-lote-note">{why}</p> : null}
        {note ? (
          <p className="np-lote-note" data-tone="danger">
            {problemText(note, { tz, expectedCents: undefined })}
          </p>
        ) : null}
      </div>
      <Importe cents={cents} size="row" decimals="always" className="np-lote-amount" />
      {action ? (
        <Button variant="ghost" size="sm" className="np-lote-action" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {onOpen ? <IconButton icon="chevron-right" label={`Ver ficha de ${op.displayName ?? op.email}`} onClick={onOpen} /> : null}
    </li>
  );
}
