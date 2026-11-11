'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@nightpay/ui';
import { formatEur } from '@/lib/money';
import {
  exitReasonText,
  payoutPasskeyStatus,
  requestPayoutPasskey,
  type ReceptionPayoutPlan,
} from '@/lib/reception-cash-payout';
import { entryRow, type NumberSaldo } from '@/lib/reception-desk';
import { DESK_FIELD, DeskBtn, DeskRowView, Icon } from './desk-parts';
import { QrBox } from './QrBox';
import s from './desk.module.css';

/** Cada cuánto se pregunta si ya lo confirmó en su móvil. */
const POLL_MS = 2_000;

const eur = (cents: number) => formatEur(cents, { compact: true });

/** El 2FA es un código: centrado, en cifras de Manrope y espaciado (el único sitio con letter-spacing). */
const TOTP_FIELD = {
  ...DESK_FIELD,
  textAlign: 'center',
  fontFamily: 'var(--np-font-num)',
  fontSize: '1.375rem',
  fontWeight: 600,
  letterSpacing: '0.3em',
} as const;

interface PasskeyProps {
  walletId: string;
  proof: { card: string; uid: string; expectedAmountCents: number; requestKey: string };
  plan: ReceptionPayoutPlan;
  onConfirmed: () => void;
  /** El encargado o el dueño, sin su móvil: su 2FA (o el PIN). */
  onWithoutPhone?: { label: string; onClick: () => void };
  onKeep: () => void;
}

/**
 * Su saldo tiene Face ID: recepción enseña un QR, el cliente lo abre en SU
 * móvil y lo confirma. Con su NFC y su PIN solos no sale dinero.
 */
