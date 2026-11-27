'use client';

import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { HOME_TOPUP_ORIGIN_LABEL, type CobroRow } from '@nightpay/contracts';
import { EmptyState, Etiqueta, Importe } from '@nightpay/ui';
import { clickOpensRow, type DockKey } from '@/lib/cobro-dock';
import { cobroStatus } from '@/lib/cobro-status';
import { cobroPaidCents } from '@/lib/cobros-totals';
import { COBROS_COLUMNS, hourText, type CobrosColumn } from '@/lib/cobros-views';
import { formatEur } from '@/lib/money';
import { paidTwiceNote, sectionChip } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { SkelRows } from '../Skeleton';
import { useFichas } from './fichas-context';
import { MethodMark } from './MethodMark';
import { SectionChip } from './SectionChip';

interface Props {
  /** null: aún cargando. */
  rows: CobroRow[] | null;
  /** Cuando no hay ninguno: la frase y, si hay filtros que quitar, su botón. */
  empty: { title: string; text?: string; action?: { label: string; onClick: () => void } };
  /** En la ficha de la chica no hace falta su nombre en cada fila. */
  hidePerson?: boolean;
  /** Columnas de más: la referencia, el código del cliente y la referencia del banco. */
  columns?: readonly CobrosColumn[];
  /** Con él, la fila entera abre el detalle (clic, o Intro con el teclado). */
  onDetails?: (row: CobroRow) => void;
  /** El cobro abierto en el detalle: su fila va marcada. */
  current?: DockKey | null;
  /** Los últimos del Resumen: solo hora, qué, estado e importe, sin cabecera. */
  compact?: boolean;
}

const COLUMN_LABEL = Object.fromEntries(COBROS_COLUMNS.map((c) => [c.key, c.label])) as Record<CobrosColumn, string>;

/**
 * Cobros en seis columnas: hora, qué (sección y servicio), quién cobró («Desde
 * casa» si lo cargó el cliente con el enlace del local), cómo pagó, estado e
 * importe (lo que pagó el cliente: con propina y comisión del servicio). Filas
 * de 48 px; en el móvil cada una es una tarjeta de dos líneas
 * (panel-cobros.css). Tocar la fila abre su detalle; tocar a la chica o el
 * saldo, su ficha.
 */
