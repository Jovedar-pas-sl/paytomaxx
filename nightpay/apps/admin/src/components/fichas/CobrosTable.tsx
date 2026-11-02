'use client';

import type { CSSProperties, ReactNode } from 'react';
import { HOME_TOPUP_ORIGIN_LABEL, type CobroRow } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { cobroStatus } from '@/lib/cobro-status';
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
  showReferences?: boolean;
  onDetails?: (row: CobroRow) => void;
  /** Columnas de más a la derecha (p. ej. el local en la ficha del saldo). */
  extra?: { label: string; cell: (row: CobroRow) => ReactNode };
}

/**
 * Cobros con su referencia, quién cobró («Desde casa» si lo cargó el cliente
 * con el enlace del local), sección (color o «Varias»), cómo pagó y lo que se
 * vendió. En el móvil cada fila es una tarjeta (panel-tables.css).
 * Tocar a la chica o el saldo abre su ficha.
 */
export function CobrosTable({ rows, actions, empty, hidePerson, extra, showReferences, onDetails }: Props) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const fichas = useFichas();
  const colCount = 8 - (hidePerson ? 1 : 0) + (actions ? 1 : 0) + (extra ? 1 : 0) + (showReferences ? 2 : 0);
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <table className={`np-table np-cobros-table${actions ? ' np-cobros-table--acciones' : ''}`} >
        <thead>
          <tr>
            <th>Hora</th>
            <th>Ref</th>
            {showReferences ? <><th>Código</th><th>Ref. banco</th></> : null}
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
              {/* Hora y referencia en una línea (antes «22 oct, / 18:31», «C- / 0025»). */}
              <td data-label="Hora" data-card="top" className="np-num" style={{ ...meta, ...oneLine }}>
                {formatDateTime(row.createdAt, tz, 'short')}
              </td>
              <td data-label="Ref" data-card="top" className="np-num" style={{ ...meta, ...oneLine, fontWeight: 700 }}>
                {row.ref ?? '—'}
              </td>
              {showReferences ? <>
                <td data-label="Código" className="np-num">{row.confirmationCode ?? '—'}</td>
                <td data-label="Ref. banco" style={meta}>
                  {row.payment?.providerTxId ?? '—'}
                  {row.payment?.authCode ? <span> · aut. {row.payment.authCode}</span> : null}
                </td>
              </> : null}
              <td data-label="Importe" data-card="amount" className="np-num" style={amountCell}>
                {formatMoney(row.amountCents, row.currency)}
                {/* La «Comisión del servicio» que pagó el cliente encima (se debe a OxioPay). */}
                {row.serviceFeeCents ? (
                  <span style={tipStyle}>+{'\u00a0'}{formatEur(row.serviceFeeCents)} comisión del servicio</span>
                ) : null}
                {row.tipCents > 0 ? <span style={tipStyle}>+{'\u00a0'}{formatEur(row.tipCents)} propina</span> : null}
              </td>
              <td data-label="Estado" data-card="status">
                {/* Una sola forma y una palabra por estado, con tarjeta o con el saldo. */}
                <Pill tone={cobroStatus(row).tone}>{cobroStatus(row).label}</Pill>
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
                  ) : row.fromHome ? (
                    // Nadie del local: lo cargó el cliente con el enlace del local, antes de llegar.
                    <Pill tone="info">{HOME_TOPUP_ORIGIN_LABEL}</Pill>
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
                    {row.method === 'SALDO' ? labelWithCode(row.methodLabel) : `${row.methodLabel} · saldo ${row.wallet.codeHint}`}
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
                  {onDetails ? <Button type="button" variant="ghost" onClick={() => onDetails(row)}>Ver detalle</Button> : null}
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

/** «Saldo K7Q-•••»: si no cabe, parte por el espacio, nunca por el guion del código. */
function labelWithCode(label: string): ReactNode {
  const space = label.lastIndexOf(' ');
  if (space < 0) return label;
  return <>{label.slice(0, space + 1)}<span style={oneLine}>{label.slice(space + 1)}</span></>;
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
const oneLine: CSSProperties = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const amountCell: CSSProperties = { textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
// Se puede partir (el importe de arriba, no): así la tabla cabe en un portátil.
// Con «comisión del» en una línea: más estrecho, «del» se queda sola.
const tipStyle: CSSProperties = {
  display: 'block',
  minWidth: '4.75rem',
  whiteSpace: 'normal',
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
