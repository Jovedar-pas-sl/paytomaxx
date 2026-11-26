import type { HTMLAttributes } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

interface RollingNumberProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** La cifra ya escrita («1.275,00 €»). */
  text: string;
  /** Tramo apagado, [desde, hasta) en caracteres (Importe pasa el del «,00»). */
  dim?: readonly [number, number];
}

/**
 * Una cifra que rueda al cambiar (estilos en pieces.css: .np-roll). Cada
 * cifra es una columna del 0 al 9 que se desplaza con transform; puntos, comas
 * y «€» van quietos. No hay reloj: es UN render por cambio y la transición la
 * hace el navegador (la primera vez sale tal cual; con «reducir movimiento»,
 * salta). Las columnas no se leen: el texto entero va aparte para el lector de
 * pantalla. Las celdas se cuentan desde la derecha: al crecer la cifra, las
 * de la derecha siguen siendo las mismas.
 */
export function RollingNumber({ text, dim, className, ...rest }: RollingNumberProps) {
  const chars = Array.from(text);
  return (
    <span {...rest} className={['np-roll', className].filter(Boolean).join(' ')}>
      <span className="np-sr-only">{text}</span>
      <span className="np-roll-row" aria-hidden="true">
        {chars.map((ch, i) => {
          const dimmed = dim && i >= dim[0] && i < dim[1] ? true : undefined;
          const key = chars.length - i;
          const digit = DIGITS.indexOf(ch as (typeof DIGITS)[number]);
          if (digit < 0) {
            return (
              <span key={`s${key}`} data-dim={dimmed}>
                {ch}
              </span>
            );
          }
          return (
            <span key={`d${key}`} className="np-roll-digit" data-dim={dimmed}>
              {/* El «0» que no se ve da el ancho y la línea de base; encima, la columna. */}
              <i>0</i>
              <span className="np-roll-col" style={{ transform: `translateY(${-10 * digit}%)` }}>
                {DIGITS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
