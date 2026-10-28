'use client';

import React, { useState, type CSSProperties } from 'react';
import type { CobroRow } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';

/** Datos con los que el dueño encuentra el cobro en el banco. */
export function PaymentReferenceDetails({ row }: { row: CobroRow }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setCopied('No se pudo copiar'); }
  };
  const field = (label: string, value: string | null | undefined) => (
    <div style={fieldStyle}>
      <span>{label}</span>
      <strong style={{ overflowWrap: 'anywhere' }}>{value || '—'}</strong>
      {value ? <Button type="button" variant="ghost" style={{ gridColumn: 2, justifySelf: 'end', minHeight: '2rem', padding: '0.25rem 0.9rem' }} onClick={() => void copy(label, value)} aria-label={`Copiar ${label}`}>Copiar</Button> : null}
    </div>
  );
  return (
    <div>
      {field('Código de confirmación', row.confirmationCode)}
      {field('Pedido del banco', row.payment?.providerTxId)}
      {field('Autorización del banco', row.payment?.authCode)}
      {copied ? <p role="status">{copied === 'No se pudo copiar' ? copied : `Copiado: ${copied}`}</p> : null}
      {row.payment?.attempts.length ? <>
        <h3>Intentos de pago</h3>
        <ul>{row.payment.attempts.map((a) => <li key={a.providerTxId}>
          {a.providerTxId} · {a.status === 'APPROVED' ? 'Aprobado' : a.status === 'DENIED' ? 'Denegado' : 'Sin respuesta'}
        </li>)}</ul>
      </> : null}
    </div>
  );
}

const fieldStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.35rem 0.75rem', padding: '0.75rem 0', borderBottom: '1px solid var(--np-border)' };
