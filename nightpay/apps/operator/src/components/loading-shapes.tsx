import type { CSSProperties, ReactNode } from 'react';
import { Skeleton } from '@nightpay/ui';

// Las siluetas de carga de la app del personal, compuestas con la pieza
// Skeleton: copian la forma de lo que va a llegar (nada salta) y salen solas
// si la carga pasa de 300 ms (lo hace la pieza). Su caja lleva aria-busy y
// «Cargando…» para el lector de pantalla. Separaciones con márgenes: el
// navegador viejo de un datáfono no entiende `gap` en una fila flex.

/** La caja de una silueta: ocupada (aria-busy) y con «Cargando…» solo para el lector. */
function Busy({ children, style, className, inline }: { children: ReactNode; style?: CSSProperties; className?: string; inline?: boolean }) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag aria-busy="true" className={className} style={inline ? { display: 'block', ...style } : style}>
      <span className="np-sr-only" role="status">Cargando…</span>
      {children}
    </Tag>
  );
}

/** Filas de una lista: dos líneas a la izquierda y la cifra a la derecha (o, con `line`, una sola línea de ese ancho en una fila de `height`). */
export function SkelRows({ count = 3, line, height }: { count?: number; line?: string; height?: string }) {
  return (
    <Busy>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ ...rowStyle, minHeight: height }}>
          {line ? (
            <Skeleton width={line} />
          ) : (
            <>
              <Skeleton lines={2} width="55%" />
              <Skeleton width="4rem" height="1.125rem" />
            </>
          )}
        </div>
      ))}
    </Busy>
  );
}

interface SkelCardProps {
  /** Una cifra grande arriba (su alto: 2.5rem por defecto). */
  figure?: boolean | string;
  /** Un título. */
  title?: boolean;
  /** Líneas de texto. */
  lines?: number;
  /** Campos de un formulario (48 de alto). */
  fields?: number;
  /** Sin caja (dentro de una hoja o de una pantalla que ya la pone). */
  bare?: boolean;
  style?: CSSProperties;
}

/** Una tarjeta: su cifra o su título y unas líneas (o campos). */
export function SkelCard({ figure, title, lines, fields, bare, style }: SkelCardProps) {
  return (
    <Busy style={{ ...(bare ? null : cardStyle), ...style }}>
      {figure ? <Skeleton width="45%" height={typeof figure === 'string' ? figure : '2.5rem'} /> : null}
      {title ? <Skeleton width="60%" height="1.5rem" /> : null}
      {lines ? <Skeleton lines={lines} style={{ marginTop: figure || title ? '0.75rem' : 0 }} /> : null}
      {Array.from({ length: fields ?? 0 }, (_, i) => (
        <Skeleton key={i} height="3rem" style={{ marginTop: '1rem' }} />
      ))}
    </Busy>
  );
}

/** Losetas lado a lado (las formas de pago). */
export function SkelTiles({ count = 2, height, className }: { count?: number; height: string; className?: string }) {
  return (
    <Busy className={className} style={className ? undefined : { display: 'flex' }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          height={height}
          style={className ? undefined : { flex: 1, width: 'auto', marginLeft: i > 0 ? '0.75rem' : 0, borderRadius: 'var(--np-r-lg)' }}
        />
      ))}
    </Busy>
  );
}

/** Una línea suelta (vale dentro de un botón o de un párrafo). */
export function SkelLine({ width = '60%', style }: { width?: string; style?: CSSProperties }) {
  return (
    <Busy inline style={style}>
      <Skeleton width={width} />
    </Busy>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.75rem 0.25rem',
  borderBottom: '1px solid var(--np-border)',
};

const cardStyle: CSSProperties = {
  padding: '1rem',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-card)',
};
