'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Card, Logo, ThemeToggle, InstallHint } from '@nightpay/ui';
import { LoginForm } from '@/components/LoginForm';
import { CashRegister } from '@/components/CashRegister';
import { SESSION_EXPIRED_EVENT, getVenueSlug, hasSession } from '@/lib/api';
import { MESSAGES } from '@/lib/http';

const LOGOUT_NOT_CONFIRMED = 'Has salido. El servidor no respondió: la sesión caducará sola.';

export default function Page() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [venueSlug, setVenueSlug] = useState<string | null>(null);
  // Aviso en la pantalla de entrada: sesión caducada o salida sin respuesta del API.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setAuthed(hasSession());
    setVenueSlug(getVenueSlug());
  }, []);

  // El API rechazó la sesión: de vuelta al login en vez de un formulario que falla siempre.
  useEffect(() => {
    function onExpired() {
      setAuthed(false);
      setNotice(MESSAGES.session);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (authed === null) {
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

  if (!authed) {
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
          <h1 style={{ margin: 0, fontSize: 'var(--np-t-h1)', fontWeight: 600 }}>TPV</h1>
        </header>
        {notice ? (
          <p role="status" style={noticeStyle}>
            {notice}
          </p>
        ) : null}
        <Card style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
          <LoginForm
            onSuccess={() => {
              setNotice(null);
              setAuthed(true);
              setVenueSlug(getVenueSlug());
            }}
          />
        </Card>
        {/* Fuera del cobro: el aviso de instalar como app (no sale si ya lo está). */}
        <InstallHint style={{ width: '100%', maxWidth: '24rem' }} />
      </main>
    );
  }

  return (
    <CashRegister
      venueSlug={venueSlug ?? '—'}
      onLogout={(revoked) => {
        setNotice(revoked ? null : LOGOUT_NOT_CONFIRMED);
        setAuthed(false);
      }}
    />
  );
}

const noticeStyle: CSSProperties = {
  margin: 0,
  maxWidth: '24rem',
  textAlign: 'center',
  color: 'var(--np-warning)',
  fontSize: 'var(--np-fs-16)',
};
