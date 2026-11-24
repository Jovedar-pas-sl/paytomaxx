'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  DEFAULT_NIGHT_SETTINGS,
  nightSettingsOf,
  type ReceptionOptions,
  type VenueNightSettings,
} from '@nightpay/contracts';
import { Button, Card, Input } from '@nightpay/ui';
import { callReader, hasReader } from '@/lib/pax-bridge';
import { PRACTICE_PAX_TEXT, usePractice } from '@/lib/practice';
import {
  fetchPaxInfo,
  fetchPaxPending,
  flushPendingResults,
  flushPendingVoids,
  getDeviceToken,
  getPendingResults,
  getPendingVoids,
  getSalesToReview,
  pairDevice,
  PaxApiError,
  reportPaxShift,
  type PaxCharge,
  type PaxInfo,
  type SaleToReview,
  type ShiftSummary,
} from '@/lib/pax-api';
import { shiftSummaryText } from '@/lib/pax-flow';
import { setVenueFeedback } from '@/lib/alert-sound';
import { formatEur } from '@/lib/money';
import { posChargeLine } from '@/lib/cobro-view';
import { deviceBackend } from '@/lib/reception';
import { VenueNightContext } from '@/lib/venue-methods';
import { usePolling } from '@/lib/use-polling';
import { PrepareFichas } from '../reception/PrepareFichas';
import { ReceptionFlow } from '../reception/ReceptionFlow';
import { PaxChargeFlow } from './PaxChargeFlow';
import { PaxSaldoFlow } from './PaxSaldoFlow';
import { SalesToReview } from './SalesToReview';

const POLL_MS = 3000;

/**
 * Pantalla del datáfono PAX (se abre dentro de la app OxioPay del aparato).
 * El camarero ve los cobros que han creado las chicas, toca uno y el cliente
 * acerca la tarjeta: el cobro queda pagado y asignado sin teclear nada. Con
 * los ajustes de la noche del local (el teclado del PIN), que dice /me.
 */
export function PaxScreen() {
  const [night, setNight] = useState<VenueNightSettings>(DEFAULT_NIGHT_SETTINGS);
  return (
    <VenueNightContext.Provider value={night}>
      <PaxScreenView onNight={setNight} />
    </VenueNightContext.Provider>
  );
}

