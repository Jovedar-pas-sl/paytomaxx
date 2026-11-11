'use client';

import React, { useState, type CSSProperties } from 'react';
import { HOME_TOPUP_ORIGIN_LABEL, type CobroRow } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { Pill } from '../Pill';

/** Datos con los que el dueño encuentra el cobro en el banco (y su origen, si lo cargó el cliente desde casa). */
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
      {/* «Cargar saldo antes de llegar»: no lo cobró nadie del local (lo decide el API, sin mandar la clave). */}
      {row.fromHome ? <div style={fieldStyle}>
        <span>Origen</span>
        <Pill tone="info" style={{ justifySelf: 'end' }}>{HOME_TOPUP_ORIGIN_LABEL}</Pill>
        <span style={noteStyle}>El cliente cargó el saldo con el enlace del local, antes de llegar.</span>
      </div> : null}
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
const noteStyle: CSSProperties = { gridColumn: '1 / -1', fontSize: '0.875rem', color: 'var(--np-text-mute)' };
