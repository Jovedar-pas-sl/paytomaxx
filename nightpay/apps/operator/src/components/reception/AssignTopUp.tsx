'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import type { AssignedTopUp, SaldoRefDto } from '@nightpay/contracts';
import { Button, Card, Input } from '@nightpay/ui';
import { assignPendingTopUp } from '@/lib/api-noche';
import { formatEur } from '@/lib/money';
import { useVenueMethods } from '@/lib/venue-methods';
import { useReadNfc } from './use-read-nfc';

interface Props {
  /** El saldo provisional de la recarga pendiente. */
  walletId: string;
  amountCents: number;
  onAssigned: (out: AssignedTopUp) => void;
  /** Dejarla pendiente (se asigna luego en Recepción o en el panel). */
  onLater: () => void;
}

/**
 * Una recarga cobrada sin el NFC del cliente: se asigna a su saldo acercando
 * su NFC o tecleando su código. Si no se puede ahora, queda pendiente (nunca
 * se pierde: Recepción → Pendientes de asignar, o el panel).
 */
export function AssignTopUp({ walletId, amountCents, onAssigned, onLater }: Props) {
  const nfcOn = useVenueMethods().nfc;
  const { reader, reading, read } = useReadNfc();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(ref: () => Promise<SaldoRefDto>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      onAssigned(await assignPendingTopUp(walletId, await ref()));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function byCode(e: FormEvent): void {
    e.preventDefault();
    void assign(async () => ({ code }));
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Recarga pendiente de asignar</p>
      <p className="np-num" style={amountStyle}>
        {formatEur(amountCents)}
      </p>
      <p style={big}>Ahora, su saldo</p>
      <p style={muted}>Acerca su NFC o teclea su código: la recarga se suma a su saldo.</p>
      {nfcOn ? (
        reading ? (
          <Button size="lg" variant="ghost" onClick={() => reading.abort()}>
            Acerca su NFC… (cancelar)
          </Button>
        ) : (
          <Button
            size="lg"
            disabled={busy || !reader.via}
            onClick={() =>
              void assign(async () => {
                const nfc = await read();
                return nfc.uid ? { card: nfc.token, uid: nfc.uid } : { card: nfc.token };
              })
            }
          >
            Acercar su NFC
          </Button>
        )
      ) : null}
      {nfcOn && !reader.loading && !reader.via && reader.note ? <p style={note}>{reader.note}</p> : null}
      <form onSubmit={byCode} style={formStyle}>
        <Input
          label="Código del saldo"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          placeholder="K7Q-4M2"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={busy}
        />
        <Button type="submit" size="lg" variant="ghost" loading={busy} disabled={code.replace(/-/g, '').length < 6}>
          Asignar con el código
        </Button>
      </form>
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" disabled={busy || reading !== null} onClick={onLater}>
        Más tarde
      </Button>
      <p style={note}>No se pierde: queda en Recepción → Pendientes de asignar (y en el panel).</p>
    </Card>
  );
}

const cardStyle: CSSProperties = { padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)', textAlign: 'center' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const amountStyle: CSSProperties = { margin: 0, fontSize: '2.5rem', lineHeight: 1.15, fontWeight: 700 };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--np-danger)', fontWeight: 600 };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem', textAlign: 'left' };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
