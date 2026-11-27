'use client';

import { useCallback, useState, type CSSProperties } from 'react';
import { Button, FormError } from '@nightpay/ui';
import { formatMoney, type ReservationCashQuote, type ReservationView } from '@nightpay/contracts';
import {
  arriveReservation,
  chargeReservation,
  collectRest,
  fetchCashQuote,
  payRestCash,
  fetchReservation,
  scanReservation,
  serveReservation,
  type ScannedReservation,
} from '@/lib/api-reservas';
import { amountCents, barMode, doorStep, newSpendKey, tonightInMadrid } from '@/lib/reservas';
import { CobroQr } from '../cobrar/CobroQr';
import { QrScanner, qrScanSupported } from '../QrScanner';

/**
 * «Reservados» (camarero, encargado, dueño). Se lee el QR de una persona del
 * grupo (su móvil) y, según la reserva:
 *  - en la puerta: si falta el resto, «Cobrar el resto» (el cliente lo paga
 *    con su móvil desde el QR); pagado entero, «Dar la llegada»;
 *  - en la barra (ya llegados): cobrar un importe del paquete o servir una
 *    cosa del paquete, apuntado a esa persona.
 */
export function ReservasTab() {
  const [scan, setScan] = useState<ScannedReservation | null>(null);
  const [raw, setRaw] = useState('');
  const [typed, setTyped] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(async (text: string) => {
    setScanning(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setScan(await scanReservation(text));
      setRaw(text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  const onScanError = useCallback((message: string) => {
    setScanning(false);
    setError(message);
  }, []);

  async function act(task: () => Promise<ReservationView>, done?: string): Promise<void> {
    if (!scan) return;
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      setScan({ ...scan, reservation: next });
      setNotice(done ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={page} aria-labelledby="reservas-title">
      <h2 id="reservas-title" style={title}>
        Reservados
      </h2>
      {!scan ? (
        <>
          <p style={note}>Lee el QR de cualquiera del grupo: en la puerta das la llegada; en la barra, gastan del paquete.</p>
          {scanning ? (
            <div style={scanBox}>
              <QrScanner onScan={(t) => void read(t)} onError={onScanError} />
            </div>
          ) : qrScanSupported() ? (
            <Button size="lg" loading={busy} onClick={() => setScanning(true)}>
              Leer el QR
            </Button>
          ) : null}
          <form
            style={row}
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void read(typed.trim());
            }}
          >
            <input style={input} value={typed} placeholder="O pega aquí el enlace del QR" onChange={(e) => setTyped(e.target.value)} aria-label="Enlace del QR" />
            <Button variant="ghost" type="submit" disabled={!typed.trim() || busy}>
              Buscar
            </Button>
          </form>
        </>
      ) : (
        <Scanned scan={scan} raw={raw} busy={busy} onAct={act} onRefresh={() => act(() => fetchReservation(scan.reservation.id))} />
      )}
      {notice ? (
        <p role="status" style={ok}>
          {notice}
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
      {scan ? (
        <Button
          variant="ghost"
          onClick={() => {
            setScan(null);
            setNotice(null);
            setError(null);
            setTyped('');
          }}
        >
          Leer otro QR
        </Button>
      ) : null}
    </section>
  );
}

function Scanned({
  scan,
  raw,
  busy,
  onAct,
  onRefresh,
}: {
  scan: ScannedReservation;
  raw: string;
  busy: boolean;
  onAct: (task: () => Promise<ReservationView>, done?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const r = scan.reservation;
  const guest = r.guests.find((g) => g.id === scan.guest.id);
  return (
    <>
      <article style={card}>
        <h2 style={h2}>
          {r.customerName} · persona {scan.guest.seq} de {r.entries}
        </h2>
        <p style={line}>
          {r.packageName} · {r.statusText}
          {r.tableLabel ? ` · Mesa ${r.tableLabel}` : ''}
        </p>
        <p style={line}>
          Pagado {formatMoney(r.paidCents)} de {formatMoney(r.priceCents)}
        </p>
        {r.notes ? <p style={line}>«{r.notes}»</p> : null}
      </article>
      <Door r={r} guestId={scan.guest.id} checkedIn={guest?.checkedIn ?? false} busy={busy} onAct={onAct} onRefresh={onRefresh} />
      <Bar r={r} raw={raw} busy={busy} onAct={onAct} />
    </>
  );
}

function Door({
  r,
  guestId,
  checkedIn,
  busy,
  onAct,
  onRefresh,
}: {
  r: ReservationView;
  guestId: string;
  checkedIn: boolean;
  busy: boolean;
  onAct: (task: () => Promise<ReservationView>, done?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [cash, setCash] = useState<(ReservationCashQuote & { key: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step = doorStep(r, tonightInMadrid());

  if (step.kind === 'blocked') return <FormError>{step.reason}</FormError>;
  if (step.kind === 'arrived') {
    return checkedIn ? (
      <p style={ok}>Ya ha llegado. Esta persona ya ha entrado.</p>
    ) : (
      <Button variant="ghost" loading={busy} onClick={() => void onAct(() => arriveReservation(r.id, guestId), 'Apuntado: ha entrado.')}>
        Apuntar que entra
      </Button>
    );
  }
  if (step.kind === 'arrive') {
    return (
      <Button size="lg" loading={busy} onClick={() => void onAct(() => arriveReservation(r.id, guestId), 'Llegada dada. Ya pueden gastar del paquete.')}>
        Dar la llegada
      </Button>
    );
  }
  return (
    <div style={card}>
      <p style={line}>Falta por pagar {formatMoney(step.pendingCents)}: con tarjeta (su móvil, con el QR) o en efectivo.</p>
      {payUrl ? (
        <>
          <div style={qrBox}>
            <CobroQr value={payUrl} fallbackPng={null} label="QR para pagar el resto del reservado" quiet={2} />
          </div>
          <Button variant="ghost" loading={busy} onClick={() => void onRefresh()}>
            Ya ha pagado: comprobar
          </Button>
        </>
      ) : cash ? (
        <>
          <p style={line}>
            Coge {formatMoney(cash.totalCents)} en efectivo
            {cash.serviceFeeCents > 0 ? ` (${formatMoney(cash.amountCents)} + ${formatMoney(cash.serviceFeeCents)} de comisión del servicio)` : ''} y pulsa el botón: entra en la caja de la noche.
          </p>
          <Button
            size="lg"
            loading={busy}
            onClick={() => void onAct(() => payRestCash(r.id, cash.key, cash.serviceFeeCents), `Pagado: ${formatMoney(cash.totalCents)} en efectivo. Ya puedes dar la llegada.`)}
          >
            Cobrar {formatMoney(cash.totalCents)} en efectivo
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setCash(null)}>
            Volver
          </Button>
        </>
      ) : (
        <>
          <Button
            size="lg"
            loading={busy}
            onClick={() => {
              setError(null);
              collectRest(r.id).then((out) => setPayUrl(out.payUrl), (err: Error) => setError(err.message));
            }}
          >
            Cobrar el resto con tarjeta
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setError(null);
              fetchCashQuote(r.id).then(
                (q) => (q.blocked ? setError(q.blocked) : setCash({ ...q, key: newSpendKey() })),
                (err: Error) => setError(err.message),
              );
            }}
          >
            En efectivo
          </Button>
        </>
      )}
      {error ? <FormError>{error}</FormError> : null}
    </div>
  );
}

function Bar({
  r,
  raw,
  busy,
  onAct,
}: {
  r: ReservationView;
  raw: string;
  busy: boolean;
  onAct: (task: () => Promise<ReservationView>, done?: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const mode = barMode(r);
  if (mode.kind === 'closed') return null;
  if (mode.kind === 'credit') {
    const cents = amountCents(text);
    return (
      <div style={card}>
        <h2 style={h2}>Barra · queda {formatMoney(mode.balanceCents)}</h2>
        <input style={input} inputMode="decimal" placeholder="Importe en €" value={text} onChange={(e) => setText(e.target.value)} aria-label="Importe" />
        <Button
          size="lg"
          loading={busy}
          disabled={cents === null || cents > mode.balanceCents}
          onClick={() => {
            if (cents === null) return;
            const key = newSpendKey();
            void onAct(() => chargeReservation(raw, cents, key), `Cobrado ${formatMoney(cents)} del reservado.`).then(() => setText(''));
          }}
        >
          {cents ? `Cobrar ${formatMoney(cents)} del reservado` : 'Cobrar del reservado'}
        </Button>
      </div>
    );
  }
  return (
    <div style={card}>
      <h2 style={h2}>Barra · lo que queda del paquete</h2>
      {mode.items.map((i) => (
        <div key={i.name} style={row}>
          <span style={{ ...line, flex: 1 }}>
            {i.name}: {i.left} de {i.qty}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || i.left < 1}
            onClick={() => {
              const key = newSpendKey();
              void onAct(() => serveReservation(raw, i.name, 1, key), `Servido: 1 ${i.name}.`);
            }}
          >
            Servir 1
          </Button>
        </div>
      ))}
    </div>
  );
}

// Como Mis cobros: el margen y el ancho los pone la app (Dashboard). Con los
// suyos encima, en el terminal se veía «ampliado» (título de 28 px y doble margen).
const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const title: CSSProperties = { margin: 0 };
const h2: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 700 };
const note: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', color: 'var(--np-text-mute)' };
const line: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)' };
const ok: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', color: 'var(--np-success)', fontWeight: 600 };
const row: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center' };
const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '1rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const scanBox: CSSProperties = { borderRadius: 'var(--np-r-md)', overflow: 'hidden' };
const qrBox: CSSProperties = { width: 'min(18rem, 80vw)', alignSelf: 'center', padding: '0.5rem', background: '#fff', borderRadius: 'var(--np-r-md)' };
const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: '3rem',
  padding: '0 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 'var(--np-fs-16)',
};
