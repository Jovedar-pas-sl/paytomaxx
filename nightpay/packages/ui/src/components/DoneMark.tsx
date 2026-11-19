/**
 * La marca de «hecho»: disco lima con ✓ de tinta. Es la misma en PAGADO,
 * CARGADO, su banda y la pantalla del cliente. El tamaño se pone con
 * `--np-done-size`; el movimiento y «reducir movimiento» viven en staff.css.
 */
export function DoneMark({ className }: { className?: string }) {
  return (
    <span className={className ? `np-done ${className}` : 'np-done'} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
      </svg>
    </span>
  );
}
