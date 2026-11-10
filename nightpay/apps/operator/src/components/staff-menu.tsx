'use client';

import { createContext, useContext, useState } from 'react';
import { Button, IosInstallSteps, Modal, useInstall } from '@nightpay/ui';
import { PasskeySheet } from './PasskeySheet';

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
 * La hoja del menú: instalar como app (si se puede y aún no lo está), la llave
 * de acceso (verificarse con el móvil sin 2FA) y «Salir». Sin tema: el
 * personal va siempre en oscuro (layout).
 */
export function StaffMenu({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const { platform, install } = useInstall();
  const [passkeys, setPasskeys] = useState(false);
  return (
    <>
    <PasskeySheet open={passkeys} onClose={() => setPasskeys(false)} />
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
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            setPasskeys(true);
          }}
        >
          Llave de acceso
        </Button>
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </Modal>
    </>
  );
}
