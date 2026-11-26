import { Skeleton } from '@nightpay/ui';

// La silueta es la pieza Skeleton de @nightpay/ui; el panel la sigue llamando Skel.
export { Skeleton as Skel } from '@nightpay/ui';

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
              <Skeleton width={WIDTHS[(r + c) % WIDTHS.length]} height="1rem" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
