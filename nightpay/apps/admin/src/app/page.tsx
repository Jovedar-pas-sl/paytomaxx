'use client';

import { useEffect, useState } from 'react';
import { Card, Logo, ThemeToggle } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import {
  SESSION_EXPIRED_EVENT,
  clearSession,
  getToken,
  getUser,
  watchSessionFromOtherTabs,
  type User,
} from '@/lib/api';
import { canUsePanel } from '@/lib/roles';

/** Sesión guardada utilizable en el panel; una de camarero o chica (de antes) se descarta. */
function storedPanelUser(): User | null {
  const user = getToken() ? getUser() : null;
  if (user && !canUsePanel(user.role)) {
    clearSession();
    return null;
  }
  return user;
}

export default function Page() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  // Por qué se está en el login (sesión caducada, salida en otra pestaña…).
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setUser(storedPanelUser());

    function onExpired(): void {
      setNotice('Tu sesión ha caducado. Vuelve a entrar.');
      setUser(null);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    const stopWatching = watchSessionFromOtherTabs((change) => {
      if (change === 'signed-out') {
        setNotice('Se cerró la sesión en otra pestaña.');
        setUser(null);
      } else if (change === 'signed-in') {
        setNotice(null);
        setUser(storedPanelUser());
      } else {
        // Otra pestaña cambió de local (o entró otra persona): todo se recarga
        // para no enseñar un local y operar en otro.
        window.location.reload();
      }
    });
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      stopWatching();
    };
  }, []);

  if (user === undefined) {
    return (
      <main
        style={{
          minHeight: '100vh',
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
        style={{
          minHeight: '100vh',
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
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--np-t-h1)',
              fontWeight: 600,
              letterSpacing: '-0.03em',
            }}
          >
            Admin
          </h1>
        </header>
        {notice ? (
          <p role="status" style={{ margin: 0, maxWidth: '24rem', textAlign: 'center', color: 'var(--np-text-mute)' }}>
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

  return (
    <Dashboard
      user={user}
      onLogout={(serverConfirmed) => {
        setNotice(
          serverConfirmed
            ? null
            : 'Has salido en este dispositivo, pero el servidor no confirmó el cierre de la sesión.',
        );
        setUser(null);
      }}
    />
  );
}
