'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BIRTH_DATE_REQUIRED, BirthDateSchema, isMinor, madridToday } from '@nightpay/contracts';
import { ApiError } from '@nightpay/api-client';
import { Button, Card, Input, Logo } from '@nightpay/ui';
import { acceptInvite } from '@/lib/api';

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <main className="np-screen np-login" aria-busy="true">
          <span className="np-sr-only" role="status">Cargando…</span>
        </main>
      }
    >
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
  // Compañera sin fecha de nacimiento guardada: el API la pide (sin ella no se activa).
  const [askBirthDate, setAskBirthDate] = useState(false);
  const [birthDate, setBirthDate] = useState('');

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
    if (askBirthDate) {
      const parsed = BirthDateSchema.safeParse(birthDate);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Pon tu fecha de nacimiento');
        return;
      }
    }
    setBusy(true);
    try {
      await acceptInvite(token, password, askBirthDate ? birthDate : undefined);
      setDone(true);
      setTimeout(() => router.push('/'), 1500);
    } catch (err) {
      if (err instanceof ApiError && err.code === BIRTH_DATE_REQUIRED) setAskBirthDate(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="np-screen np-login" style={pageStyle}>
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
            {askBirthDate ? (
              <div>
                <Input
                  type="date"
                  label="Fecha de nacimiento"
                  autoComplete="bday"
                  value={birthDate}
                  onChange={(e) => setBirthDate(e.target.value)}
                  min="1900-01-01"
                  max={madridToday()}
                  required
                />
                {isMinor(birthDate || null, madridToday()) ? (
                  <p role="status" style={{ margin: '0.4rem 0 0', color: 'var(--np-warning)', fontSize: 'var(--np-fs-14)' }}>
                    Con menos de 18 años no se puede activar la cuenta. Si sigues, avisaremos al dueño del local.
                  </p>
                ) : null}
              </div>
            ) : null}
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
