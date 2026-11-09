'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { checkWalletPass, payWalletChargeWithPin, type WalletRef } from '@/lib/api';
import { lookupCode } from '@/lib/api-cobro';
import { clearFichaContext, readFichaContext, type FichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { useOpenCharge } from '@/lib/open-charges';
import { CODE_WITHOUT_CHARGE_TEXT, codeCheckProblem } from '@/lib/sin-movil';
import { PASS_WITHOUT_CHARGE_TEXT, passCheckProblem } from '@/lib/wallet-pass';
import { PinPad } from './PinPad';
import { StaffOutcome } from './StaffOutcome';

type Cobro = Extract<FichaContext, { kind: 'cobro' }>;

/** Lo que leyó la cámara del móvil: el QR de su pase (?pase=) o el de la página de su saldo (?saldo=, su código). */
export type ScannedLink = { kind: 'pass'; token: string } | { kind: 'code'; code: string };

type View =
  | { kind: 'loading' }
  | { kind: 'pin'; ref: WalletRef; hint: string; ctx: Cobro }
  | { kind: 'paid'; amountCents: number; serviceName: string | null; newBalanceCents: number | null }
  /** info: qué hacer (sin cobro abierto); danger: no se puede pagar así. */
  | { kind: 'done'; text: string; tone: 'info' | 'danger' };

/**
 * La app se abrió desde el QR del pase de Google Wallet del cliente (?pase=…)
 * o desde el de la página de su saldo (?saldo=…, solo su código), leídos con
 * la cámara del móvil. Se paga el cobro que se tenía abierto en Inicio (el
 * contexto de ficha que guarda Esperando), con el PIN del cliente. No se ve su
 * saldo (del pase, ni su código entero) y nunca se abre su saldo.
 */
export function PassScanned({ scan, userId, onClose }: { scan: ScannedLink; userId: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  // Abierta: si la sesión caduca, se entra encima sin perderla.
  useOpenCharge('ficha', true, view.kind === 'loading' || view.kind === 'pin');
  // Lo leído, en una cadena: el objeto `scan` es nuevo en cada render del padre.
  const scanKey = scan.kind === 'pass' ? `p:${scan.token}` : `c:${scan.code}`;

  useEffect(() => {
    const ctx = readFichaContext(userId);
    let stopped = false;
    const show = (v: View) => {
      if (!stopped) setView(v);
    };
    const pass = scanKey.startsWith('p:');
    const value = scanKey.slice(2);
    if (ctx?.kind !== 'cobro') {
      show({ kind: 'done', tone: 'info', text: pass ? PASS_WITHOUT_CHARGE_TEXT : CODE_WITHOUT_CHARGE_TEXT });
      return undefined;
    }
    (async () => {
      try {
        if (pass) {
          const check = await checkWalletPass(ctx.chargeId, value);
          const problem = passCheckProblem(check);
          show(
            problem
              ? { kind: 'done', tone: 'danger', text: problem }
              : { kind: 'pin', ref: { walletToken: value }, hint: `Saldo ${check.codeHint} · pase`, ctx },
          );
          return;
        }
        const w = await lookupCode(value);
        const problem = codeCheckProblem(w, ctx.amountCents);
        show(
          problem
            ? { kind: 'done', tone: 'danger', text: problem }
            : { kind: 'pin', ref: { code: w.code }, hint: `Saldo ${w.code} · código`, ctx },
        );
      } catch (err) {
        show({ kind: 'done', tone: 'danger', text: (err as Error).message });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [scanKey, userId]);

  if (view.kind === 'pin') {
    const { ctx, ref, hint } = view;
    return (
      <PinPad
        mode="enter"
        title={`${formatEur(ctx.amountCents, { compact: true })}${ctx.serviceName ? ` · ${ctx.serviceName}` : ''}`}
        hint={hint}
        onCancel={onClose}
        onPin={async (pin) => {
          const r = await payWalletChargeWithPin(ctx.chargeId, ref, pin);
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
      <p style={kicker}>{scan.kind === 'pass' ? 'Pase de saldo' : 'Código de saldo'}</p>
      {view.kind === 'loading' ? <p style={hintStyle}>{scan.kind === 'pass' ? 'Leyendo el pase…' : 'Buscando el saldo…'}</p> : null}
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

// Grafito: etiqueta 14/500 en t2, sin mayúsculas ni espaciado.
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
};

// 14 px como mínimo en la app del personal.
const hintStyle: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' };

// Qué hacer, en letra de leer (16/500), no en negrita.
const doneStyle: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 500, lineHeight: 1.45 };