export function PasskeyExitStep({ walletId, proof, plan, onConfirmed, onWithoutPhone, onKeep }: PasskeyProps) {
  const [qr, setQr] = useState<{ url: string } | null>(null);
  const [state, setState] = useState<'loading' | 'waiting' | 'expired'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const done = useRef(false);
  // La última versión de quien sigue (cambia en cada pintado de la pantalla de arriba).
  const confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;

  useEffect(() => {
    let alive = true;
    setState('loading');
    setError(null);
    requestPayoutPasskey(walletId, proof).then((r) => {
      if (!alive) return;
      setQr({ url: r.url });
      setState('waiting');
    }, (err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
    // Un QR por vuelta (otro al caducar).
  }, [walletId, proof.requestKey, round]);

  useEffect(() => {
    if (state !== 'waiting') return;
    const timer = setInterval(() => {
      payoutPasskeyStatus(walletId, proof.requestKey).then((st) => {
        if (st.status === 'confirmed' && !done.current) {
          done.current = true;
          confirmed.current();
        } else if (st.status === 'expired') setState('expired');
      }, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, walletId, proof.requestKey]);

  return (
    <>
      <p className={s.q}>Devolver {eur(proof.expectedAmountCents)} en efectivo</p>
      {state === 'expired' ? (
        <div className={`${s.qr} ${s.qrWait}`}>
          <p className={s.qrEmpty}>El QR ha caducado</p>
        </div>
      ) : qr ? (
        <QrBox value={qr.url} label="QR para que el cliente confirme la salida con Face ID" />
      ) : (
        <div className={`${s.qr} ${s.qrWait}`} aria-busy="true">
          <p className={s.qrEmpty}>Un momento…</p>
        </div>
      )}
      <p className={s.waitT}>Que lo confirme en su móvil</p>
      <p className={s.lbl}>Su saldo tiene Face ID: que escanee el QR con la cámara.</p>
      {plan.needs === 'manager_pending' ? (
        <p className={s.note}>
          <Icon name="lock" />
          {exitReasonText(plan)}: después lo confirma el encargado.
        </p>
      ) : null}
      {error ? <p role="alert" className={s.error}>{error}</p> : null}
      {state === 'expired' ? <DeskBtn kind="pri" label="Otro QR" onClick={() => setRound((n) => n + 1)} /> : null}
      <div className={s.foot}>
        {onWithoutPhone ? <DeskBtn kind="gho" label={onWithoutPhone.label} onClick={onWithoutPhone.onClick} /> : null}
        <DeskBtn kind="gho" label="Guardar para la próxima" small={onWithoutPhone ? null : '¿Sin su móvil? Que lo devuelva el encargado'} onClick={onKeep} />
      </div>
    </>
  );
}

interface TotpProps {
  plan: ReceptionPayoutPlan | null;
  amountCents: number;
  /** El texto del API si lo pidió él. */
  message?: string;
  busy: boolean;
  /** Después de su código: el PIN del cliente (o nada, si ya confirmó en su móvil). */
  then: string;
  onCode: (code: string) => void;
}

/** El encargado pone su 2FA ANTES del PIN del cliente: el cliente lo teclea una sola vez. */
export function TotpExitStep({ plan, amountCents, message, busy, then, onCode }: TotpProps) {
  const [code, setCode] = useState('');
  const why = plan ? exitReasonText(plan) : '';
  return (
    <form className={s.foot} onSubmit={(e) => { e.preventDefault(); if (code.length === 6) onCode(code); }}>
      <div className={s.bigamt}>
        <span className={s.kick}>{why || 'Lo confirma el encargado'}</span>
        <p className={s.bignum}>{eur(amountCents)}</p>
      </div>
      <Input
        label={message ?? 'Tu código de la app de verificación (2FA)'}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        autoFocus
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        style={TOTP_FIELD}
      />
      <DeskBtn kind="pri" label={then} disabled={code.length !== 6} busy={busy} onClick={() => onCode(code)} />
    </form>
  );
}

/** Recepción no puede sola (más de 100 €, su tope de la noche): queda para el encargado, con el PIN una vez. */
export function ManagerExitStep({ plan, amountCents, onAsk, onKeep }: { plan: ReceptionPayoutPlan; amountCents: number; onAsk: () => void; onKeep: () => void }) {
  return (
    <>
      <div className={s.bigamt}>
        <span className={s.kick}>{exitReasonText(plan)}</span>
        <p className={s.bignum}>{eur(amountCents)}</p>
      </div>
      <p className={s.q}>Lo confirma el encargado</p>
      <p className={s.lbl}>El cliente pone su PIN una vez y queda pendiente: aún no sacas dinero. El encargado lo confirma en el panel con su 2FA.</p>
      <DeskBtn kind="pri" label="Pedir al encargado" small="El cliente pone su PIN" onClick={onAsk} />
      <DeskBtn kind="gho" label="Guardar para la próxima" onClick={onKeep} />
    </>
  );
}

/** Salida por el número impreso: se ve lo que tiene (tapado); para devolver, el NFC original. */
export function NumberExitStep({ view, onKeep, onTap }: { view: NumberSaldo; onKeep: () => void; onTap: () => void }) {
  // Por su número (A6): en grande, «Compruébalo con la ficha» y lo que se le pregunta.
  const row = entryRow({ view: null, nfc: null, number: view });
  return (
    <>
      <DeskRowView title={row.title} detail={row.detail} ficha={row.ficha}>
        <span className={s.rowHint}>{row.hint}</span>
        <span className={s.rowHint}>{row.ask}</span>
      </DeskRowView>
      <div className={s.bigamt} data-tour="recep-quedan">
        <span className={s.kick}>{view.balanceCents > 0 ? 'Le quedan' : 'No le queda saldo'}</span>
        <p className={s.bignum}>{eur(view.balanceCents)}</p>
      </div>
      <DeskBtn kind="pri" label="Guardar para la próxima" small="Para otra noche · se lleva su ficha" onClick={onKeep} tour="recep-guardar" />
      {view.cashOutCents > 0 ? (
        <DeskBtn kind="gho" label={`Devolver ${eur(view.cashOutCents)} en efectivo`} small="Para devolver, acerca su NFC original" onClick={onTap} tour="recep-devolver" />
      ) : null}
    </>
  );
}
