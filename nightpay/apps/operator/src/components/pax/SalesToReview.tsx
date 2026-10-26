'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { clearSaleToReview, type SaleToReview } from '@/lib/pax-api';
import { voidSaleOnReader } from '@/lib/pax-void';
import { formatEur } from '@/lib/money';

interface Props {
  entries: SaleToReview[];
  /** Hay lector (dentro de la app del datáfono): se puede anular desde aquí. */
  reader: boolean;
  /** Algo cambió (anulada, quitada): la pantalla vuelve a leer la lista. */
  onChanged: () => void;
}

/**
 * Ventas cobradas en el lector que OxioPay no admitió (doble cobro, otro
 * importe, un rechazo) o anulaciones que no tiene: arriba en /pax, con
 * «Anular en el datáfono», hasta que se resuelven (A2-02, A2-03). Antes el
 * reenvío las borraba sin avisar a nadie.
 */
export function SalesToReview({ entries, reader, onChanged }: Props) {
  if (entries.length === 0) return null;
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {entries.map((e) => (
        <ReviewCard key={`${e.paymentId}:${e.operationNumber ?? ''}`} entry={e} reader={reader} onChanged={onChanged} />
      ))}
    </div>
  );
}

function ReviewCard({ entry, reader, onChanged }: { entry: SaleToReview; reader: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Quitar el aviso pide un segundo toque: solo si ya se anuló o lo ha visto el encargado.
  const [confirming, setConfirming] = useState(false);
  const { voidable, operationNumber } = entry;

  async function voidIt() {
    if (!voidable || !operationNumber) return;
    setBusy(true);
    const out = await voidSaleOnReader({ paymentId: entry.paymentId, operationNumber, ...voidable });
    setBusy(false);
    setResult(out.message);
    onChanged();
  }

  return (
    <Card style={cardStyle}>
      <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>{entry.title}</p>
      <p style={muted}>{entry.message}</p>
      <p style={muted}>
        {operationNumber ? `Operación ${operationNumber}` : 'Sin número de operación'}
        {voidable ? ` · ${formatEur(voidable.amountCents)}` : ''}
      </p>
      {result ? <p style={{ margin: 0 }}>{result}</p> : null}
      {voidable && operationNumber && reader ? (
        <Button loading={busy} onClick={() => void voidIt()}>
          Anular en el datáfono
        </Button>
      ) : null}
      {confirming ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            clearSaleToReview(entry.paymentId, operationNumber);
            onChanged();
          }}
        >
          Sí: ya está anulada o lo sabe el encargado
        </Button>
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
          Ya está resuelto: quitar el aviso
        </Button>
      )}
    </Card>
  );
}

const cardStyle: CSSProperties = {
  padding: '1rem 1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  border: '2px solid var(--np-warning)',
};
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
