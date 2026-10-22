'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReceptionOptions } from '@nightpay/contracts';
import { createPayment, fetchTerminals, getUser, type CreatedPayment } from '@/lib/api';
import { fetchPendingTopUps, startPendingTopUp } from '@/lib/api-noche';
import type { ChipTap } from '@/lib/chip-tap';
import { formatEur } from '@/lib/money';
import {
  receptionAttempt,
  receptionWhat,
  staffBackend,
  walletOfTarget,
  type PayMethod,
  type ReceptionAttempt,
} from '@/lib/reception';
import {
  deskTarget,
  fetchReceptionDesk,
  fichaText,
  loadedMoneyLine,
  quickAmounts,
  rechargeProblem,
  type ReceptionDeskSaldo,
} from '@/lib/reception-desk';
import { useVenueNight } from '@/lib/venue-methods';
import { AssignTopUp } from './AssignTopUp';
import { CodeBoxes, DeskBtn, DeskHead, Icon, NfcCard } from './desk/desk-parts';
import { DeskLoaded } from './desk/DeskLoaded';
import { TopUpQr, useRetirePayment } from './desk/TopUpQr';
import { useDeskNfc } from './desk/use-desk-nfc';
import { useShown } from './desk/use-shown';
import s from './desk/desk.module.css';
import { PendingTopUps } from './PendingTopUps';

/** El saldo encontrado: por su NFC (antes de cobrar) o por su código. */
interface Found {
  view: ReceptionDeskSaldo;
  nfc: { card: string; uid: string | null } | null;
}

type Step =
  | { kind: 'saldo' }
  | { kind: 'qr'; found: Found; amountCents: number | null; payment: CreatedPayment | null }
  /** Plan B: cobrar primero (sin su NFC) y asignarla después. */
  | { kind: 'planB'; amountCents: number | null; payment: CreatedPayment | null }
  | { kind: 'assign'; walletId: string; amountCents: number }
  | { kind: 'pending' }
  | { kind: 'done'; amountCents: number; method: PayMethod; code: string; detail: string };

interface Props {
  /** Volver a cobrar (sin él, no hay otra cosa que hacer en Inicio). */
  onExit?: () => void;
  /** Recarga cobrada: refrescar lo de la chica. */
  onDone: () => void;
}

/**
 * Inicio → «Recargar saldo» (maquetas 4.6 y 4.7), solo recepción: un saldo
 * que ya existe (los nuevos, en la pestaña Recepción).
 *   4.6 ¿De quién es el saldo? Su NFC (antes de cobrar: así la recarga va a
 *       su saldo y no se pierde) o su código; sale lo que tiene.
 *   4.7 El importe encima del QR (se cambia sin volver atrás) y que lo pague
 *       en su móvil; «Mejor en efectivo», un toque abajo.
 * Plan B, si su NFC no se lee: se cobra primero y la recarga queda pendiente
 * de asignar hasta que se acerca su NFC o se teclea su código (Pendientes de
 * asignar).
 */