export function CobrosTable({ rows, empty, hidePerson, columns = [], onDetails, current = null, compact = false }: Props) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const fichas = useFichas();
  const has = (c: CobrosColumn) => !compact && columns.includes(c);
  const showPerson = !hidePerson && !compact;
  // Las celdas de cada fila, en orden (también dan forma a las siluetas de carga).
  const cells = ['hora', has('ref') ? 'ref' : null, 'que', showPerson ? 'quien' : null, compact ? null : 'como', has('codigo') ? 'codigo' : null, has('banco') ? 'banco' : null, 'estado', 'importe'].filter(
    (c): c is string => c !== null,
  );
  const now = Date.now();

  function open(row: CobroRow) {
    if (!onDetails) return undefined;
    return {
      tabIndex: 0,
      'aria-current': current && current.kind === row.kind && current.id === row.id ? ('true' as const) : undefined,
      onClick: (e: MouseEvent<HTMLTableRowElement>) => {
        if (clickOpensRow(e.target as Element)) onDetails(row);
      },
      onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
        // Intro sobre la fila, no sobre un botón de dentro.
        if (e.key === 'Enter' && e.target === e.currentTarget) onDetails(row);
      },
    };
  }

  // Sin cobros no hay tabla que enseñar: la frase y, si hay filtros, cómo quitarlos.
  if (rows && rows.length === 0) {
    return (
      <div className="np-cobros-vacio">
        <EmptyState icon="list" title={empty.title} text={empty.text} action={empty.action} />
      </div>
    );
  }

  return (
    <div className="np-cobros-scroll">
    <table
      className="np-table np-cobros-table"
      aria-busy={rows === null}
      data-extra={!compact && columns.length > 0 ? '' : undefined}
      data-compact={compact ? '' : undefined}
      aria-label={compact ? 'Últimos cobros' : undefined}
    >
      {compact ? null : (
      <thead>
        <tr>
          <th data-card="hora">Hora</th>
          {has('ref') ? <th data-card="ref">{COLUMN_LABEL.ref}</th> : null}
          <th data-card="que">Qué</th>
          {hidePerson ? null : <th data-card="quien">Quién</th>}
          <th data-card="como">Cómo pagó</th>
          {has('codigo') ? <th data-card="codigo">{COLUMN_LABEL.codigo}</th> : null}
          {has('banco') ? <th data-card="banco">{COLUMN_LABEL.banco}</th> : null}
          <th data-card="estado">Estado</th>
          <th data-card="importe">Importe</th>
        </tr>
      </thead>
      )}
      <tbody>
        {(rows ?? []).map((row, i) => {
          const chip = sectionChip(row, sections, formatEur);
          const status = cobroStatus(row);
          return (
            <tr key={`${row.kind}-${row.id}`} style={rowStripe(chip.color)} {...open(row)}>
              <td data-card="hora" className="np-num">
                {hourText(row.createdAt, tz, now)}
              </td>
              {has('ref') ? (
                <td data-card="ref" className="np-num">
                  {row.ref ?? '—'}
                </td>
              ) : null}
              <td data-card="que" title={row.invited ? `Invitación a ${row.invited.name}` : undefined}>
                <span className="np-cobros-que">
                  <SectionChip view={chip} />
                  {row.service ? <span className="np-cobros-servicio">{row.service}</span> : null}
                </span>
              </td>
              {!showPerson ? null : (
                <td data-card="quien">
                  {row.person ? (
                    fichas && row.person.role === 'OPERATOR' ? (
                      <button type="button" className="np-cell-link" onClick={() => fichas.openOperator(row.person!.id)}>
                        {row.person.name}
                      </button>
                    ) : (
                      row.person.name
                    )
                  ) : row.fromHome ? (
                    // Nadie del local: lo cargó el cliente con el enlace del local, antes de llegar.
                    <Etiqueta tone="info" size="sm">
                      {HOME_TOPUP_ORIGIN_LABEL}
                    </Etiqueta>
                  ) : (
                    '—'
                  )}
                </td>
              )}
              {compact ? null : (
              <td data-card="como" title={row.methodLabel}>
                <MethodMark method={row.method}>
                  {row.wallet && fichas ? (
                    <button type="button" className="np-cell-link" onClick={() => fichas.openWallet(row.wallet!.id)}>
                      {row.method === 'SALDO' ? labelWithCode(row.methodLabel) : `${row.methodLabel} · saldo ${row.wallet.codeHint}`}
                    </button>
                  ) : (
                    row.methodLabel
                  )}
                </MethodMark>
              </td>
              )}
              {has('codigo') ? (
                <td data-card="codigo" className="np-num">
                  {row.confirmationCode ?? '—'}
                </td>
              ) : null}
              {has('banco') ? (
                <td data-card="banco">
                  {row.payment?.providerTxId ?? '—'}
                  {row.payment?.authCode ? <span> · aut. {row.payment.authCode}</span> : null}
                </td>
              ) : null}
              <td data-card="estado" {...(i === 0 && !compact ? { 'data-tour': 'cobros-estado' } : {})}>
                {/* Una sola forma y una palabra por estado, con tarjeta o con el saldo. */}
                <Etiqueta tone={status.tone} size="sm">
                  {status.label}
                </Etiqueta>
                <PaidTwice row={row} />
              </td>
              <td data-card="importe">
                <Importe cents={cobroPaidCents(row)} size="table" decimals="always" currency={row.currency} />
              </td>
            </tr>
          );
        })}
        {rows === null ? <SkelRows rows={compact ? 5 : 8} cols={cells.length} cards={cells} /> : null}
      </tbody>
    </table>
    </div>
  );
}

/** «Saldo K7Q-•••»: si no cabe, parte por el espacio, nunca por el guion del código. */
function labelWithCode(label: string): ReactNode {
  const space = label.lastIndexOf(' ');
  if (space < 0) return label;
  return (
    <>
      {label.slice(0, space + 1)}
      <span style={{ whiteSpace: 'nowrap' }}>{label.slice(space + 1)}</span>
    </>
  );
}

/** Cobrado dos veces (el saldo y, después, la tarjeta): la fila con tarjeta lo dice debajo del estado. */
function PaidTwice({ row }: { row: CobroRow }) {
  const note = paidTwiceNote(row, formatEur);
  if (!note) return null;
  return (
    <span className="np-cobros-dos-veces" data-refunded={row.paidTwice?.refunded === true ? '' : undefined} role="note">
      {note}
    </span>
  );
}

/** La franja de color de la sección a la izquierda de la fila (panel-cobros.css); sin color («Varias»), un gris. */
function rowStripe(color: string | null): CSSProperties {
  return { '--np-row': color ?? 'var(--np-border-hi)' } as CSSProperties;
}
