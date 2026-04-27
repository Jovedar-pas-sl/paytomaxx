'use client';

import { useState } from 'react';
import { login, setSession } from '@/lib/api';

interface Props {
  onSuccess: () => void;
}

export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
      setSession(result);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={formStyle}>
      <input
        type="email"
        autoComplete="email"
        placeholder="email@nightpay.local"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        type="password"
        autoComplete="current-password"
        placeholder="contraseña"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={inputStyle}
      />
      <button type="submit" disabled={busy} style={btnStyle}>
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
      {error && <p style={errorStyle}>{error}</p>}
    </form>
  );
}

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  width: '100%',
  maxWidth: '20rem',
};

const inputStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  fontSize: '1rem',
  border: '1px solid #444',
  borderRadius: '0.5rem',
  background: '#1a1a1f',
  color: '#fff',
};

const btnStyle: React.CSSProperties = {
  padding: '0.85rem',
  fontSize: '1rem',
  fontWeight: 600,
  background: '#fafafa',
  color: '#0b0b10',
  border: 'none',
  borderRadius: '0.5rem',
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  color: '#ef5350',
  margin: 0,
  textAlign: 'center',
};
