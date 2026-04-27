'use client';

import { useEffect, useState } from 'react';
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
    return <main style={pageStyle}>Cargando…</main>;
  }

  if (!authed) {
    return (
      <main style={pageStyle}>
        <h1 style={{ marginBottom: '1.5rem' }}>NightPay TPV</h1>
        <LoginForm
          onSuccess={() => {
            setAuthed(true);
            setVenueSlug(getVenueSlug());
          }}
        />
      </main>
    );
  }

  return <CashRegister venueSlug={venueSlug ?? '—'} onLogout={() => setAuthed(false)} />;
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem',
};
