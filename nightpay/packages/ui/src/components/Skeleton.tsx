import type { CSSProperties } from 'react';

interface SkeletonProps {
  /** Ancho (por defecto, todo el de su sitio). */
  width?: string;
  /** Alto (por defecto 1rem, una línea de texto). */
  height?: string;
  /** Redonda del todo (un avatar, un chip). */
  round?: boolean;
  /** Varias líneas de texto: barras de 1rem, la última al 60 %. */
  lines?: number;
  style?: CSSProperties;
}

/**
 * La silueta de lo que va a llegar: un bloque gris que respira (solo opacidad,
 * sin degradados; estilos en pieces.css: .np-skel). Sale si la carga pasa de
 * 300 ms: hasta entonces ocupa su sitio sin verse, así una carga rápida no
 * parpadea y nada salta al llegar. Es decorativa: quien carga pone
 * aria-busy="true" en su contenedor y dentro
 * <span className="np-sr-only" role="status">Cargando…</span>.
 */
export function Skeleton({ width, height = '1rem', round, lines, style }: SkeletonProps) {
  if (lines) {
    return (
      <span className="np-skel-lines" aria-hidden="true" style={{ width: width ?? '100%', ...style }}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="np-skel" style={{ width: i === lines - 1 && lines > 1 ? '60%' : '100%', height: '1rem' }} />
        ))}
      </span>
    );
  }
  return <span className="np-skel" data-round={round || undefined} aria-hidden="true" style={{ width: width ?? '100%', height, ...style }} />;
}