export function TopUpExisting({ onExit, onDone }: Props) {
  const night = useVenueNight();
  const [options, setOptions] = useState<ReceptionOptions | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'saldo' });
  const [found, setFound] = useState<Found | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  // Una clave por recarga: repetir lo mismo (corte, doble toque) no carga dos veces.
  const attempt = useRef<ReceptionAttempt | null>(null);
  const retire = useRetirePayment();

  useEffect(() => {
    staffBackend
      .options()
      .then(setOptions)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (step.kind !== 'saldo') return undefined;
    let alive = true;
    fetchPendingTopUps()
      .then((rows) => alive && setPending(rows.length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [step.kind]);

  // 4.6: su NFC se lee solo, sin tocar nada (y sin grabar: solo saldos que ya
  // existen); solo con Inicio a la vista (en otra pestaña lo usaría a la vez).
  const [shownRef, shown] = useShown();
  const nfc = useDeskNfc(shown && step.kind === 'saldo' && !busy && options?.nfc !== false, false, onTap, setError);
  const amounts = quickAmounts(night.receptionQuickAmountsCents);
  const user = getUser();
  const name = user?.displayName ?? 'Recepción';

  function go(next: Step): void {
    setError(null);
    setStep(next);
  }

  function restart(): void {
    attempt.current = null;
    setFound(null);
    setCode('');
    go({ kind: 'saldo' });
  }

  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function take(view: Awaited<ReturnType<typeof fetchReceptionDesk>>, card: Found['nfc']): void {
    if (view.kind === 'new') throw new Error('Este NFC es nuevo, sin saldo: dale de alta en Recepción.');
    const problem = rechargeProblem(view);
    if (problem) throw new Error(problem);
    setFound({ view, nfc: card });
  }

  async function onTap(tap: ChipTap): Promise<void> {
    if (!tap.token) return setError(tap.other ? 'Este NFC tiene otra cosa grabada: no es de un saldo.' : 'Este NFC está en blanco: los saldos nuevos, en Recepción.');
    const card = { card: tap.token, uid: tap.uid };
    await run(async () => take(await fetchReceptionDesk(card.uid ? { card: card.card, uid: card.uid } : { card: card.card }), card));
  }

  function onCode(next: string): void {
    setCode(next);
    setFound(null);
    setError(null);
    if (next.length === 6) void run(async () => take(await fetchReceptionDesk({ code: next }), null));
  }

  function keyFor(amountCents: number, method: PayMethod, f: Found): string {
    attempt.current = receptionAttempt(attempt.current, receptionWhat(amountCents, method, deskTarget(f.view, f.nfc)));
    return attempt.current.key;
  }

  /** 4.7: otro importe encima del QR (o el primero): se retira el QR anterior y sale otro. */
  async function cardFor(f: Found, amountCents: number, old: CreatedPayment | null): Promise<void> {
    await retire(old);
    go({ kind: 'qr', found: f, amountCents, payment: null });
    const terminal = (await fetchTerminals())[0]?.externalId;
    if (!terminal) throw new Error('No hay terminales configurados en el local');
    const payment = await createPayment({ amountCents, terminalExternalId: terminal, idempotencyKey: keyFor(amountCents, 'card', f), walletId: f.view.walletId });
    setStep({ kind: 'qr', found: f, amountCents, payment });
  }

  /** «Mejor en efectivo»: se retira el QR y se cobra en efectivo (es recepción). */
  async function cash(f: Found, amountCents: number, payment: CreatedPayment | null, qrSettled: boolean): Promise<void> {
    // Si ya lo pagó, el servidor no deja retirarlo (y sale su CARGADO).
    if (!qrSettled) await retire(payment);
    setStep({ kind: 'qr', found: f, amountCents, payment: null });
    const target = deskTarget(f.view, f.nfc);
    const out = await staffBackend.cash({ amountCents, idempotencyKey: keyFor(amountCents, 'cash', f), wallet: walletOfTarget(target) });
    onDone();
    attempt.current = null;
    go({ kind: 'done', amountCents, method: 'cash', code: out.code, detail: `Saldo ${out.code} · tiene ${formatEur(out.balanceCents, { compact: true })}` });
  }

  /** Plan B: cobrar primero (tarjeta) una recarga pendiente de asignar. */
  async function payFirst(amountCents: number, old: CreatedPayment | null): Promise<void> {
    await retire(old);
    go({ kind: 'planB', amountCents, payment: null });
    const what = receptionWhat(amountCents, 'card', { kind: 'new' });
    attempt.current = receptionAttempt(attempt.current, `pendiente|${what}`);
    setStep({ kind: 'planB', amountCents, payment: await startPendingTopUp(amountCents, attempt.current.key) });
  }

  const sub = `${name} · recepción`;
  const chip = { section: 'saldo', label: 'Recarga' };

  if (step.kind === 'done') {
    return (
      <DeskLoaded
        word="CARGADO"
        amountCents={step.amountCents}
        reference={step.code}
        money={{ icon: step.method, ...loadedMoneyLine(step.method, step.amountCents) }}
        meta={step.detail}
        primary={{ label: 'Otra recarga', onClick: restart }}
        secondary={onExit ? { label: 'Volver a cobrar', onClick: onExit } : null}
      />
    );
  }

  if (step.kind === 'assign') {
    return (
      <AssignTopUp
        walletId={step.walletId}
        amountCents={step.amountCents}
        onAssigned={(out) =>
          go({ kind: 'done', amountCents: out.amountCents, method: 'card', code: out.codeHint, detail: `Saldo ${out.codeHint} · tiene ${formatEur(out.balanceCents, { compact: true })}` })
        }
        onLater={restart}
      />
    );
  }

  if (step.kind === 'pending') return <PendingTopUps onDone={restart} />;

  if (step.kind === 'qr') {
    const { found: f, payment, amountCents } = step;
    const has = formatEur(f.view.balanceCents, { compact: true });
    return (
      <div className={s.screen} data-charge-open="">
        <TopUpQr
          head={
            <DeskHead
              title="Recargar saldo"
              sub={`Para ${f.view.code} · tiene ${has}`}
              chip={chip}
              stripe="hold"
              onBack={() =>
                void run(async () => {
                  await retire(payment);
                  go({ kind: 'saldo' });
                })
              }
            />
          }
          spot="cobro"
          payment={payment}
          amountCents={amountCents}
          amounts={amounts}
          changing={busy}
          forWhom={`Se carga en ${f.view.code}.`}
          onAmount={(cents) => void run(() => cardFor(f, cents, payment))}
          onPaid={(paid) => {
            onDone();
            attempt.current = null;
            go({
              kind: 'done',
              amountCents: paid.amountCents,
              method: 'card',
              code: f.view.code,
              detail: `Saldo ${f.view.code} · tiene ${formatEur(f.view.balanceCents + paid.amountCents, { compact: true })}`,
            });
          }}
          onRetry={() => {
            attempt.current = null;
            void run(() => cardFor(f, amountCents ?? 0, null));
          }}
          onCash={options?.cash && amountCents !== null ? (qrSettled) => void run(() => cash(f, amountCents, payment, qrSettled)) : undefined}
          cashBusy={busy}
          onBack={() => go({ kind: 'saldo' })}
          error={error}
        />
      </div>
    );
  }

  if (step.kind === 'planB') {
    const { payment, amountCents } = step;
    return (
      <div className={s.screen} data-charge-open="">
        <TopUpQr
          head={
            <DeskHead
              title="Cobrar primero"
              sub="Se asigna después"
              chip={chip}
              stripe="hold"
              onBack={() =>
                void run(async () => {
                  await retire(payment);
                  go({ kind: 'saldo' });
                })
              }
            />
          }
          spot="cobro"
          payment={payment}
          amountCents={amountCents}
          amounts={amounts}
          changing={busy}
          forWhom="Después, su NFC o su código: se suma a su saldo."
          onAmount={(cents) => void run(() => payFirst(cents, payment))}
          onPaid={(paid) => {
            onDone();
            if (paid.walletId) go({ kind: 'assign', walletId: paid.walletId, amountCents: paid.amountCents });
          }}
          onRetry={() => {
            attempt.current = null;
            void run(() => payFirst(amountCents ?? 0, null));
          }}
          onBack={() => go({ kind: 'saldo' })}
          error={error}
        />
      </div>
    );
  }

  // 4.6 ¿De quién es el saldo?
  const nfcOn = options?.nfc !== false;
  const noReader = !nfc.reader.loading && !nfc.reader.via ? nfc.reader.note : null;
  return (
    // data-charge-open: en el móvil, el saludo de Inicio se aparta (esta pantalla trae su cabecera).
    <div className={s.screen} data-charge-open="" ref={shownRef}>
      <DeskHead title="Recargar saldo" sub={sub} chip={chip} stripe="hold" onBack={onExit} />
      <span className={s.kick}>¿De quién es el saldo?</span>
      {nfcOn ? (
        <button type="button" className={`${s.det} ${s.detLime}`} onClick={nfc.stopped ? nfc.restart : undefined} aria-live="polite">
          <NfcCard size="s" />
          <span className={s.grow}>
            <b>{nfc.stopped ? 'Toca para leer su NFC' : 'Acerca su NFC'}</b>
            <span>{noReader ?? nfc.stopped ?? 'Antes de cobrar, para que la recarga vaya a su NFC'}</span>
          </span>
        </button>
      ) : null}
      {nfcOn ? <p className={s.orline}>o con el código</p> : <span className={s.kick}>Su código</span>}
      <CodeBoxes value={code} onChange={onCode} disabled={busy} />
      {busy ? <p className={s.lbl}>Buscando…</p> : null}
      {found ? (
        <div className={s.found}>
          <span className={s.okc}>
            <Icon name="check" />
          </span>
          <div className={s.grow}>
            <b>Saldo {found.view.code}</b>
            <span>
              Tiene {formatEur(found.view.balanceCents, { compact: true })}
              {found.view.fichaNumber !== null ? ` · ${fichaText(found.view.printedNumber)}` : ''}
            </span>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
      <div className={s.links}>
        {options?.card ? (
          <button type="button" className={s.txtlink} disabled={busy} onClick={() => go({ kind: 'planB', amountCents: null, payment: null })}>
            ¿No se lee su NFC? Cobrar primero y asignarlo después
          </button>
        ) : null}
        <button type="button" className={`${s.txtlink} ${pending > 0 ? s.txtlinkOn : ''}`} onClick={() => go({ kind: 'pending' })}>
          {pending > 0 ? `Pendientes de asignar (${pending})` : 'Pendientes de asignar'}
        </button>
      </div>
      <div className={`${s.foot} ${s.footSolid}`}>
        <DeskBtn kind="pri" label="Seguir" disabled={!found} onClick={() => found && go({ kind: 'qr', found, amountCents: null, payment: null })} />
      </div>
    </div>
  );
}
