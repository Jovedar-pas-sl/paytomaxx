'use client';

import { useState } from 'react';
import { AmountKeypad, Input } from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import type { RecentTopUp } from '@nightpay/contracts';
import { methodArmed, recentTopUpLine, type EntryRow, type MethodButton, type ExitPlan } from '@/lib/reception-desk';
import { cashConfirmText, cashInHandText, turnPhoneText } from '@/lib/reception-help';
import { CodeBoxes, DESK_FIELD, DeskBtn, DeskRowView, FichaNumber, Icon, NfcMark } from './desk-parts';
import s from './desk.module.css';

/** La pregunta de un paso («¿Cuánto carga?»); su ayuda es el tutorial del «?» de la cabecera. */
function StepQuestion({ text }: { text: string }) {
  return (
    <div className={s.qBlock}>
      <p className={s.q}>{text}</p>
    </div>
  );
}

/**
 * 4.1 (y 4.5 sin nada leído): «Acerca el NFC», sin tocar nada. Un error, un
 * aviso o el lector parado van en su lugar.
 */
export function TapStage(props: {
  mode: 'entrada' | 'salida';
  /** Este móvil no lee fichas (iPhone…): en vez de pedir que la acerquen, lo que se puede hacer aquí. */
  noReader: { title: string; text: string } | null;
  /** El lector se paró: un toque lo vuelve a poner. */
  stopped: string | null;
  onRestart: () => void;
  busy: boolean;
  error: string | null;
  /** «Guardado: R3D-8LP sigue con 35 €»: lo último que se hizo. */
  notice?: string | null;
}) {
  const status = props.stopped ?? props.noReader?.text ?? null;
  const mark = props.noReader ? null : <NfcMark size="l" />;
  const words = (
    <>
      <p className={s.stageTitle}>{props.noReader?.title ?? (props.busy ? 'Leyendo…' : 'Acerca el NFC')}</p>
      {props.error ? (
        <p role="alert" className={s.stageError}>
          {props.error}
        </p>
      ) : props.notice ? (
        <p role="status" className={s.stageNotice}>
          {props.notice}
        </p>
      ) : status ? (
        <p className={s.stageText}>{status}</p>
      ) : null}
    </>
  );
  // Web NFC pide el permiso con un toque: entonces el escenario es el botón.
  if (props.stopped) {
    return (
      <button type="button" className={s.stage} onClick={props.onRestart} aria-label="Tocar para leer el NFC">
        {mark}
        {words}
      </button>
    );
  }
  // Se anuncia lo que cambia solo (leyendo, un error, un aviso).
  return (
    <div className={s.stage} data-tour="recep-nfc">
      {mark}
      <div className={s.stageLive} aria-live="polite" aria-busy={props.busy || undefined}>
        {words}
      </div>
    </div>
  );
}

/**
 * 4.2: la ficha leída, con su número en grande (A1), y los importes rápidos en
 * rejilla de 72 px, con «Otro» de última casilla: tocar uno ya sigue.
 */
export function AmountStep(props: {
  row: EntryRow;
  /** La última recarga, si es reciente (A4): «Cargada hace 2 min: 50 € en efectivo (Sergio)». */
  lastTopUp?: RecentTopUp | null;
  /** Lo leído es una ficha («Cargada») o un saldo sin ficha («Cargado»). */
  hasFicha?: boolean;
  amounts: readonly number[];
  onPick: (cents: number) => void;
  onOther: () => void;
  /** Encargado o dueño ante una ficha sin PIN: que lo elija sin tener que cargar nada. */
  onPin?: () => void;
  /** Un saldo sin ficha, por su código (A7): «Darle una» lleva a «Dar ficha a un saldo» con su código. */
  onGiveFicha?: () => void;
}) {
  // La hora a la que salió la pantalla: «hace 2 min» no cambia mientras se mira.
  const [shownAt] = useState(() => Date.now());
  const recent = recentTopUpLine(props.lastTopUp, shownAt, props.hasFicha ?? true);
  return (
    <>
      <DeskRowView title={props.row.title} detail={props.row.detail} ficha={props.row.ficha} tour="recep-ficha">
        {props.row.hint ? <span className={s.rowHint}>{props.row.hint}</span> : null}
        {props.row.ask ? <span className={s.rowHint}>{props.row.ask}</span> : null}
        {props.onGiveFicha ? (
          <button type="button" className={s.rowAction} onClick={props.onGiveFicha}>
            Darle una
          </button>
        ) : null}
        {recent ? (
          <span className={s.rowRecent}>
            <Icon name="clock" />
            {recent}
          </span>
        ) : null}
      </DeskRowView>
      <StepQuestion text="¿Cuánto carga?" />
      <div className={s.quick} data-tour="recep-importes">
        {props.amounts.map((c) => (
          <button key={c} type="button" className={s.qb} onClick={() => props.onPick(c)}>
            {formatEur(c, { compact: true })}
          </button>
        ))}
        <button type="button" className={`${s.qb} ${s.qbOther}`} aria-label="Otro importe" onClick={props.onOther}>
          Otro
        </button>
      </div>
      {props.onPin ? <DeskBtn kind="gho" label="Que elija su PIN" onClick={props.onPin} tour="recep-pin" /> : null}
    </>
  );
}

