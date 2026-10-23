'use client';

import { createContext, useContext } from 'react';
import { Button, Modal, ThemeToggle } from '@nightpay/ui';

/**
 * El menú del logo (tema y salir) para las pantallas que llevan su propia
 * cabecera (Recepción): así no hace falta la cabecera de arriba con «Salir» y
 * hay una sola, como en «Cobrar». null: no hay menú (se pinta el logo quieto).
 */
export const StaffMenuContext = createContext<(() => void) | null>(null);

export function useStaffMenu(): (() => void) | null {
  return useContext(StaffMenuContext);
}

/** La hoja del menú: el tema y «Salir». */
export function StaffMenu({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Menú">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Tema</span>
          <ThemeToggle />
        </div>
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </Modal>
  );
}
