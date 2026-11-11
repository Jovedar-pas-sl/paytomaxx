'use client';

import { useState, type FormEvent } from 'react';
import type { WalletByPhone } from '@nightpay/contracts';
import { Button, Card, Input } from '@nightpay/ui';
import { findWalletsByPhone } from '@/lib/endpoints/wallets';
import { formatEur } from '@/lib/money';
import { useFichas } from './fichas/fichas-context';

/**
 * Clientes → Saldos: encontrar el saldo de quien lo ha perdido todo (la ficha
 * y el código) por el teléfono que dejó al darle la ficha. El teléfono es un
 * dato personal: no sale en la lista; se ve en el detalle del saldo.
 */
export function WalletPhoneSearch() {
  const fichas = useFichas();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<WalletByPhone[] | null>(null);

  async function search(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setFound(await findWalletsByPhone(phone));
    } catch (err) {
      setError((err as Error).message);
      setFound(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1rem' }}>
      <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>¿Lo ha perdido todo?</h3>
      <p style={{ margin: '0.25rem 0 0.75rem', fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
        Busca su saldo por el teléfono que dejó al darle la ficha (si lo dejó).
      </p>
      <form onSubmit={(e) => void search(e)} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Input label="Teléfono" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
        <Button type="submit" variant="ghost" loading={busy} disabled={phone.trim().length < 6}>
          Buscar
        </Button>
      </form>
      {error ? <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', color: 'var(--np-danger-text)' }}>{error}</p> : null}
      {found !== null ? (
        found.length === 0 ? (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem' }}>Ningún saldo con ese teléfono.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {found.map((w) => (
              <li key={w.walletId}>
                <Button variant="ghost" onClick={() => fichas?.openWallet(w.walletId)}>
                  {`${w.code} · ${formatEur(w.balanceCents)}`}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}