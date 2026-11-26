import type { CSSProperties } from 'react';
import { formatMoney } from '@nightpay/contracts';
import { RollingNumber } from './RollingNumber';

interface ImporteProps {
  /** El importe, en céntimos. */
  cents: number;
  /** `hero` (la cifra de la pantalla), `row` (una fila) o `table` (una celda, a la derecha). Sin él, hereda tamaño y peso de su sitio. */
  size?: 'hero' | 'row' | 'table';
  /** `auto` (por defecto): «33 €» sin céntimos. `always` (el panel, siempre): «33,00 €» con el «,00» apagado. */
  decimals?: 'auto' | 'always';
  /** Con «+» delante de lo que suma (el «−» de lo que resta va siempre). */
  signed?: boolean;
  /** La cifra rueda al cambiar (RollingNumber). */
  rolling?: boolean;
  currency?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * LA pieza que escribe dinero (estilos en pieces.css: .np-importe). Es la cara
 * de formatMoney de @nightpay/contracts, que sigue siendo la regla (también
 * del API): el «€» detrás con espacio duro, el menos de verdad y el punto de
 * los miles. Apaga lo que no dice nada: un cero entero y, con `always`, el
 * «,00». Los céntimos de verdad y el «€» van en su color; el color de un
 * negativo lo pone quien la usa. Un importe, un solo tamaño.
 */
export function Importe({ cents, size, decimals = 'auto', signed = false, rolling = false, currency = 'EUR', className, style }: ImporteProps) {
  const figure = `${signed && cents > 0 ? '+' : ''}${formatMoney(cents, { bare: true, compact: decimals === 'auto' })}`;
  // Lo apagado es siempre la cola de la cifra: toda ella si es cero, o su «,00» (desde la última coma).
  const comma = figure.lastIndexOf(',');
  const dimFrom = cents === 0 ? 0 : cents % 100 === 0 && comma >= 0 ? comma : figure.length;
  const unit = `\u00a0${currency === 'EUR' ? '€' : currency}`;
  const cls = ['np-importe', className].filter(Boolean).join(' ');
  if (rolling) {
    return <RollingNumber text={`${figure}${unit}`} dim={[dimFrom, figure.length]} className={cls} style={style} data-size={size} />;
  }
  return (
    <span className={cls} data-size={size} style={style}>
      {figure.slice(0, dimFrom)}
      {dimFrom < figure.length ? <span className="np-importe-dim">{figure.slice(dimFrom)}</span> : null}
      {unit}
    </span>
  );
}
