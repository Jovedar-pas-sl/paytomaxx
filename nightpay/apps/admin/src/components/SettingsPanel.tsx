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
  // Comisiones por categoría — bps → string en %.
  const [chicaServicePct, setChicaServicePct] = useState('');
  const [venueBarPct, setVenueBarPct] = useState('');
  const [venueRoomPct, setVenueRoomPct] = useState('');
  const [venueFoodPct, setVenueFoodPct] = useState('');
  const [extraPct, setExtraPct] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchVenueSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setPlatformPct((s.platformCommissionBps / 100).toFixed(2));
        setMaxCobroEur((s.operatorMaxCobroCents / 100).toFixed(2));
        const d = s.operatorCommissionDefaults;
        setChicaServicePct((d.CHICA_SERVICE / 100).toFixed(2));
        setVenueBarPct((d.VENUE_BAR / 100).toFixed(2));
        setVenueRoomPct((d.VENUE_ROOM / 100).toFixed(2));
        setVenueFoodPct((d.VENUE_FOOD / 100).toFixed(2));
        setExtraPct((d.EXTRA / 100).toFixed(2));
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Helper: parsea string "%" a bps, valida rango 0-100.
  function pctToBps(s: string, label: string): number {
    const bps = Math.round(parseFloat(s.replace(',', '.')) * 100);
    if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) {
      throw new Error(`${label} debe estar entre 0% y 100%`);
    }
    return bps;
  }

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
    let commissionDefaults;
    try {
      commissionDefaults = {
        CHICA_SERVICE: pctToBps(chicaServicePct, 'Comisión chica servicio'),
        VENUE_BAR: pctToBps(venueBarPct, 'Comisión bar'),
        VENUE_ROOM: pctToBps(venueRoomPct, 'Comisión habitación'),
        VENUE_FOOD: pctToBps(venueFoodPct, 'Comisión comida'),
        EXTRA: pctToBps(extraPct, 'Comisión otros'),
      };
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setSubmitting(true);
    try {
      const updated = await updateVenueSettings({
        platformCommissionBps: platformBps,
        operatorMaxCobroCents: maxCents,
        operatorCommissionDefaults: commissionDefaults,
      });
      setSettings(updated);
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
            Cada cobro se reparte entre <strong>OxioPay</strong> (comisión plataforma) y la{' '}
            <strong>chica</strong> (su <code style={code}>commissionBps</code> personal). El resto
            queda para el local.
          </p>
          <p style={modelText}>
            <strong>Hoy:</strong> OxioPay {(settings.platformCommissionBps / 100).toFixed(2)}% ·
            chica recibe lo que le hayas asignado individualmente · local se queda con el resto.
            Ejemplo cobro 100€ con chica al 90%: OxioPay {operatorPctImplied < 90 ? '10€' : `${(settings.platformCommissionBps / 100).toFixed(0)}€`} · chica 90€ · local 0€.
          </p>
        </div>
      </Card>

      <Card style={{ padding: '1.5rem' }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <Input
            label="Comisión OxioPay (%)"
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

          {/* Comisiones por categoría de ingreso */}
          <div style={{ borderTop: '1px solid var(--np-border)', paddingTop: '1.25rem' }}>
            <h3 style={{ ...titleStyle, fontSize: 'var(--np-t-h4)', marginBottom: '0.5rem' }}>
              Comisiones por categoría
            </h3>
            <p style={{ ...modelText, marginTop: 0, marginBottom: '1rem' }}>
              Comisión por defecto que se lleva quien crea el cobro (chica/camarero) según el tipo
              de cobro. Las chicas con <code style={code}>commissionBps</code> individual
              <strong> sobreescriben</strong> el valor de <em>"Servicio de chica"</em> pero las
              categorías VENUE_* siempre usan estos defaults.
            </p>

            <Input
              label="Servicio de chica (%)"
              type="text"
              inputMode="decimal"
              value={chicaServicePct}
              onChange={(e) => setChicaServicePct(e.target.value)}
              disabled={!isOwner || submitting}
              hint="% al crear cobro tipo 'Mi servicio'. Default 90%. Override por chica si tiene commissionBps."
            />
            <Input
              label="Bar / Bebida (%)"
              type="text"
              inputMode="decimal"
              value={venueBarPct}
              onChange={(e) => setVenueBarPct(e.target.value)}
              disabled={!isOwner || submitting}
              hint="% al crear cobro bar (ingreso del local). Default 0% — el camarero no se lleva nada."
            />
            <Input
              label="Habitación (%)"
              type="text"
              inputMode="decimal"
              value={venueRoomPct}
              onChange={(e) => setVenueRoomPct(e.target.value)}
              disabled={!isOwner || submitting}
              hint="% al crear cobro habitación. Default 0%."
            />
            <Input
              label="Comida (%)"
              type="text"
              inputMode="decimal"
              value={venueFoodPct}
              onChange={(e) => setVenueFoodPct(e.target.value)}
              disabled={!isOwner || submitting}
              hint="% al crear cobro comida. Default 0%."
            />
            <Input
              label="Otros (%)"
              type="text"
              inputMode="decimal"
              value={extraPct}
              onChange={(e) => setExtraPct(e.target.value)}
              disabled={!isOwner || submitting}
              hint="% al crear cobro sin categorizar. Default 0%."
            />
          </div>

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
