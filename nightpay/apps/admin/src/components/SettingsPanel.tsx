'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import {
  fetchVenueSettings,
  updateVenueSettings,
  type VenueSettings,
} from '@/lib/api';

interface Props {
  isOwner: boolean;
}

export function SettingsPanel({ isOwner }: Props) {
  const [settings, setSettings] = useState<VenueSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form state — strings para inputs controlados
  const [platformPct, setPlatformPct] = useState('');
  const [maxCobroEur, setMaxCobroEur] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchVenueSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setPlatformPct((s.platformCommissionBps / 100).toFixed(2));
        setMaxCobroEur((s.operatorMaxCobroCents / 100).toFixed(2));
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const platformBps = Math.round(parseFloat(platformPct.replace(',', '.')) * 100);
    const maxCents = Math.round(parseFloat(maxCobroEur.replace(',', '.')) * 100);
    if (!Number.isFinite(platformBps) || platformBps < 0 || platformBps > 10_000) {
      setError('Comisión plataforma debe estar entre 0% y 100%');
      return;
    }
    if (!Number.isFinite(maxCents) || maxCents < 0 || maxCents > 10_000_00) {
      setError('Tope cobro chica debe estar entre 0 € y 10.000 €');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await updateVenueSettings({
        platformCommissionBps: platformBps,
        operatorMaxCobroCents: maxCents,
      });
      setSettings((prev) => (prev ? { ...prev, ...updated } : prev));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p style={loadingText}>Cargando ajustes…</p>;
  if (!settings)
    return (
      <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
        <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error ?? 'Sin datos'}</p>
      </Card>
    );

  const operatorPctImplied = (10000 - settings.platformCommissionBps) / 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '40rem' }}>
      <Card style={{ padding: '1.5rem' }}>
        <header style={{ marginBottom: '1rem' }}>
          <h2 style={titleStyle}>Local: {settings.name}</h2>
          <p style={subtitle}>
            Slug <code style={code}>{settings.slug}</code> · Zona {settings.timezone}
          </p>
        </header>

        <div style={modelInfo}>
          <p style={modelHeading}>Modelo de comisiones</p>
          <p style={modelText}>
            Cada cobro se reparte entre <strong>NightPay</strong> (comisión plataforma) y la{' '}
            <strong>chica</strong> (su <code style={code}>commissionBps</code> personal). El resto
            queda para el local.
          </p>
          <p style={modelText}>
            <strong>Hoy:</strong> NightPay {(settings.platformCommissionBps / 100).toFixed(2)}% ·
            chica recibe lo que le hayas asignado individualmente · local se queda con el resto.
            Ejemplo cobro 100€ con chica al 90%: NightPay {operatorPctImplied < 90 ? '10€' : `${(settings.platformCommissionBps / 100).toFixed(0)}€`} · chica 90€ · local 0€.
          </p>
        </div>
      </Card>

      <Card style={{ padding: '1.5rem' }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Input
            label="Comisión NightPay (%)"
            type="text"
            inputMode="decimal"
            value={platformPct}
            onChange={(e) => setPlatformPct(e.target.value)}
            disabled={!isOwner || submitting}
            required
            hint="Porcentaje que cobra la plataforma sobre cada transacción AUTHORIZED. Default 10%."
          />

          <Input
            label="Tope cobro por chica (€)"
            type="text"
            inputMode="decimal"
            value={maxCobroEur}
            onChange={(e) => setMaxCobroEur(e.target.value)}
            disabled={!isOwner || submitting}
            required
            hint="Importe máximo por cobro creado por una operadora. Default 200 €."
          />

          {error ? (
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
            </p>
          ) : null}
          {saved ? (
            <p style={{ color: 'var(--np-success)', margin: 0, fontSize: '0.875rem' }}>
              ✓ Guardado
            </p>
          ) : null}

          {isOwner ? (
            <Button type="submit" loading={submitting}>
              Guardar
            </Button>
          ) : (
            <p style={{ color: 'var(--np-text-mute)', fontSize: '0.85rem', margin: 0 }}>
              Solo el OWNER puede modificar los ajustes del local.
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h3)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const subtitle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
};

const modelInfo: CSSProperties = {
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '1rem',
};

const modelHeading: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const modelText: CSSProperties = {
  margin: '0.5rem 0 0',
  fontSize: '0.85rem',
  lineHeight: 1.5,
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.78rem',
};

const loadingText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
