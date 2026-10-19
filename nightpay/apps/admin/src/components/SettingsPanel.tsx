'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import { fetchVenueSettings, updateVenueSettings, type VenueSettings } from '@/lib/api';
import { bpsToPercentInput, formatPercent, parsePercentToBps, splitExample } from '@/lib/commission';
import { centsToInput, formatEur } from '@/lib/money';
import { Notice } from './Notice';
import { TwoFactorCard } from './TwoFactorCard';

interface Props {
  isOwner: boolean;
}

/** Campos del formulario (texto tal cual se teclea). La comisión de OxioPay solo se enseña. */
interface SettingsForm {
  maxCobroEur: string;
  chicaServicePct: string;
  venueBarPct: string;
  venueRoomPct: string;
  venueFoodPct: string;
  extraPct: string;
}

function formFrom(s: VenueSettings): SettingsForm {
  const d = s.operatorCommissionDefaults;
  return {
    maxCobroEur: centsToInput(s.operatorMaxCobroCents),
    chicaServicePct: bpsToPercentInput(d.CHICA_SERVICE),
    venueBarPct: bpsToPercentInput(d.VENUE_BAR),
    venueRoomPct: bpsToPercentInput(d.VENUE_ROOM),
    venueFoodPct: bpsToPercentInput(d.VENUE_FOOD),
    extraPct: bpsToPercentInput(d.EXTRA),
  };
}

/** Porcentaje tecleado → puntos básicos, o el error para enseñar. */
function percentField(value: string, label: string): number {
  const bps = parsePercentToBps(value);
  if (bps === null) throw new Error(`${label}: pon un porcentaje de 0 a 100 (por ejemplo 10 o 10,5).`);
  return bps;
}

