'use client';

import { useEffect, useState } from 'react';
import { Card, Logo, ThemeToggle, InstallHint } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import {
  SESSION_EXPIRED_EVENT,
  clearSession,
  getUser,
  hasSession,
  watchSessionFromOtherTabs,
  type User,
} from '@/lib/api';
import { canUsePanel } from '@/lib/roles';
import { clearNavFromUrl } from '@/lib/use-url-nav';

/** Sesión guardada utilizable en el panel; una de camarero o chica (de antes) se descarta. */
function storedPanelUser(): User | null {
  const user = hasSession() ? getUser() : null;
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
        className="np-login"
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
        className="np-login"
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
          <Logo height="2.5rem" />
          {/* «Panel», no «Admin»: así lo llama el dueño. */}
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 600 }}>Panel</h1>
        </header>
        {notice ? (
          <p role="status" className="np-relogin-notice">
            {notice}
          </p>
        ) : null}
        {/* Tarjeta normal: la única lima de la vista es «Entrar». */}
        <Card style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
          <LoginForm
            onSuccess={(u) => {
              setNotice(null);
              setUser(u);
            }}
          />
        </Card>
        {/* Fuera del cobro: el aviso de instalar como app (no sale si ya lo está). */}
        <InstallHint style={{ width: '100%', maxWidth: '24rem' }} />
      </main>
    );
  }

  return (
    <Dashboard
      user={user}
      onLogout={(serverConfirmed) => {
        // Quien entre después empieza en Hoy (la pestaña iba en la URL).
        clearNavFromUrl();
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
