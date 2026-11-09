'use client';

import { useState, type FormEvent } from 'react';
import type { AssignedTopUp, SaldoRefDto } from '@nightpay/contracts';
import { Button, Input } from '@nightpay/ui';
import { assignPendingTopUp } from '@/lib/api-noche';
import { formatEur } from '@/lib/money';
import { useVenueMethods } from '@/lib/venue-methods';
import { DESK_FIELD } from './desk/desk-parts';
import r from './reception.module.css';
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
    <div className={r.card}>
      <p className={r.kicker}>Recarga pendiente de asignar</p>
      <p className={r.amount}>{formatEur(amountCents)}</p>
      <p className={r.lead}>Ahora, su saldo</p>
      <p className={r.text}>Acerca su NFC o teclea su código: la recarga se suma a su saldo.</p>
      {nfcOn ? (
        reading ? (
          <Button variant="ghost" onClick={() => reading.abort()}>
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
      {nfcOn && !reader.loading && !reader.via && reader.note ? <p className={r.note}>{reader.note}</p> : null}
      <form onSubmit={byCode} className={r.form}>
        <Input
          label="Código del saldo"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          placeholder="K7Q-4M2"
          autoCapitalize="characters"
          autoComplete="off"
          disabled={busy}
          style={DESK_FIELD}
        />
        <Button type="submit" variant="ghost" loading={busy} disabled={code.replace(/-/g, '').length < 6}>
          Asignar con el código
        </Button>
      </form>
      {error ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" disabled={busy || reading !== null} onClick={onLater}>
        Más tarde
      </Button>
      <p className={r.note}>No se pierde: queda en Recepción → Pendientes de asignar (y en el panel).</p>
    </div>
  );
}
