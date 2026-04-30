'use client';

import { useEffect, useState } from 'react';
import { Card, Logo, ThemeToggle } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { CashRegister } from '@/components/CashRegister';
import { getToken, getVenueSlug } from '@/lib/api';

export default function Page() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [venueSlug, setVenueSlug] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    setAuthed(!!token);
    setVenueSlug(getVenueSlug());
  }, []);

  if (authed === null) {
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

  if (!authed) {
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
            TPV
          </h1>
        </header>
        <Card variant="glow" style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
          <LoginForm
            onSuccess={() => {
              setAuthed(true);
              setVenueSlug(getVenueSlug());
            }}
          />
        </Card>
      </main>
    );
  }

  return <CashRegister venueSlug={venueSlug ?? '—'} onLogout={() => setAuthed(false)} />;
}
