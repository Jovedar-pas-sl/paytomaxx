'use client';

import { useEffect, useState } from 'react';
import { Card, Logo, ThemeToggle } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import { getToken, getUser, type OperatorUser } from '@/lib/api';

export default function Page() {
  const [user, setUser] = useState<OperatorUser | null | undefined>(undefined);

  useEffect(() => {
    if (getToken()) setUser(getUser());
    else setUser(null);
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
          <h1 style={{ margin: 0, fontSize: 'var(--np-t-h1)', fontWeight: 600, letterSpacing: '-0.03em' }}>
            Operadora
          </h1>
        </header>
        <Card variant="glow" style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
          <LoginForm onSuccess={(u) => setUser(u)} />
        </Card>
      </main>
    );
  }

  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
