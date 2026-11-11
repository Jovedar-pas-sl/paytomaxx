'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Input, Logo } from '@nightpay/ui';
import { acceptInvite } from '@/lib/api';

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<main className="np-screen" style={pageStyle}>Cargando…</main>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden');
      return;
    }
    if (!token) {
      setError('Falta token de invitación en la URL');
      return;
    }
    setBusy(true);
    try {
      await acceptInvite(token, password);
      setDone(true);
      setTimeout(() => router.push('/'), 1500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="np-screen" style={pageStyle}>
      <header style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
        <Logo height="3rem" />
        <h1 style={{ margin: 0, fontSize: 'var(--np-t-h2)', fontWeight: 600 }}>
          Activar cuenta
        </h1>
      </header>

      <Card variant="glow" style={{ padding: '2rem', width: '100%', maxWidth: '24rem' }}>
        {done ? (
          <p style={{ margin: 0, textAlign: 'center', color: 'var(--np-success)' }}>
            ✓ Cuenta activada. Redirigiendo al login…
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Input
              type="password"
              label="Contraseña nueva (mín. 8)"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Input
              type="password"
              label="Repite la contraseña"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            <Button type="submit" loading={busy} size="lg">
              Activar
            </Button>
            {error ? (
              <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, textAlign: 'center', fontSize: 'var(--np-fs-14)' }}>
                {error}
              </p>
            ) : null}
          </form>
        )}
      </Card>
      {/* Salida: si el enlace ya no vale o la cuenta ya está activada, a entrar. */}
      <p style={enterStyle}>
        ¿Ya activaste tu cuenta?{' '}
        <a href="/" className="np-btn" data-variant="ghost" data-size="md">
          Entrar
        </a>
      </p>
    </main>
  );
}

const enterStyle = {
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap' as const,
  justifyContent: 'center',
  color: 'var(--np-text-mute)',
  fontSize: 'var(--np-fs-16)',
};

const pageStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem',
  gap: '2rem',
};
