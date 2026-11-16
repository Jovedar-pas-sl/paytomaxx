'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { formatMoney, type ReservationAccounting } from '@nightpay/contracts';
import { fetchAccounting, fetchReservationSettings, setOpenTime, setReservationsEnabled, type ReservationSettings } from '@/lib/endpoints/reservations';
import { addDays, currentNight } from '@/lib/reservations';

/**
 * El enlace del local para reservar desde la web (lo enciende el dueño) y
 * «Señales de reservas»: la contabilidad aparte de las ventas hasta el día de
 * la reserva (lo cobrado, lo que pasó a venta, lo que pasó a saldo y lo que
 * se debe a clientes que aún no han venido).
 */
export function ReservationsLinkCard({ isOwner }: { isOwner: boolean }) {
  const [settings, setSettings] = useState<ReservationSettings | null>(null);
  const [from, setFrom] = useState(addDays(currentNight(), -30));
  const [to, setTo] = useState(currentNight());
  const [acc, setAcc] = useState<(ReservationAccounting & { toSaldoCents: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openTime, setOpenTimeText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchReservationSettings().then(
      (s) => {
        setSettings(s);
        setOpenTimeText(s.openTime);
      },
      (err: Error) => setError(err.message),
    );
  }, []);
  useEffect(() => {
    if (from > to) return;
    fetchAccounting(from, to).then(setAcc, (err: Error) => setError(err.message));
  }, [from, to]);

  async function toggle(): Promise<void> {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await setReservationsEnabled(!settings.enabled));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveOpenTime(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSettings(await setOpenTime(openTime));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={stack}>
      <section style={box} aria-label="Hora de apertura">
        <h3 style={h3}>Hora de apertura</h3>
        <p className="np-set-note" style={{ margin: 0 }}>
          Las 48 h para cambiar la fecha o anular cuentan desde aquí. Para esta misma noche se reserva hasta 2 h antes.
        </p>
        <div style={row}>
          <input type="time" style={{ ...input, flex: '0 1 9rem' }} value={openTime} onChange={(e) => setOpenTimeText(e.target.value)} aria-label="Hora de apertura" />
          <Button variant="ghost" size="sm" loading={busy} disabled={!settings || openTime === settings.openTime || !openTime} onClick={() => void saveOpenTime()}>
            Guardar hora
          </Button>
        </div>
      </section>
      <section style={box} aria-label="Reservar desde la web">
        <h3 style={h3}>Reservar desde la web</h3>
        <p className="np-set-note" style={{ margin: 0 }}>
          Un enlace del local para reservar y pagar la señal o todo con tarjeta. Los RRPP tienen el suyo.
        </p>
        {settings ? (
          <p style={line}>
            {settings.enabled ? 'Encendido' : 'Apagado'}
            {isOwner ? (
              <>
                {' '}
                <Button variant="ghost" size="sm" loading={busy} onClick={() => void toggle()}>
                  {settings.enabled ? 'Apagar' : 'Encender'}
                </Button>
              </>
            ) : null}
          </p>
        ) : null}
        {settings?.enabled && settings.url ? (
          <div style={row}>
            <input readOnly style={input} value={settings.url} aria-label="Enlace para reservar" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(settings.url ?? '').then(() => setCopied(true), () => setError('Cópialo a mano'))}
            >
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        ) : null}
      </section>
      <section style={box} aria-label="Señales de reservas">
        <h3 style={h3}>Señales de reservas</h3>
        <p className="np-set-note" style={{ margin: 0 }}>
          Lo cobrado de reservas va aparte de las ventas: pasa a venta el día de la reserva (al llegar, o la señal si no vienen).
        </p>
        <div style={row}>
          <input type="date" style={input} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde la noche" />
          <input type="date" style={input} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hasta la noche" />
        </div>
        {acc ? (
          <dl style={grid}>
            <dt>Cobrado de reservas</dt>
            <dd>{formatMoney(acc.collectedCents)}</dd>
            <dt>Pasado a venta</dt>
            <dd>{formatMoney(acc.recognizedCents)}</dd>
            <dt>Pasado a saldo del cliente</dt>
            <dd>{formatMoney(acc.toSaldoCents)}</dd>
            <dt>Comisión de RRPP</dt>
            <dd>{formatMoney(acc.promoterCommissionCents)}</dd>
            <dt>Pendiente hoy (aún no han venido)</dt>
            <dd>{formatMoney(acc.outstandingCents)}</dd>
          </dl>
        ) : null}
      </section>
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const box: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.875rem 1rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const h3: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const line: CSSProperties = { margin: 0, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.375rem 1rem', margin: 0, fontSize: '0.875rem' };
const input: CSSProperties = {
  flex: '1 1 10rem',
  minWidth: 0,
  minHeight: '2.75rem',
  padding: '0 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: '0.875rem',
};
