import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Lo que está mal en UN campo, justo debajo de él: el aspa y la frase
 * («Faltan 2 números»). Input y Select lo pintan con su `error`. Sin role: el
 * campo lo apunta (aria-describedby) y se lee con él, sin interrumpir cada vez
 * que se teclea. Lo que falla al hacer algo (el banco, la red) va en FormError,
 * sobre el botón. Estilos en pieces-2.css: .np-field-error.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} className="np-field-error">
      <Icon name="error" size={20} />
      <span>{children}</span>
    </span>
  );
}
