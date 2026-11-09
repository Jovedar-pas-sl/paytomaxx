'use client';

import { useState } from 'react';
import { AmountKeypad, Input } from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import type { MethodButton, ExitPlan } from '@/lib/reception-desk';
import { CodeBoxes, DESK_FIELD, DeskBtn, DeskRowView, Icon, NfcMark } from './desk-parts';
import s from './desk.module.css';

/** 4.1 (y 4.5 sin nada leído): «Acerca el NFC», sin tocar nada. */
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
  const text =
    props.noReader?.text ??
    (props.mode === 'entrada'
      ? 'Por detrás del móvil. Sabe solo si es nuevo o si ya tiene saldo.'
      : 'Por detrás del móvil: sale lo que le queda.');
  const body = (
    <>
      {props.noReader ? null : <NfcMark size="l" />}
      <p className={s.stageTitle}>{props.noReader?.title ?? (props.busy ? 'Leyendo…' : 'Acerca el NFC')}</p>
      {props.error ? (
        <p role="alert" className={s.stageError}>
          {props.error}
        </p>
      ) : props.notice ? (
        <p role="status" className={s.stageNotice}>
          {props.notice}
        </p>
      ) : (
        <p className={s.stageText}>{props.stopped ?? text}</p>
      )}
    </>
  );
  // Web NFC pide el permiso con un toque: entonces el escenario es el botón.
  if (props.stopped) {
    return (
      <button type="button" className={s.stage} onClick={props.onRestart} aria-label="Tocar para leer el NFC">
        {body}
      </button>
    );
  }
  return (
    <div className={s.stage} aria-live="polite" aria-busy={props.busy || undefined}>
      {body}
    </div>
  );
}

/** 4.2: el NFC leído y los importes rápidos en rejilla de 72 px, con «Otro» de última casilla: tocar uno ya sigue. */
export function AmountStep(props: {
  row: { title: string; detail: string };
  amounts: readonly number[];
  onPick: (cents: number) => void;
  onOther: () => void;
  /** Encargado o dueño ante una ficha sin PIN: que lo elija sin tener que cargar nada. */
  onPin?: () => void;
}) {
  return (
    <>
      <DeskRowView title={props.row.title} detail={props.row.detail} />
      <p className={s.q}>¿Cuánto carga?</p>
      <div className={s.quick}>
        {props.amounts.map((c) => (
          <button key={c} type="button" className={s.qb} onClick={() => props.onPick(c)}>
            {formatEur(c, { compact: true })}
          </button>
        ))}
        <button type="button" className={`${s.qb} ${s.qbOther}`} aria-label="Otro importe" onClick={props.onOther}>
          Otro
        </button>
      </div>
      {props.onPin ? <DeskBtn kind="gho" label="Que elija su PIN" onClick={props.onPin} /> : null}
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

const METHOD_TEXT = {
  cash: { icon: 'cash', label: 'Efectivo', small: 'Lo metes en la caja' },
  card: { icon: 'card', label: 'Tarjeta', small: 'Paga con el QR en su móvil' },
} as const;

/** 4.3: el importe, «¿Cómo paga?» en dos filas iguales (la de por defecto, primera y en lima), y la nota del PIN. */
export function MethodStep(props: {
  chip: string;
  amountCents: number;
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
  return (
    <>
      <div className={s.bigamt}>
        <span className="np-chip" data-dashed="true">
          {props.chip}
        </span>
        <p className={s.bignum}>{formatEur(props.amountCents, { compact: true })}</p>
        {props.feeText ? <p className={s.lbl}>{props.feeText}</p> : null}
      </div>
      <p className={s.q}>¿Cómo paga?</p>
      {props.loading ? <p className={s.lbl}>Cargando…</p> : null}
      {props.blocked ? (
        <p role="alert" className={s.error}>
          {props.blocked}
        </p>
      ) : null}
      {props.buttons.map((b) => {
        const t = METHOD_TEXT[b.method];
        return (
          <DeskBtn
            key={b.method}
            kind={b.primary ? 'pri' : 'gho'}
            icon={t.icon}
            label={t.label}
            small={t.small}
            disabled={b.problem !== null || props.blocked !== null}
            busy={props.busy}
            onClick={() => props.onPick(b.method)}
          />
        );
      })}
      {[...new Set(problems)].map((p) => (
        <p key={p} className={s.lbl}>
          {p}
        </p>
      ))}
      {props.pinNote ? (
        <p className={s.note}>
          <Icon name="lock" />
          {props.pinNote}
        </p>
      ) : null}
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
      <div className={s.bigamt}>
        <span className={s.kick}>{plan.balanceCents > 0 ? 'Le quedan' : 'No le queda saldo'}</span>
        <p className={s.bignum}>{formatEur(plan.balanceCents, { compact: true })}</p>
      </div>
      <DeskBtn kind="pri" label="Guardar para la próxima" small={plan.keepDetail} onClick={props.onKeep} disabled={props.busy} />
      {plan.refundLabel ? (
        <DeskBtn
          kind="gho"
          label={plan.refundLabel}
          small={plan.refundBlocked ?? plan.refundDetail}
          onClick={props.onRefund}
          disabled={plan.refundBlocked !== null}
          busy={props.busy}
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
