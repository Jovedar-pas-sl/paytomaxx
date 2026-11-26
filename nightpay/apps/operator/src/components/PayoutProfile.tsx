'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Notice, ProfileBlock, Skeleton } from '@nightpay/ui';
import { fetchMyPayoutInfo, type PayoutAccount } from '@/lib/api';
import { payoutMethodLabel } from '@/lib/payout-method';
import { fetchPushKey, forgetPushHere, pushHere, turnPushOff, turnPushOn, type PushHere } from '@/lib/payout-push';

/** undefined: cargando; null: no tiene cuenta puesta; false: no se pudo cargar. */
type AccountState = PayoutAccount | null | undefined | false;

/**
 * «Cuenta de cobro» en «Mi perfil» de la compañera: a dónde se le paga
 * (tapada; la cambia el encargado) y el aviso al móvil cuando le pagan.
 */
export function PayoutProfile() {
  const [account, setAccount] = useState<AccountState>(undefined);
  useEffect(() => {
    let live = true;
    fetchMyPayoutInfo().then(
      (info) => live && setAccount(info.account),
      () => live && setAccount(false),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <ProfileBlock title="Cuenta de cobro">
      <PayoutAccountLine account={account} />
      <PayoutPush />
    </ProfileBlock>
  );
}

export function PayoutAccountLine({ account }: { account: AccountState }) {
  // Cargando: una línea en la caja de la cuenta.
  if (account === undefined) {
    return (
      <div style={accountStyle} aria-busy="true">
        <span className="np-sr-only" role="status">Cargando…</span>
        <Skeleton width="70%" />
      </div>
    );
  }
  if (account === false) return <p style={textStyle}>No se ha podido cargar tu cuenta de cobro. Vuelve a entrar en «Mi perfil».</p>;
  if (account === null) return <p style={textStyle}>Aún no tienes cuenta de cobro: pídesela al encargado.</p>;
  const parts = [payoutMethodLabel(account.method), account.masked, account.label].filter(Boolean);
  return (
    <>
      <p style={accountStyle}>
        <span style={muted}>Te pagan a </span>
        <strong style={{ fontWeight: 600 }}>{parts.join(' · ')}</strong>
      </p>
      <p style={textStyle}>Para cambiarla, pídeselo al encargado.</p>
    </>
  );
}

const PUSH_TEXT: Readonly<Record<'unsupported' | 'install' | 'denied', string>> = {
  unsupported: 'Este navegador no puede recibir el aviso cuando te pagan.',
  install: 'En el iPhone, el aviso cuando te pagan llega con la app en la pantalla de inicio: toca Compartir y «Añadir a pantalla de inicio», y ábrela desde ahí.',
  denied: 'Has bloqueado los avisos de esta app. Para recibir el aviso cuando te pagan, permítelos en los ajustes del móvil.',
};

/** «Avisarme cuando me paguen» en este móvil. Si el API no tiene las claves de los avisos, no sale. */
function PayoutPush() {
  const [key, setKey] = useState<string | null>(null);
  const [here, setHere] = useState<PushHere | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const publicKey = await fetchPushKey().catch(() => null);
      if (!live || !publicKey) return;
      const now = await pushHere().catch((): PushHere => 'unsupported');
      if (!live) return;
      setKey(publicKey);
      setHere(now);
      // Encendido: se vuelve a apuntar en el API, por si lo borró o cambiaron las claves.
      if (now === 'on') void turnPushOn(publicKey).catch(() => undefined);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!key || !here) return null;
  if (here !== 'on' && here !== 'off') return <p style={textStyle}>{PUSH_TEXT[here]}</p>;

  async function toggle(on: boolean): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      if (on) await turnPushOn(key!);
      else await turnPushOff();
      setHere(on ? 'on' : 'off');
      setMsg({ kind: 'ok', text: on ? 'Hecho: te avisaremos en este móvil cuando te paguen.' : 'Aviso quitado en este móvil.' });
    } catch (err) {
      // Si el API no la guardó, la suscripción de este navegador no avisa: se quita y el botón queda para reintentar.
      if (on) await forgetPushHere();
      setHere(await pushHere().catch((): PushHere => 'off'));
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : 'No se ha podido cambiar el aviso.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <p style={textStyle}>
        {here === 'on' ? 'Te avisamos en este móvil cuando te pagan.' : 'Recibe un aviso en este móvil cuando te paguen.'}
      </p>
      <div>
        {here === 'on' ? (
          <Button variant="ghost" onClick={() => void toggle(false)} loading={busy} disabled={busy}>
            Quitar el aviso
          </Button>
        ) : (
          <Button onClick={() => void toggle(true)} loading={busy} disabled={busy}>
            Avisarme cuando me paguen
          </Button>
        )}
      </div>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </div>
  );
}

const textStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', color: 'var(--np-text-mute)', lineHeight: 1.45 };
const muted: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 500 };
const accountStyle: CSSProperties = {
  margin: 0,
  padding: '0.75rem 1rem',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  lineHeight: 1.5,
  overflowWrap: 'anywhere',
};
