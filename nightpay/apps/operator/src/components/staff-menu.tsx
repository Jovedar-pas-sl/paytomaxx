'use client';

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Modal, useInstall } from '@nightpay/ui';
import { GUIA_PATH } from '../lib/guia';
import { useOpenCharges, type OpenCharges } from '../lib/open-charges';
import { offerStaffInstall } from '../lib/staff-install';
import { CustomerDisplaySheet } from './CustomerDisplaySheet';
import { DeviceSheet } from './DeviceSheet';
import { PasskeySheet } from './PasskeySheet';
import { ProfileSheet } from './ProfileSheet';

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
 * el de Inicio), siempre justo antes de «Salir». Abre otra página (la app se
 * descarga): con un cobro o una recarga abiertos (en cualquier pestaña) no
 * sale, porque se perderían.
 */
export function GuiaMenuLink() {
  const charges = useOpenCharges();
  if (!showGuiaLink(charges)) return null;
  return (
    <a href={GUIA_PATH} className="np-btn" data-variant="ghost" data-size="md">
      Guía rápida
    </a>
  );
}

/** La guía, solo sin un cobro ni una recarga abiertos (su QR, la ficha, «Comprobando…», CARGADO). */
export function showGuiaLink(charges: OpenCharges): boolean {
  return !charges.open;
}

/** «Instalar en el móvil», en los dos menús del logo: solo en Android (staff-install). */
export function InstallMenuItem() {
  const { platform, install } = useInstall();
  if (!offerStaffInstall(platform)) return null;
  return (
    <Button variant="ghost" onClick={() => void install()}>
      Instalar en el móvil
    </Button>
  );
}

/**
 * «Este aparato» en los dos menús del logo: el botón y su hoja (dónde está el
 * lector NFC y la prueba de lectura). La hoja vive fuera del menú: se abre al
 * cerrarlo.
 */
export function useDeviceMenu(closeMenu: () => void): { item: ReactNode; sheet: ReactNode } {
  const [open, setOpen] = useState(false);
  return {
    item: (
      <Button
        variant="ghost"
        onClick={() => {
          closeMenu();
          setOpen(true);
        }}
      >
        Este aparato
      </Button>
    ),
    sheet: <DeviceSheet open={open} onClose={() => setOpen(false)} />,
  };
}

/** «Salir», el último y aparte: acción peligrosa en rojo (solo la letra y el filete, sin llenar). */
export function LogoutMenuItem({ onLogout }: { onLogout: () => void }) {
  return (
    <div style={logoutWrap}>
      <Button variant="ghost" onClick={onLogout} style={logoutStyle}>
        Salir
      </Button>
    </div>
  );
}

const logoutWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  marginTop: '0.75rem',
  paddingTop: '1rem',
  borderTop: '1px solid var(--np-border)',
};

const logoutStyle: CSSProperties = {
  color: 'var(--np-danger-text)',
  boxShadow: 'inset 0 0 0 1px var(--np-danger)',
};

/**
 * La hoja del menú: «Mi perfil» (foto, nombre y ajustes), la llave de acceso (verificarse con el móvil sin 2FA),
 * la «Pantalla del cliente» (la tablet de la barra con el importe y el QR),
 * «Este aparato», instalar como app (en Android, si aún no lo está), la guía y, aparte, «Salir». Sin
 * tema: se elige en «Mi perfil» (por defecto, oscuro).
 */
export function StaffMenu({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const [passkeys, setPasskeys] = useState(false);
  const [profile, setProfile] = useState(false);
  const [display, setDisplay] = useState(false);
  const device = useDeviceMenu(onClose);
  return (
    <>
    <ProfileSheet open={profile} onClose={() => setProfile(false)} onLogout={onLogout} />
    {device.sheet}
    <PasskeySheet open={passkeys} onClose={() => setPasskeys(false)} />
    <CustomerDisplaySheet open={display} onClose={() => setDisplay(false)} />
    <Modal open={open} onClose={onClose} title="Menú">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            setProfile(true);
          }}
        >
          Mi perfil
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            setPasskeys(true);
          }}
        >
          Llave de acceso
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            setDisplay(true);
          }}
        >
          Pantalla del cliente
        </Button>
        {device.item}
        <InstallMenuItem />
        <GuiaMenuLink />
        <LogoutMenuItem onLogout={onLogout} />
      </div>
    </Modal>
    </>
  );
}
