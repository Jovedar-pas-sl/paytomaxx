/**
 * Una línea antes de confirmar algo que mueve dinero (lib/confirm-summary):
 * cuánto, a quién, desde qué local y que no se puede deshacer. Con icono y
 * borde de aviso, no solo color.
 */
export function ConfirmLine({ children }: { children: string }) {
  return (
    <p className="np-confirm-line" role="note">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
