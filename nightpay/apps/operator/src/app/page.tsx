'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Logo, ThemeToggle } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import { WALLET_CARD_PARAM } from '@nightpay/contracts';
import { getToken, getUser, onSessionEnded, type OperatorUser } from '@/lib/api';

export default function Page() {
  const [user, setUser] = useState<OperatorUser | null | undefined>(undefined);
  // Abierta desde una ficha NFC (?ficha=…) por alguien sin sesión: el cliente.
  const [fromCard, setFromCard] = useState(false);
  // La sesión se acabó sola (caducada, o cerrada en otra pestaña): se dice en el login.
  const [notice, setNotice] = useState<string | null>(null);
  const loggedIn = useRef(false);

  useEffect(() => {
    loggedIn.current = Boolean(user);
  }, [user]);

  useEffect(() => {
    if (getToken()) setUser(getUser());
    else setUser(null);
    setFromCard(new URLSearchParams(window.location.search).has(WALLET_CARD_PARAM));
    return onSessionEnded(() => {
      if (loggedIn.current) setNotice('Tu sesión ha caducado. Vuelve a entrar.');
      setUser(null);
    });
  }, []);

  if (user === undefined) {
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

  if (!user) {
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
        <div style={{ position: 'absolute', top: '1.5rem', right: '1.5rem' }}>
          <ThemeToggle />
        </div>
        <header style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <Logo height="3rem" />
          <h1 style={{ margin: 0, fontSize: 'var(--np-t-h1)', fontWeight: 600, letterSpacing: '-0.03em' }}>
            Operadora
          </h1>
        </header>
        {fromCard ? (
          <p style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-text-mute)' }}>
            Esta es una ficha de saldo. Para pagar, acércala al móvil de quien te cobra.
          </p>
        ) : null}
        {notice ? (
          <p role="status" style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-warning)', fontWeight: 600 }}>
            {notice}
          </p>
        ) : null}
        <Card variant="glow" style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
          <LoginForm
            onSuccess={(u) => {
              setNotice(null);
              setUser(u);
            }}
          />
        </Card>
      </main>
    );
  }

  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
