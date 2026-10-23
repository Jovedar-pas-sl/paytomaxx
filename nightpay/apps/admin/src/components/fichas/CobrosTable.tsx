'use client';

import type { CSSProperties, ReactNode } from 'react';
import { StatusPill, type PaymentStatus } from '@nightpay/ui';
import type { CobroRow } from '@nightpay/contracts';
import { formatDateTime } from '@/lib/dates';
import { formatEur, formatMoney } from '@/lib/money';
import { paidTwiceNote, sectionChip } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { useFichas } from './fichas-context';
import { SectionChip } from './SectionChip';

interface Props {
  rows: CobroRow[] | null;
  /** Columna de acciones (devolver, resolver…), solo en la lista de Cobros. */
  actions?: (row: CobroRow) => ReactNode;
  /** Texto cuando no hay ninguno (o mientras carga: rows = null). */
  empty: string;
  /** En la ficha de la chica no hace falta su nombre en cada fila. */
  hidePerson?: boolean;
  /** Columnas de más a la derecha (p. ej. el local en la ficha del saldo). */
  extra?: { label: string; cell: (row: CobroRow) => ReactNode };
}

/**
 * Cobros con su referencia, quién cobró, sección (color o «Varias»), cómo
 * pagó y lo que se vendió. En el móvil cada fila es una tarjeta (panel-tables.css).
 * Tocar a la chica o el saldo abre su ficha.
 */
export function CobrosTable({ rows, actions, empty, hidePerson, extra }: Props) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const fichas = useFichas();
  const colCount = 8 - (hidePerson ? 1 : 0) + (actions ? 1 : 0) + (extra ? 1 : 0);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="np-table">
        <thead>
          <tr>
            <th>Hora</th>
            <th>Ref</th>
            <th style={{ textAlign: 'right' }}>Importe</th>
            <th>Estado</th>
            {hidePerson ? null : <th>Chica</th>}
            <th>Sección</th>
            <th>Cómo pagó</th>
            <th>Servicio</th>
            {extra ? <th>{extra.label}</th> : null}
            {actions ? <th style={{ textAlign: 'right' }}>Acciones</th> : null}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row) => (
            <tr key={`${row.kind}-${row.id}`}>
              <td data-label="Hora" data-card="top" style={meta}>
                {formatDateTime(row.createdAt, tz, 'short')}
              </td>
              <td data-label="Ref" data-card="top" className="np-num" style={{ ...meta, fontWeight: 700 }}>
                {row.ref ?? '—'}
              </td>
              <td data-label="Importe" data-card="amount" className="np-num" style={amountCell}>
                {formatMoney(row.amountCents, row.currency)}
                {row.tipCents > 0 ? <span style={tipStyle}>+ {formatEur(row.tipCents)} propina</span> : null}
              </td>
              <td data-label="Estado" data-card="status">
                {row.kind === 'SALDO' ? (
                  row.status === 'REVERSED' ? <Pill tone="neutral">Anulado</Pill> : <Pill tone="success">Pagado</Pill>
                ) : (
                  <StatusPill status={row.status as PaymentStatus} size="sm" />
                )}
                <PaidTwice row={row} />
              </td>
              {hidePerson ? null : (
                <td data-label="Chica">
                  {row.person ? (
                    fichas && row.person.role === 'OPERATOR' ? (
                      <button type="button" style={linkStyle} onClick={() => fichas.openOperator(row.person!.id)}>
                        {row.person.name}
                      </button>
                    ) : (
                      row.person.name
                    )
                  ) : (
                    '—'
                  )}
                </td>
              )}
              <td data-label="Sección">
                <SectionChip view={sectionChip(row, sections, (c) => formatEur(c))} />
              </td>
              <td data-label="Cómo pagó" style={meta}>
                {row.wallet && fichas ? (
                  <button type="button" style={linkStyle} onClick={() => fichas.openWallet(row.wallet!.id)}>
                    {row.method === 'SALDO' ? row.methodLabel : `${row.methodLabel} · saldo ${row.wallet.codeHint}`}
                  </button>
                ) : (
                  row.methodLabel
                )}
              </td>
              <td data-label="Servicio" style={meta}>
                {row.service ?? '—'}
                {row.invited ? <span style={{ display: 'block' }}>Invitación a {row.invited.name}</span> : null}
              </td>
              {extra ? (
                <td data-label={extra.label} style={meta}>
                  {extra.cell(row)}
                </td>
              ) : null}
              {actions ? (
                <td data-label="Acciones" data-card="actions" style={{ textAlign: 'right' }}>
                  {actions(row)}
                </td>
              ) : null}
            </tr>
          ))}
          {rows === null || rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} style={emptyCell}>
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** Cobrado dos veces (el saldo y, después, la tarjeta): la fila con tarjeta lo dice debajo del estado. */
function PaidTwice({ row }: { row: CobroRow }) {
  const note = paidTwiceNote(row, formatEur);
  if (!note) return null;
  return (
    <span style={paidTwiceStyle(row.paidTwice?.refunded === true)} role="note">
      {note}
    </span>
  );
}

const paidTwiceStyle = (refunded: boolean): CSSProperties => ({
  display: 'block',
  marginTop: '0.35rem',
  maxWidth: '14rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  lineHeight: 1.3,
  color: refunded ? 'var(--np-text-mute)' : 'var(--np-danger)',
});

const meta: CSSProperties = { color: 'var(--np-text-mute)' };
const amountCell: CSSProperties = { textAlign: 'right', fontWeight: 500 };
const tipStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 500,
  color: 'var(--np-text-dim)',
  fontFamily: 'var(--np-font-sans)',
  letterSpacing: 0,
};
const emptyCell: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  fontSize: '0.875rem',
};
const linkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  // Enlace en el color del texto, subrayado (el lima es para la acción principal).
  color: 'var(--np-text)',
  fontWeight: 600,
  textDecoration: 'underline',
  textUnderlineOffset: '0.15em',
  cursor: 'pointer',
  textAlign: 'inherit',
};
