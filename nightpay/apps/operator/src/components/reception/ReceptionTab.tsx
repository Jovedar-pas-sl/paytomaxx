'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import { useVenueMethods } from '@/lib/venue-methods';
import { PrepareFichas } from './PrepareFichas';
import { ReceptionFlow } from './ReceptionFlow';
import { useChipReader } from './use-chip-via';

/**
 * Recepción desde el móvil del personal: recargar el saldo (tarjeta con el QR
 * en su móvil, o efectivo), darle la ficha (Android: Web NFC) y que elija su
 * PIN; y «Preparar fichas» para el stock (solo Android con Chrome).
 */
export function ReceptionTab() {
  const methods = useVenueMethods();
  const reader = useChipReader();
  const [view, setView] = useState<'menu' | 'reception' | 'prepare'>('menu');

  if (view === 'reception') return <ReceptionFlow on="staff" onDone={() => setView('menu')} />;
  if (view === 'prepare') return <PrepareFichas on="staff" onDone={() => setView('menu')} />;

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Recepción</p>
      <p style={big}>Recargar el saldo del cliente</p>
      <p style={muted}>Con tarjeta (paga en su móvil) o en efectivo; le das la ficha y elige su PIN.</p>
      <Button size="lg" onClick={() => setView('reception')}>
        Nueva recarga
      </Button>
      {methods.nfc ? (
        <>
          <Button size="lg" variant="ghost" disabled={!reader.via || !reader.canWrite} onClick={() => setView('prepare')}>
            Preparar fichas
          </Button>
          {!reader.loading && (!reader.via || !reader.canWrite) ? <p style={note}>{reader.note}</p> : null}
        </>
      ) : null}
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
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '1rem' };
const big: CSSProperties = { margin: 0, fontSize: '1.375rem', fontWeight: 700 };
const note: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.9rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  fontSize: '0.9rem',
  color: 'var(--np-text-mute)',
};
