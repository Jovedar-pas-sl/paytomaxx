'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card, HoldButton } from '@nightpay/ui';
import { clearSaleToReview, type SaleToReview } from '@/lib/pax-api';
import { voidNoticeOf, voidSaleOnReader, type VoidNotice, type VoidResult } from '@/lib/pax-void';
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
 * reenvío las borraba sin avisar a nadie. Lo que dijo el lector al anular se
 * queda aquí (con «Vale») aunque la venta salga de la lista: antes la tarjeta
 * desaparecía con el resultado y el camarero no veía la confirmación.
 */
export function SalesToReview({ entries, reader, onChanged }: Props) {
  const [notices, setNotices] = useState<VoidNotice[]>([]);
  if (entries.length === 0 && notices.length === 0) return null;

  function voided(notice: VoidNotice): void {
    setNotices((all) => [...all.filter((n) => n.key !== notice.key), notice]);
    onChanged();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {notices.map((n) => (
        <Card key={n.key} style={{ ...cardStyle, border: `2px solid ${n.ok ? 'var(--np-success)' : 'var(--np-warning)'}` }}>
          <p role="status" style={{ margin: 0, fontWeight: 600 }}>
            {n.text}
          </p>
          <Button variant="ghost" onClick={() => setNotices((all) => all.filter((x) => x.key !== n.key))}>
            Vale
          </Button>
        </Card>
      ))}
      {entries.length > 0 ? (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {entries.map((e) => (
            <ReviewCard key={`${e.paymentId}:${e.operationNumber ?? ''}`} entry={e} reader={reader} onChanged={onChanged} onVoided={voided} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReviewCard({
  entry,
  reader,
  onChanged,
  onVoided,
}: {
  entry: SaleToReview;
  reader: boolean;
  onChanged: () => void;
  /** Lo que dijo el lector (se enseña arriba, también si la venta sale de la lista). */
  onVoided: (notice: VoidNotice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { voidable, operationNumber } = entry;

  async function voidIt() {
    if (!voidable || !operationNumber) return;
    setBusy(true);
    const sale = { paymentId: entry.paymentId, operationNumber, ...voidable };
    const out: VoidResult = await voidSaleOnReader(sale);
    setBusy(false);
    onVoided(voidNoticeOf(sale, out));
  }

  return (
    <Card style={cardStyle}>
      <p style={{ margin: 0, fontWeight: 700, fontSize: 'var(--np-fs-16)' }}>{entry.title}</p>
      <p style={muted}>{entry.message}</p>
      <p style={muted}>
        {operationNumber ? `Operación ${operationNumber}` : 'Sin número de operación'}
        {voidable ? ` · ${formatEur(voidable.amountCents)}` : ''}
      </p>
      {voidable && operationNumber && reader ? (
        <Button loading={busy} onClick={() => void voidIt()}>
          Anular en el datáfono
        </Button>
      ) : null}
      {/* Quitar el aviso ya no pide un segundo toque: se mantiene pulsado 1,2 s (no mueve dinero). */}
      <HoldButton
        disabled={busy}
        onConfirm={() => {
          clearSaleToReview(entry.paymentId, operationNumber);
          onChanged();
        }}
      >
        Mantén para quitar el aviso: ya está resuelto
      </HoldButton>
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
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-16)' };