/** «Otro importe»: el teclado de siempre y seguir. */
export function KeypadStep({ onDone }: { onDone: (cents: number) => void }) {
  const [cents, setCents] = useState(0);
  return (
    <>
      <AmountKeypad valueCents={cents} onChange={setCents} maxCents={MAX_TYPED_AMOUNT_CENTS} label="Importe a cargar" />
      <DeskBtn
        kind="pri"
        label={cents > 0 ? `Seguir con ${formatEur(cents, { compact: true })}` : 'Pon el importe'}
        disabled={cents <= 0}
        onClick={() => onDone(cents)}
      />
    </>
  );
}

/** Los dos botones de «¿Cómo paga?»: el de efectivo dice que el dinero ya está en la mano (A2). */
function methodText(method: 'cash' | 'card', chargeCents: number) {
  return method === 'cash'
    ? { icon: 'cash' as const, label: 'Efectivo', small: cashInHandText(chargeCents) }
    : { icon: 'card' as const, label: 'Tarjeta', small: 'Paga con el QR en su móvil' };
}

/**
 * 4.3: el importe y la ficha en grande (A1), «¿Cómo paga?» en dos filas
 * iguales (la de por defecto, primera y en lima), y la nota del PIN.
 */
export function MethodStep(props: {
  chip: string;
  amountCents: number;
  /** El número impreso de la ficha, en grande debajo del importe (null: sin ficha o sin número). */
  ficha?: string | null;
  /** Lo que paga el cliente (el saldo + la comisión del servicio): «Ya tengo los 56 € en la mano». */
  chargeCents: number;
  /** Con la «Comisión del servicio»: «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)». */
  feeText?: string | null;
  buttons: MethodButton[];
  /** null: no sale (ya tiene PIN). */
  pinNote: string | null;
  busy: boolean;
  onPick: (method: 'cash' | 'card') => void;
  blocked: string | null;
  loading: boolean;
}) {
  const problems = props.buttons.filter((b) => b.problem).map((b) => b.problem);
  // Cuándo salió esta pantalla: un toque en el primer medio segundo es el
  // segundo de un doble toque en el importe, no «Efectivo» (S-1a).
  const [armedAt] = useState(() => Date.now());
  return (
    <>
      {/* s.methodTop: las opciones empiezan por debajo de donde estaban los importes. */}
      <div className={s.methodTop} data-ficha={props.ficha ? 'true' : undefined}>
        <div className={s.bigamt} data-tour="recep-total">
          <span className="np-chip" data-dashed="true">
            {props.chip}
          </span>
          <p className={s.bignum}>{formatEur(props.amountCents, { compact: true })}</p>
          {props.feeText ? <p className={s.lbl}>{props.feeText}</p> : null}
          {props.ficha ? (
            <>
              <span className={s.kick} aria-hidden="true">
                Ficha
              </span>
              <FichaNumber printed={props.ficha} className={s.cobroFicha} />
            </>
          ) : null}
          {/* Se enseña al cliente (A5): el importe y su ficha, antes de cobrar. */}
          <p className={s.turn}>
            <Icon name="phone" />
            {turnPhoneText(Boolean(props.ficha))}
          </p>
        </div>
        <StepQuestion text="¿Cómo paga?" />
      </div>
      {props.loading ? <p className={s.lbl}>Cargando…</p> : null}
      {props.blocked ? (
        <p role="alert" className={s.error}>
          {props.blocked}
        </p>
      ) : null}
      {props.buttons.map((b, i) => {
        const t = methodText(b.method, props.chargeCents);
        return (
          <DeskBtn
            key={b.method}
            tour={i === 0 ? 'recep-metodos' : undefined}
            kind={b.primary ? 'pri' : 'gho'}
            icon={t.icon}
            label={t.label}
            small={t.small}
            disabled={b.problem !== null || props.blocked !== null}
            busy={props.busy}
            onClick={() => {
              if (methodArmed(armedAt, Date.now())) props.onPick(b.method);
            }}
          />
        );
      })}
      {[...new Set(problems)].map((p) => (
        <p key={p} className={s.lbl}>
          {p}
        </p>
      ))}
      {props.pinNote ? (
        <p className={s.note} data-tour="recep-nota">
          <Icon name="lock" />
          {props.pinNote}
        </p>
      ) : null}
    </>
  );
}

/**
 * B2: el efectivo se confirma acercando otra vez la misma ficha (otra no
 * vale: solo avisa). Si no se lee, «Cargar sin leerla», que queda apuntado.
 * El primer medio segundo no atiende toques: el segundo de un doble toque en
 * «Efectivo» no cae en «Cargar sin leerla» (como S-1a).
 */
