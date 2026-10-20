'use client';

import type { CSSProperties } from 'react';
import type { TimelineRow } from '@/lib/ficha-sheets';

/**
 * La línea del tiempo de una ficha (maquetas 9.1 y 9.2): hora, color de la
 * sección (a trazos: recargas y devoluciones), qué fue y el importe, con la
 * parte de la chica en pequeño. Lo devuelto o anulado, tachado.
 */
export function FichaTimeline({ rows, empty, label }: { rows: TimelineRow[]; empty: string; label: string }) {
  if (rows.length === 0) return <p className="np-ficha-empty">{empty}</p>;
  return (
    <ol className="np-ficha-tl" aria-label={label}>
      {rows.map((r) => (
        <li
          key={r.key}
          className="np-ficha-tr"
          data-undone={r.undone || undefined}
          style={r.color ? ({ '--np-c': r.color } as CSSProperties) : undefined}
        >
          <time dateTime={r.at}>{r.time}</time>
          <i className="np-ficha-sw" data-hold={r.color === null || undefined} aria-hidden="true" />
          <div className="np-ficha-what">
            <b>{r.title}</b>
            {r.sub ? <span>{r.sub}</span> : null}
          </div>
          <span className="np-ficha-amt">
            {r.amount}
            {r.share ? <small>{r.share}</small> : null}
            {r.undone ? <span className="np-sr-only"> (devuelto o anulado)</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
