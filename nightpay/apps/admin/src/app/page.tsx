'use client';

import { useEffect, useState } from 'react';
import { LoginForm } from '@/components/LoginForm';
import { Dashboard } from '@/components/Dashboard';
import { getToken, getUser, type User } from '@/lib/api';

export default function Page() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    if (getToken()) setUser(getUser());
    else setUser(null);
  }, []);

  if (user === undefined) return <main style={pageStyle}>Cargando…</main>;

  if (!user) {
    return (
      <main style={pageStyle}>
        <h1 style={{ marginBottom: '1.5rem' }}>NightPay Admin</h1>
        <LoginForm onSuccess={(u) => setUser(u)} />
      </main>
    );
  }

  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem',
};