export function CashConfirmStep(props: {
  amountCents: number;
  /** Lo que paga el cliente (con la comisión del servicio, si la hay). */
  chargeCents: number;
  ficha: string | null;
  busy: boolean;
  onManual: () => void;
}) {
  const [armedAt] = useState(() => Date.now());
  return (
    <>
      <div className={s.bigamt}>
        <span className={s.kick}>Efectivo</span>
        <p className={s.bignum}>{formatEur(props.chargeCents, { compact: true })}</p>
        {props.ficha ? (
          <>
            <span className={s.kick} aria-hidden="true">
              Ficha
            </span>
            <FichaNumber printed={props.ficha} className={s.cobroFicha} />
          </>
        ) : null}
      </div>
      <div className={s.stage}>
        <NfcMark size="l" />
        <div className={s.stageLive} aria-live="polite" aria-busy={props.busy || undefined}>
          <p className={s.stageTitle}>{props.busy ? 'Cargando…' : 'Acerca otra vez la ficha'}</p>
          <p className={s.stageText}>{cashConfirmText(props.amountCents)}</p>
        </div>
      </div>
      <DeskBtn
        kind="gho"
        label="Cargar sin leerla"
        small="Si no se lee: queda apuntado"
        busy={props.busy}
        onClick={() => {
          if (methodArmed(armedAt, Date.now())) props.onManual();
        }}
      />
    </>
  );
}

/** 4.5: a la salida, lo que le queda; guardar (de fábrica, en lima) o devolverlo en efectivo. */
export function ExitStep(props: {
  row: { title: string; detail: string };
  plan: ExitPlan;
  busy: boolean;
  onKeep: () => void;
  onRefund: () => void;
  onReadNfc?: () => void;
}) {
  const { plan } = props;
  return (
    <>
      <DeskRowView title={props.row.title} detail={props.row.detail} />
      <div className={s.bigamt} data-tour="recep-quedan">
        <span className={s.kick}>{plan.balanceCents > 0 ? 'Le quedan' : 'No le queda saldo'}</span>
        <p className={s.bignum}>{formatEur(plan.balanceCents, { compact: true })}</p>
      </div>
      <DeskBtn kind="pri" label="Guardar para la próxima" small={plan.keepDetail} onClick={props.onKeep} disabled={props.busy} tour="recep-guardar" />
      {plan.refundLabel ? (
        <DeskBtn
          kind="gho"
          label={plan.refundLabel}
          small={plan.refundBlocked ?? plan.refundDetail}
          onClick={props.onRefund}
          disabled={plan.refundBlocked !== null}
          busy={props.busy}
          tour="recep-devolver"
        />
      ) : null}
      {plan.note && !plan.refundBlocked?.includes(plan.note) ? <p className={s.lbl}>{plan.note}</p> : null}
      {props.onReadNfc ? <DeskBtn kind="gho" label="Acercar NFC original" onClick={props.onReadNfc} disabled={props.busy} /> : null}
    </>
  );
}

/**
 * Buscar por el número impreso en la ficha (tal cual, con sus ceros): solo
 * para un saldo que ya existe. Una ficha nueva se carga acercándola.
 */
export function NumberStep({ busy, error, onFind }: { busy: boolean; error: string | null; onFind: (number: string) => void }) {
  const [number, setNumber] = useState('');
  const ok = /^\d{1,12}$/.test(number);
  return (
    <form className={s.foot} onSubmit={(event) => { event.preventDefault(); if (ok && !busy) onFind(number); }}>
      <Input label="Número impreso en la ficha" inputMode="numeric" autoComplete="off" maxLength={12}
        value={number} onChange={(event) => setNumber(event.target.value.replace(/\D/g, '').slice(0, 12))} style={DESK_FIELD} />
      {/* Lo tecleado, en grande y en grupos de 4 como en la ficha (A6): una cifra mal se ve. */}
      {number ? <FichaNumber printed={number} className={s.typedFicha} /> : null}
      <p className={s.hint}>Como aparece en la ficha. Solo para saldos que ya existen: una ficha nueva se carga acercándola, y para devolver efectivo hace falta el NFC original.</p>
      {error ? <p role="alert" className={s.error}>{error}</p> : null}
      <DeskBtn kind="pri" label="Buscar ficha" disabled={!ok} busy={busy} onClick={() => onFind(number)} />
    </form>
  );
}

/** «Escribir el código»: las seis casillas; al poner la sexta, se busca solo. */
export function CodeStep(props: {
  code: string;
  onCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  /** Entrada: un saldo nuevo sin NFC (móvil sin NFC, o el cliente no quiere). */
  onNewWithout?: () => void;
}) {
  return (
    <>
      <span className={s.kick}>Su código</span>
      <p className={s.lbl}>El que tiene en su móvil o en su ticket (K7Q-4M2).</p>
      <CodeBoxes value={props.code} onChange={props.onCode} disabled={props.busy} autoFocus />
      {props.busy ? <p className={s.lbl}>Buscando…</p> : null}
      {props.error ? (
        <p role="alert" className={s.error}>
          {props.error}
        </p>
      ) : null}
      {props.onNewWithout ? (
        <div className={s.links}>
          <button type="button" className={s.txtlink} onClick={props.onNewWithout}>
            Saldo nuevo sin NFC
          </button>
        </div>
      ) : null}
    </>
  );
}
