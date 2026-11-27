import { sparkGeometry, SPARK_WIDTH } from '@/lib/sparkline';

interface Props {
  /** Una cifra por hora, de la primera a la de ahora. */
  values: readonly number[];
  /** Lo que lee el lector de pantalla («Por hora, de 22 h a 3 h»). */
  label: string;
  /** Alto en px (32 por defecto). */
  height?: number;
}

/**
 * El minigráfico de «Pagado esta noche»: una línea de 2 px en el color del
 * texto (currentColor) con un punto en la última hora, del ancho de su caja
 * (como mucho 15rem; panel-resumen.css). Con menos de dos horas, nada.
 */
export function Sparkline({ values, label, height = 32 }: Props) {
  const g = sparkGeometry(values, height);
  if (!g) return null;
  return (
    <svg
      className="np-spark"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${SPARK_WIDTH} ${height}`}
      preserveAspectRatio="none"
      height={height}
      focusable="false"
    >
      <polyline points={g.points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {/* El punto: una raya de largo 0 con la punta redonda (no se deforma al estirar la caja). */}
      <line x1={g.last.x} y1={g.last.y} x2={g.last.x} y2={g.last.y} stroke="currentColor" strokeWidth={6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
