'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { checkWalletPass, payWalletChargeWithPin, type WalletPassCheck } from '@/lib/api';
import { clearFichaContext, readFichaContext, type FichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import { PASS_WITHOUT_CHARGE_TEXT, passCheckProblem } from '@/lib/wallet-pass';
import { PinPad } from './PinPad';
import { StaffOutcome } from './StaffOutcome';

type Cobro = Extract<FichaContext, { kind: 'cobro' }>;

type View =
  | { kind: 'loading' }
  | { kind: 'pin'; check: WalletPassCheck; ctx: Cobro }
  | { kind: 'paid'; amountCents: number; serviceName: string | null; newBalanceCents: number | null }
  /** info: qué hacer (sin cobro abierto); danger: no se puede pagar con este pase. */
  | { kind: 'done'; text: string; tone: 'info' | 'danger' };

/**
 * La app se abrió desde el QR del pase de Google Wallet del cliente
 * (?pase=…, leído con la cámara del móvil). Ese QR solo sirve para cobrar:
 * se paga el cobro que la chica tenía abierto en «Sin móvil», con el PIN del
 * cliente. No se ve su saldo ni su código entero, y nunca se abre su saldo.
 */
export function PassScanned({ token, userId, onClose }: { token: string; userId: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  // Abierta: si la sesión caduca, se entra encima sin perderla.
  useOpenCharge('ficha', true, view.kind === 'loading' || view.kind === 'pin');

  useEffect(() => {
    const ctx = readFichaContext(userId);
    let stopped = false;
    const show = (v: View) => {
      if (!stopped) setView(v);
    };
    if (ctx?.kind !== 'cobro') {
      show({ kind: 'done', tone: 'info', text: PASS_WITHOUT_CHARGE_TEXT });
      return undefined;
    }
    (async () => {
      try {
        const check = await checkWalletPass(ctx.chargeId, token);
        const problem = passCheckProblem(check);
        show(problem ? { kind: 'done', tone: 'danger', text: problem } : { kind: 'pin', check, ctx });
      } catch (err) {
        show({ kind: 'done', tone: 'danger', text: (err as Error).message });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [token, userId]);

  if (view.kind === 'pin') {
    const { ctx, check } = view;
    return (
      <PinPad
        mode="enter"
        title={`${formatEur(ctx.amountCents, { compact: true })}${ctx.serviceName ? ` · ${ctx.serviceName}` : ''}`}
        hint={`Saldo ${check.codeHint} · pase`}
        onCancel={onClose}
        onPin={async (pin) => {
          const r = await payWalletChargeWithPin(ctx.chargeId, { walletToken: token }, pin);
          clearFichaContext((c) => c.kind === 'cobro' && c.chargeId === ctx.chargeId);
          setView(
            r.status === 'ACCEPTED'
              ? { kind: 'paid', amountCents: ctx.amountCents, serviceName: ctx.serviceName, newBalanceCents: r.newBalanceCents }
              : { kind: 'done', tone: 'danger', text: 'Este cobro ya no estaba pendiente' },
          );
          return null;
        }}
      />
    );
  }

  if (view.kind === 'paid') {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={view.amountCents}
        message="Cobrado del saldo."
        detail={
          <>
            {view.serviceName ? <p>{view.serviceName}</p> : null}
            {view.newBalanceCents !== null ? (
              <p>Le quedan {formatEur(view.newBalanceCents, { compact: true })}</p>
            ) : null}
          </>
        }
        primary={{ label: 'Listo', onClick: onClose }}
      />
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Pase de saldo</p>
      {view.kind === 'loading' ? <p style={hintStyle}>Leyendo el pase…</p> : null}
      {view.kind === 'done' ? (
        <p role="status" style={{ ...doneStyle, color: view.tone === 'danger' ? 'var(--np-danger)' : 'var(--np-text)' }}>
          {view.text}
        </p>
      ) : null}
      <Button size="lg" onClick={onClose}>
        Volver
      </Button>
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: 'var(--np-pad-card)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--np-gap)',
  textAlign: 'center',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};

const hintStyle: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-text-mute)' };

const doneStyle: CSSProperties = { margin: 0, fontSize: '1.15rem', fontWeight: 700 };