export function SettingsPanel({ isOwner }: Props) {
  const [settings, setSettings] = useState<VenueSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetchVenueSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setForm(formFrom(s));
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  function setField(key: keyof SettingsForm, value: string): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form || !settings) return;
    setError(null);
    setSaved(false);
    let input: Parameters<typeof updateVenueSettings>[0];
    try {
      const maxCents = parseEuroCents(form.maxCobroEur);
      if (maxCents === null || maxCents > 10_000_00) {
        throw new Error('Tope cobro chica: un importe entre 0,01 € y 10.000 €.');
      }
      input = {
        operatorMaxCobroCents: maxCents,
        operatorCommissionDefaults: {
          CHICA_SERVICE: percentField(form.chicaServicePct, 'Servicio de chica'),
          VENUE_BAR: percentField(form.venueBarPct, 'Bar / Bebida'),
          VENUE_ROOM: percentField(form.venueRoomPct, 'Habitación'),
          VENUE_FOOD: percentField(form.venueFoodPct, 'Comida'),
          EXTRA: percentField(form.extraPct, 'Otros'),
        },
      };
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setSubmitting(true);
    try {
      const updated = await updateVenueSettings(input);
      // El PATCH no trae nombre, slug ni zona: se mezclan con lo que había y
      // los campos se rellenan con lo que guardó el servidor.
      const merged: VenueSettings = { ...settings, ...updated };
      setSettings(merged);
      setForm(formFrom(merged));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '40rem' }}>
      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
          No se pudieron cargar los ajustes: {loadError}
        </Notice>
      ) : settings === null || form === null ? (
        <p style={loadingText}>Cargando ajustes…</p>
      ) : (
        <>
          <Card style={{ padding: '1.5rem' }}>
            <header style={{ marginBottom: '1rem' }}>
              <h2 style={titleStyle}>Local: {settings.name}</h2>
              <p style={subtitle}>
                Slug <code style={code}>{settings.slug}</code> · Zona {settings.timezone}
              </p>
            </header>
            <CommissionModel settings={settings} />
          </Card>

          <Card style={{ padding: '1.5rem' }}>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <Input
                label="Comisión OxioPay (%)"
                type="text"
                value={formatPercent(settings.platformCommissionBps)}
                readOnly
                disabled
                hint="Lo que cobra la plataforma sobre cada cobro. La fija OxioPay: para cambiarla, habla con soporte."
              />

              <Input
                label="Tope cobro por chica (€)"
                type="text"
                inputMode="decimal"
                value={form.maxCobroEur}
                onChange={(e) => setField('maxCobroEur', e.target.value)}
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
                  Comisión por defecto que se lleva quien crea el cobro (chica/camarero) según el tipo de cobro. Las
                  chicas con <code style={code}>commissionBps</code> individual
                  <strong> sobreescriben</strong> el valor de <em>"Servicio de chica"</em> pero las
                  categorías VENUE_* siempre usan estos defaults.
                </p>

                <Input
                  label="Servicio de chica (%)"
                  type="text"
                  inputMode="decimal"
                  value={form.chicaServicePct}
                  onChange={(e) => setField('chicaServicePct', e.target.value)}
                  disabled={!isOwner || submitting}
                  hint="% al crear cobro tipo 'Mi servicio'. Default 90%. Override por chica si tiene commissionBps."
                />
                <Input
                  label="Bar / Bebida (%)"
                  type="text"
                  inputMode="decimal"
                  value={form.venueBarPct}
                  onChange={(e) => setField('venueBarPct', e.target.value)}
                  disabled={!isOwner || submitting}
                  hint="% al crear cobro bar (ingreso del local). Default 0% — el camarero no se lleva nada."
                />
                <Input
                  label="Habitación (%)"
                  type="text"
                  inputMode="decimal"
                  value={form.venueRoomPct}
                  onChange={(e) => setField('venueRoomPct', e.target.value)}
                  disabled={!isOwner || submitting}
                  hint="% al crear cobro habitación. Default 0%."
                />
                <Input
                  label="Comida (%)"
                  type="text"
                  inputMode="decimal"
                  value={form.venueFoodPct}
                  onChange={(e) => setField('venueFoodPct', e.target.value)}
                  disabled={!isOwner || submitting}
                  hint="% al crear cobro comida. Default 0%."
                />
                <Input
                  label="Otros (%)"
                  type="text"
                  inputMode="decimal"
                  value={form.extraPct}
                  onChange={(e) => setField('extraPct', e.target.value)}
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
                <p role="status" style={{ color: 'var(--np-success)', margin: 0, fontSize: '0.875rem' }}>
                  Guardado
                </p>
              ) : null}

              {isOwner ? (
                <Button type="submit" loading={submitting}>
                  Guardar
                </Button>
              ) : (
                <p style={{ color: 'var(--np-text-mute)', fontSize: '0.85rem', margin: 0 }}>
                  Solo el dueño puede modificar los ajustes del local.
                </p>
              )}
            </form>
          </Card>
        </>
      )}

      <TwoFactorCard />
    </div>
  );
}

/** Reparto con los porcentajes de verdad (antes el ejemplo decía "10 €" y "local 0 €" siempre). */
function CommissionModel({ settings }: { settings: VenueSettings }) {
  const chicaBps = settings.operatorCommissionDefaults.CHICA_SERVICE;
  const example = splitExample(100_00, settings.platformCommissionBps, chicaBps);
  return (
    <div style={modelInfo}>
      <p style={modelHeading}>Modelo de comisiones</p>
      <p style={modelText}>
        Cada cobro se reparte entre <strong>OxioPay</strong> (comisión plataforma) y la <strong>chica</strong> (su{' '}
        <code style={code}>commissionBps</code> personal). El resto queda para el local.
      </p>
      <p style={modelText}>
        <strong>Hoy:</strong> OxioPay {formatPercent(settings.platformCommissionBps)} · chica lo que le hayas asignado
        (por defecto {formatPercent(chicaBps)}) · el local, el resto.
      </p>
      <p style={modelText}>
        Ejemplo: un servicio de chica de {formatEur(100_00)} con la chica al {formatPercent(chicaBps)}: OxioPay{' '}
        {formatEur(example.platformCents)} · chica {formatEur(example.chicaCents)} · local{' '}
        {formatEur(example.venueCents)}.
      </p>
      {example.venueCents < 0 ? (
        <p style={{ ...modelText, color: 'var(--np-danger)' }}>
          Ojo: OxioPay y la chica suman más del 100 %; el local pone {formatEur(-example.venueCents)} en cada{' '}
          {formatEur(100_00)}.
        </p>
      ) : null}
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