function PaxScreenView({ onNight }: { onNight: (night: VenueNightSettings) => void }) {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [info, setInfo] = useState<PaxInfo | null>(null);
  const [charges, setCharges] = useState<PaxCharge[]>([]);
  const [selected, setSelected] = useState<PaxCharge | null>(null);
  // «Cobrar con saldo»: ficha NFC, QR del cliente o código + su PIN en el datáfono.
  const [saldo, setSaldo] = useState(false);
  // Recepción (recargar saldo, ficha y PIN) y «Preparar fichas».
  const [desk, setDesk] = useState<'reception' | 'prepare' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ventas aprobadas que aún no han llegado a OxioPay: mientras haya, no se cobra otra.
  const [unsent, setUnsent] = useState(0);
  // Ventas cobradas en el lector que OxioPay no admitió: a anular o revisar (A2-02, A2-03).
  const [review, setReview] = useState<SaleToReview[]>([]);
  // Anulaciones hechas en el lector que aún no han llegado a OxioPay (A2-07).
  const [voidsUnsent, setVoidsUnsent] = useState(0);
  // Lo que ofrece la recepción en este local (fichas, recargas). null: aún no se sabe (sale todo).
  const [desks, setDesks] = useState<ReceptionOptions | null>(null);

  const readStored = useCallback(() => {
    setUnsent(getPendingResults().length);
    setReview(getSalesToReview());
    setVoidsUnsent(getPendingVoids().length);
  }, []);

  useEffect(() => {
    setPaired(Boolean(getDeviceToken()));
    readStored();
  }, [readStored]);

  /** /me decide si sigue vinculado: si responde 401, el aparato se olvida y se vuelve a vincular. */
  const checkPairing = useCallback(async () => {
    try {
      const me = await fetchPaxInfo();
      setInfo(me);
      const night = nightSettingsOf(me.night);
      setVenueFeedback({ sound: night.feedbackSound, vibration: night.feedbackVibration });
      onNight(night);
    } catch (err) {
      setError((err as Error).message);
    }
    if (!getDeviceToken()) setPaired(false);
  }, [onNight]);

  useEffect(() => {
    if (paired) void checkPairing();
  }, [paired, checkPairing]);

  // Formas de cobro apagadas por el dueño: sus botones no salen (el API las rechazaría).
  useEffect(() => {
    if (!paired) return;
    deviceBackend
      .options()
      .then(setDesks)
      .catch(() => setDesks(null));
  }, [paired, desk]);

  // Sin solapes y en pausa con la pantalla apagada o durante un cobro.
  const refresh = usePolling(
    async (signal) => {
      // Una venta aprobada que no llegó a OxioPay (y los avisos de anulación) se reenvían antes que nada.
      await flushPendingResults();
      await flushPendingVoids();
      readStored();
      try {
        setCharges(await fetchPaxPending(signal));
        setError(null);
      } catch (err) {
        if (signal.aborted) return 'slow';
        setError((err as Error).message);
        // ¿Lo desvincularon en el panel? Antes no se notaba hasta reiniciar.
        if (err instanceof PaxApiError && err.status === 401) await checkPairing();
        return 'slow';
      }
    },
    { intervalMs: POLL_MS, enabled: paired === true && selected === null && !saldo && desk === null },
  );

  // Al cerrar el cobro vuelve el sondeo (y con él, la lista al momento).
  const closeCharge = useCallback(() => setSelected(null), []);
  const closeSaldo = useCallback(() => setSaldo(false), []);
  const closeDesk = useCallback(() => setDesk(null), []);
  // Antes de los return tempranos: un hook después cambia su número al vincular y React rompe la pantalla.
  const practice = usePractice();

  if (paired === null) return <main className="np-screen" style={mainStyle} />;
  if (!paired) {
    return (
      <main className="np-screen" style={mainStyle}>
        <PairingForm
          onPaired={(i) => {
            setInfo(i);
            setPaired(true);
          }}
        />
      </main>
    );
  }

  if (selected) {
    return (
      <main className="np-screen" style={mainStyle}>
        <PaxChargeFlow charge={selected} onDone={closeCharge} />
      </main>
    );
  }

  if (saldo) {
    return (
      <main className="np-screen" style={mainStyle}>
        <PaxSaldoFlow onDone={closeSaldo} />
      </main>
    );
  }

  if (desk) {
    return (
      <main className="np-screen" style={mainStyle}>
        {desk === 'reception' ? <ReceptionFlow on="device" onDone={closeDesk} /> : <PrepareFichas on="device" onDone={closeDesk} />}
      </main>
    );
  }

  const reader = hasReader();
  // Un cobro con una venta del lector por anular o revisar no se vuelve a cobrar: el cliente ya pagó.
  const onHold = new Set(review.filter((r) => r.kind !== 'voidUnknown').map((r) => r.paymentId));
  return (
    <main className="np-screen" style={mainStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem' }}>
        <div>
          <p style={kicker}>{info?.venueName ?? 'OxioPay'}</p>
          <h1 style={{ margin: 0, fontSize: 'var(--np-fs-22)' }}>
            {info?.terminal.label ?? 'Datáfono'}
            {info?.terminal.zone ? <span style={muted}> · {info.terminal.zone.toLowerCase()}</span> : null}
          </h1>
        </div>
        <span style={{ ...badge, color: reader ? 'var(--np-success)' : 'var(--np-warning)' }}>
          {reader ? 'Lector listo' : 'Sin lector'}
        </span>
      </header>

      {practice ? <p style={warnBox}>{PRACTICE_PAX_TEXT}</p> : !reader ? (
        <p style={warnBox}>Para cobrar, abre esta pantalla desde la app OxioPay del datáfono.</p>
      ) : null}
      {unsent > 0 ? (
        <div role="status" style={{ ...warnBox, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <span>
            {unsent === 1 ? 'Hay un cobro aprobado' : `Hay ${unsent} cobros aprobados`} pendiente{unsent === 1 ? '' : 's'} de
            enviar a OxioPay: se reenvía solo. Hasta que llegue no se puede cobrar otro.
          </span>
          <Button variant="ghost" onClick={refresh}>
            Reenviar ahora
          </Button>
        </div>
      ) : null}
      <SalesToReview entries={review} reader={reader} onChanged={readStored} />
      {voidsUnsent > 0 ? (
        <p role="status" style={warnBox}>
          {voidsUnsent === 1 ? 'Hay una anulación' : `Hay ${voidsUnsent} anulaciones`} hecha{voidsUnsent === 1 ? '' : 's'} en el
          datáfono sin avisar a OxioPay: se reenvía{voidsUnsent === 1 ? '' : 'n'} sola{voidsUnsent === 1 ? '' : 's'}.
        </p>
      ) : null}
      {error ? <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}

      {/* «Pago con saldo» apagado por el dueño (lo dice /me): no se ofrece. */}
      {info?.wallet === false ? null : (
        <Button size="lg" variant="ghost" onClick={() => setSaldo(true)}>
          Cobrar con saldo (ficha, QR o código + PIN)
        </Button>
      )}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {desks && !desks.card && !desks.cash ? null : (
          <Button size="lg" variant="ghost" disabled={unsent > 0} onClick={() => setDesk('reception')} style={{ flex: 1 }}>
            Recepción: recargar saldo
          </Button>
        )}
        {desks && !desks.nfc ? null : (
          <Button size="lg" variant="ghost" onClick={() => setDesk('prepare')} style={{ flex: 1 }}>
            Preparar fichas
          </Button>
        )}
      </div>

      {charges.length === 0 ? (
        <Card style={{ padding: '2rem 1.25rem', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 'var(--np-fs-18)', fontWeight: 600 }}>No hay cobros esperando.</p>
          <p style={{ ...muted, margin: '0.5rem 0 0' }}>Cuando una chica cree un cobro por datáfono, sale aquí.</p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {charges.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={!reader || unsent > 0 || onHold.has(c.id)}
              onClick={() => setSelected(c)}
              style={{ ...chargeBtn, borderColor: c.forThisTerminal ? 'var(--np-accent)' : 'var(--np-border-hi)' }}
            >
              <span className="np-num" style={{ fontSize: 'var(--np-fs-28)', fontWeight: 700 }}>
                {formatEur(c.amountCents)}
              </span>
              <span style={{ fontSize: 'var(--np-fs-16)', fontWeight: 600 }}>{c.createdByName}</span>
              {c.serviceFeeCents ? <span style={muted}>{posChargeLine(c)}</span> : null}
              <span style={muted}>
                Código {c.code}
                {c.zone ? ` · ${c.zone.toLowerCase()}` : ''} · hace {minutesAgo(c.createdAt)}
              </span>
              {onHold.has(c.id) ? (
                <span style={{ ...muted, color: 'var(--np-warning)' }}>Ya cobrado en el datáfono: revísalo arriba, no lo cobres otra vez.</span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {reader ? <ShiftCheck /> : null}
    </main>
  );
}

function PairingForm({ onPaired }: { onPaired: (info: PaxInfo) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onPaired(await pairDevice(code));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h1 style={{ margin: 0, fontSize: 'var(--np-fs-22)' }}>Vincular este datáfono</h1>
      <p style={{ ...muted, margin: 0 }}>
        En el panel: Datáfonos → este datáfono → Vincular app. Teclea aquí el código que sale (vale 15 minutos).
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Input
          label="Código"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD-2345"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={12}
          size="lg"
          style={{ textAlign: 'center', letterSpacing: '0.15em', fontFamily: 'var(--np-font-mono)' }}
        />
        {error ? <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}
        <Button type="submit" size="lg" loading={busy}>
          Vincular
        </Button>
      </form>
    </Card>
  );
}

/** Cuadre con el cierre de jornada del datáfono: ventas que no están en OxioPay. */
function ShiftCheck() {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ShiftSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await callReader('shiftList');
      if (!r.ok) throw new Error(r.message ?? 'El lector no dio la lista de operaciones');
      setSummary(await reportPaxShift(r.transactions ?? []));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Button variant="ghost" loading={busy} onClick={() => void run()}>
        Cuadrar con el datáfono
      </Button>
      {summary ? (
        <p style={{ margin: 0, ...(summary.total === 0 ? { color: 'var(--np-warning)' } : {}) }}>{shiftSummaryText(summary)}</p>
      ) : null}
      {error ? <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}
    </Card>
  );
}

function minutesAgo(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return min < 1 ? 'un momento' : `${min} min`;
}

const mainStyle: CSSProperties = {
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  maxWidth: '40rem',
  margin: '0 auto',
};
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const muted: CSSProperties = { color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-16)' };
const badge: CSSProperties = { fontSize: 'var(--np-fs-14)', fontWeight: 700 };
const warnBox: CSSProperties = {
  margin: 0,
  border: '2px solid var(--np-warning)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem 1rem',
  color: 'var(--np-warning)',
};
const chargeBtn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.25rem',
  padding: '1rem 1.25rem',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-lg)',
  color: 'var(--np-text)',
  textAlign: 'left',
  cursor: 'pointer',
  minHeight: '6.5rem',
};
