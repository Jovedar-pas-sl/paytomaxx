'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { linkWalletCard, lookupWalletCard, payWalletChargeWithPin, type WalletLookup } from '@/lib/api';
import { clearFichaContext, readFichaContext, type FichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { PinPad } from './PinPad';
import { StaffOutcome } from './StaffOutcome';

type View =
  | { kind: 'loading' }
  | { kind: 'confirm'; code: string }
  | { kind: 'pin'; wallet: WalletLookup; ctx: Extract<FichaContext, { kind: 'cobro' }> }
  | { kind: 'info'; wallet: WalletLookup }
  | { kind: 'paid'; amountCents: number; serviceName: string | null; newBalanceCents: number | null }
  | { kind: 'done'; text: string; ok: boolean };

/**
 * La app se abrió desde una ficha NFC (?ficha=…): en iPhone el propio móvil
 * abre el enlace de la ficha. Según lo que estaba haciendo la chica en la otra
 * pestaña: pagar el cobro con su PIN, darle la ficha a la recarga, o ver de
 * quién es.
 */
export function FichaTapped({ token, userId, onClose }: { token: string; userId: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctx = readFichaContext(userId);
    let stopped = false;
    const show = (v: View) => {
      if (!stopped) setView(v);
    };
    (async () => {
      try {
        // Dar ficha: primero lo confirma (que no se dé una ficha que no es).
        if (ctx?.kind === 'dar') {
          show({ kind: 'confirm', code: ctx.code });
          return;
        }
        const w = await lookupWalletCard(token, null);
        if (ctx?.kind === 'cobro') {
          if (w.pinLocked) show({ kind: 'done', ok: false, text: 'Su PIN está bloqueado por fallos: avisa al encargado.' });
          else if (!w.hasPin) show({ kind: 'done', ok: false, text: 'Este cliente aún no tiene PIN: que pague con el QR.' });
          else show({ kind: 'pin', wallet: w, ctx });
        } else {
          show({ kind: 'info', wallet: w });
        }
      } catch (err) {
        show({ kind: 'done', ok: false, text: (err as Error).message });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [token, userId]);

  async function give(code: string) {
    setBusy(true);
    try {
      const w = await linkWalletCard(code, token, null);
      setView({ kind: 'done', ok: true, text: `✓ Ficha dada al saldo ${w.code}` });
    } catch (err) {
      setView({ kind: 'done', ok: false, text: (err as Error).message });
    } finally {
      clearFichaContext((c) => c.kind === 'dar');
      setBusy(false);
    }
  }

  if (view.kind === 'confirm') {
    return (
      <Card style={cardStyle}>
        <p style={kicker}>Dar ficha</p>
        <p style={{ margin: 0, fontSize: '1.1rem' }}>¿Dar esta ficha al saldo</p>
        <p className="np-num" style={bigStyle}>
          {view.code}?
        </p>
        <Button size="lg" onClick={() => void give(view.code)} loading={busy}>
          Sí, dársela
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            clearFichaContext((c) => c.kind === 'dar');
            onClose();
          }}
        >
          No
        </Button>
      </Card>
    );
  }

  if (view.kind === 'pin') {
    const { ctx, wallet } = view;
    return (
      <PinPad
        mode="enter"
        title={`${formatEur(ctx.amountCents, { compact: true })}${ctx.serviceName ? ` · ${ctx.serviceName}` : ''}`}
        hint={`Saldo ${wallet.code} · ficha`}
        onCancel={onClose}
        onPin={async (pin) => {
          const r = await payWalletChargeWithPin(ctx.chargeId, { card: token }, pin);
          clearFichaContext((c) => c.kind === 'cobro' && c.chargeId === ctx.chargeId);
          setView(
            r.status === 'ACCEPTED'
              ? { kind: 'paid', amountCents: ctx.amountCents, serviceName: ctx.serviceName, newBalanceCents: r.newBalanceCents }
              : { kind: 'done', ok: false, text: 'Este cobro ya no estaba pendiente' },
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
      <p style={kicker}>Ficha de saldo</p>
      {view.kind === 'loading' ? <p style={hintStyle}>Leyendo la ficha…</p> : null}
      {view.kind === 'info' ? (
        <>
          <p className="np-num" style={bigStyle}>
            {view.wallet.code}
          </p>
          <p style={{ margin: 0 }}>Le quedan {formatEur(view.wallet.balanceCents, { compact: true })}</p>
          <p style={hintStyle}>Para cobrarle: elige el servicio en «Saldo» y acerca otra vez la ficha.</p>
        </>
      ) : null}
      {view.kind === 'done' ? (
        <p style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: view.ok ? 'var(--np-success)' : 'var(--np-danger)' }}>
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
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
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

const bigStyle: CSSProperties = {
  margin: 0,
  fontSize: '2.25rem',
  fontWeight: 800,
  letterSpacing: '0.2em',
  color: 'var(--np-accent)',
};
