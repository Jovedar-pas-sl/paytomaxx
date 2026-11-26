import { Icon } from '@nightpay/ui';

/**
 * Una línea antes de confirmar algo que mueve dinero (lib/confirm-summary):
 * cuánto, a quién, desde qué local y que no se puede deshacer. Con icono y
 * borde de aviso, no solo color (el aviso es el de todas las apps: el círculo
 * con «!»).
 */
export function ConfirmLine({ children }: { children: string }) {
  return (
    <p className="np-confirm-line" role="note">
      <Icon name="alert" size={20} />
      <span>{children}</span>
    </p>
  );
}
