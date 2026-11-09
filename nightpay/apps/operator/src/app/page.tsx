'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Logo } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import { ReloginSheet } from '@/components/ReloginSheet';
import { SessionExpiredContext } from '@/components/session-context';
import { WALLET_CARD_PARAM, WALLET_PASS_PARAM } from '@nightpay/contracts';
import { getUser, hasSession, apiBase, logout, onProfileUpdated, onSessionEnded, type OperatorUser } from '@/lib/api';
import { customerCardDestination } from '@/lib/customer-card';
import { clearFichaContext } from '@/lib/ficha-context';
import { captureInviteFromUrl } from '@/lib/invite-link';
import { useOpenCharges } from '@/lib/open-charges';
import { afterRelogin, shellView, withProfile } from '@/lib/session-resume';
import { clearTabFromUrl } from '@/lib/use-url-tab';
import { PASS_OPENED_LOGGED_OUT_TEXT } from '@/lib/wallet-pass';

const EXPIRED_NOTICE = 'Tu sesión ha caducado. Vuelve a entrar.';
const LOGGED_OUT_ELSEWHERE_NOTICE = 'Has salido desde otra pestaña.';

export default function Page() {
  const [user, setUser] = useState<OperatorUser | null | undefined>(undefined);
  // La sesión caducó: con un cobro abierto, la app sigue debajo y se entra encima.
  const [expired, setExpired] = useState(false);
  // Sube cuando entra otra persona (u otro local): la app empieza de cero.
  const [generation, setGeneration] = useState(0);
  // Abierta desde una ficha NFC (?ficha=…) o el QR de un pase (?pase=…) por alguien sin sesión: el cliente.
  const [fromCard, setFromCard] = useState(false);
  const [fromPass, setFromPass] = useState(false);
  // La sesión se acabó sola (caducada, o cerrada en otra pestaña): se dice en el login.
  const [notice, setNotice] = useState<string | null>(null);
  const loggedIn = useRef(false);
  const charges = useOpenCharges();

  useEffect(() => {
    loggedIn.current = Boolean(user);
  }, [user]);

  useEffect(() => {
    // QR de una chica leído con la cámara del móvil: lo recoge el cobro abierto.
    captureInviteFromUrl();
    const opened = new URLSearchParams(window.location.search);
    const customerUrl = customerCardDestination(opened.get(WALLET_CARD_PARAM), hasSession(), apiBase);
    if (customerUrl) { window.location.replace(customerUrl); return; }
    if (hasSession()) setUser(getUser());
    else setUser(null);
    setFromCard(opened.has(WALLET_CARD_PARAM));
    setFromPass(opened.has(WALLET_PASS_PARAM));
    // El refresco trae el nombre de Personal (sesiones de antes, o cambiado): se pinta sin volver a entrar.
    const stopProfile = onProfileUpdated((next) => setUser((current) => withProfile(current, next)));
    const stopEnded = onSessionEnded((reason) => {
      if (!loggedIn.current) return;
      if (reason === 'logout') {
        // «Salir» en otra pestaña: fuera aquí también, con cobro abierto o sin él.
        setNotice(LOGGED_OUT_ELSEWHERE_NOTICE);
        setExpired(false);
        setUser(null);
        return;
      }
      setNotice(EXPIRED_NOTICE);
      setExpired(true);
    });
    return () => {
      stopProfile();
      stopEnded();
    };
  }, []);

  /** Entrar (o volver a entrar). Otra persona u otro local: nada de lo de antes. */
  function enter(next: OperatorUser) {
    if (afterRelogin(user, next) === 'reset') {
      clearFichaContext();
      clearTabFromUrl();
      setGeneration((g) => g + 1);
    }
    setNotice(null);
    setExpired(false);
    setUser(next);
  }

  // La sesión local se borra ya (logout) y el login sale al momento; la del
  // servidor sigue por detrás: si no la confirma, se avisa en el login.
  function handleLogout() {
    // Ya fuera: un sondeo que caduque ahora mismo no dice «Tu sesión ha caducado».
    loggedIn.current = false;
    const closed = logout();
    // Quien entre después empieza en Inicio (la pestaña iba en la URL).
    clearTabFromUrl();
    setNotice(null);
    setExpired(false);
    setUser(null);
    void closed.then((confirmed) => {
      if (!confirmed && !loggedIn.current) {
        setNotice('Has salido en este móvil, pero el servidor no lo ha confirmado: la sesión caducará sola.');
      }
    });
  }

  const view = shellView({ user, expired, chargeOpen: charges.open });

  if (view === 'loading') {
    return (
      <main
        className="np-screen"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--np-text-mute)',
        }}
      >
        Cargando…
      </main>
    );
  }

  if (view === 'login' || !user) {
    return <LoginScreen fromCard={fromCard} fromPass={fromPass} notice={notice} onSuccess={enter} />;
  }

  return (
    <SessionExpiredContext.Provider value={expired}>
      <Dashboard key={generation} user={user} onLogout={handleLogout} />
      {view === 'relogin' ? (
        <ReloginSheet email={user.email} chargePending={charges.pending} onSuccess={enter} />
      ) : null}
    </SessionExpiredContext.Provider>
  );
}

function LoginScreen({
  fromCard,
  fromPass,
  notice,
  onSuccess,
}: {
  fromCard: boolean;
  fromPass: boolean;
  notice: string | null;
  onSuccess: (user: OperatorUser) => void;
}) {
  return (
    <main
      className="np-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '2rem',
      }}
    >
      <header style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
        <Logo height="3rem" />
        {/* Entran camareros, chicas, recepción y encargados: «Personal», no «Operadora». */}
        <h1 style={{ margin: 0, fontSize: 'var(--np-t-h1)', fontWeight: 600 }}>Personal</h1>
      </header>
      {fromCard ? (
        <p style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-text-mute)' }}>
          Esta es una ficha de saldo. Para pagar, acércala al móvil de quien te cobra.
        </p>
      ) : fromPass ? (
        <p style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-text-mute)' }}>
          {PASS_OPENED_LOGGED_OUT_TEXT}
        </p>
      ) : null}
      {notice ? (
        <p role="status" style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-warning)', fontWeight: 500 }}>
          {notice}
        </p>
      ) : null}
      {/* Sin borde lima: la lima es del botón «Entrar» (una por pantalla). */}
      <Card style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
        <LoginForm onSuccess={onSuccess} />
      </Card>
    </main>
  );
}
