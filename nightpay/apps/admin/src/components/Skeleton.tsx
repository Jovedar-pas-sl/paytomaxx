import type { CSSProperties } from 'react';

/**
 * Un bloque gris que respira (solo opacidad, sin degradados) con la forma de
 * lo que va a llegar. Decorativo: lo que se anuncia es el estado de carga de
 * quien lo usa (`role="status"` en su contenedor).
 */
export function Skel({ width, height = '1rem', round, style }: { width?: string; height?: string; round?: boolean; style?: CSSProperties }) {
  return <span className="np-skel" data-round={round || undefined} aria-hidden="true" style={{ width: width ?? '100%', height, ...style }} />;
}

/** Anchos distintos para que las filas de silueta no parezcan un muro. */
const WIDTHS = ['70%', '55%', '85%', '60%', '75%', '50%'];

/** Filas de silueta para una tabla de `cols` columnas (los `data-card` de Cobros, para que en el móvil sean tarjetas). */
export function SkelRows({ rows = 6, cols, cards }: { rows?: number; cols: number; cards?: ReadonlyArray<string | undefined> }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} data-card={cards?.[c]}>
              <Skel width={WIDTHS[(r + c) % WIDTHS.length]} height="1rem" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
