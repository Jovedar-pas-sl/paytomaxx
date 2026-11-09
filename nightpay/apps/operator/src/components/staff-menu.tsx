'use client';

import { createContext, useContext } from 'react';
import { Button, IosInstallSteps, Modal, useInstall } from '@nightpay/ui';
import { GUIA_PATH } from '../lib/guia';

/**
 * El menú del logo («Salir») para las pantallas que llevan su propia
 * cabecera (Recepción): así no hace falta la cabecera de arriba con «Salir» y
 * hay una sola, como en «Cobrar». null: no hay menú (se pinta el logo quieto).
 */
export const StaffMenuContext = createContext<(() => void) | null>(null);

export function useStaffMenu(): (() => void) | null {
  return useContext(StaffMenuContext);
}

/**
 * «Guía rápida» (/guia): cómo cobrar, cómo cargar una ficha y qué hacer si…
 * Un enlace con aspecto de botón secundario, en los dos menús del logo (este y
 * el de Inicio), siempre justo antes de «Salir».
 */
export function GuiaMenuLink() {
  return (
    <a href={GUIA_PATH} className="np-btn" data-variant="ghost" data-size="md">
      Guía rápida
    </a>
  );
}

/**
 * La hoja del menú: instalar como app (si se puede y aún no lo está), la guía
 * y «Salir». Sin tema: el personal va siempre en oscuro (layout).
 */
export function StaffMenu({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const { platform, install } = useInstall();
  return (
    <Modal open={open} onClose={onClose} title="Menú">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {platform === 'prompt' ? (
          <Button variant="ghost" onClick={() => void install()}>
            Instalar en el móvil
          </Button>
        ) : null}
        {platform === 'ios' ? (
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', lineHeight: 1.45, color: 'var(--np-text-mute)' }}>
            <b style={{ color: 'var(--np-text)', fontWeight: 600 }}>Instalar en el móvil.</b> <IosInstallSteps />
          </p>
        ) : null}
        <GuiaMenuLink />
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </Modal>
  );
}
