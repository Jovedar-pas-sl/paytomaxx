'use client';

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { Modal, useInstall } from '@nightpay/ui';
import { GUIA_PATH } from '../lib/guia';
import { useOpenCharges, type OpenCharges } from '../lib/open-charges';
import { offerStaffInstall } from '../lib/staff-install';
import { CustomerDisplaySheet } from './CustomerDisplaySheet';
import { DeviceSheet } from './DeviceSheet';
import { PasskeySheet } from './PasskeySheet';
import { ProfileSheet } from './ProfileSheet';
import styles from './staff-menu.module.css';

/**
 * El menú del logo («Salir») para las pantallas que llevan su propia
 * cabecera (Recepción): así no hace falta la cabecera de arriba con «Salir» y
 * hay una sola, como en «Cobrar». null: no hay menú (se pinta el logo quieto).
 */
export const StaffMenuContext = createContext<(() => void) | null>(null);

export function useStaffMenu(): (() => void) | null {
  return useContext(StaffMenuContext);
}

/** Lo que dice cada opción de los dos menús del logo, debajo de su nombre: para qué sirve, en una línea. */
export const MENU_HINTS = {
  profile: 'Tu foto, tu nombre, tu contraseña y el tema.',
  passkey: 'Confirmar lo delicado con Face ID o huella.',
  topUp: 'Cargar dinero en el saldo de un cliente.',
  display: 'La tablet de la barra que ve el cliente.',
  device: 'El lector de fichas y la impresora.',
  install: 'Tener OxioPay como una app más.',
  guia: 'Cómo cobrar y qué hacer si algo falla.',
  logout: 'Cerrar tu sesión en este aparato.',
} as const;

/**
 * Una opción del menú del logo: el nombre y, debajo, para qué sirve. Un
 * botón, o un enlace si lleva a otra página (`href`).
 */
export function MenuOption({
  title,
  hint,
  onClick,
  href,
  style,
}: {
  title: string;
  hint: string;
  onClick?: () => void;
  href?: string;
  style?: CSSProperties;
}) {
  const body = (
    <>
      <span className={styles.title}>{title}</span>
      <span className={styles.hint}>{hint}</span>
    </>
  );
  return href ? (
    <a href={href} className={styles.row} style={style}>
      {body}
    </a>
  ) : (
    <button type="button" className={styles.row} style={style} onClick={onClick}>
      {body}
    </button>
  );
}

/**
 * «Guía rápida» (/guia): cómo cobrar, cómo cargar una ficha y qué hacer si…
 * Un enlace, en los dos menús del logo (este y el de Inicio), siempre justo
 * antes de «Salir». Abre otra página (la app se descarga): con un cobro o una
 * recarga abiertos (en cualquier pestaña) no sale, porque se perderían.
 */
export function GuiaMenuLink() {
  const charges = useOpenCharges();
  if (!showGuiaLink(charges)) return null;
  return <MenuOption href={GUIA_PATH} title="Guía rápida" hint={MENU_HINTS.guia} />;
}

/** La guía, solo sin un cobro ni una recarga abiertos (su QR, la ficha, «Comprobando…», CARGADO). */
export function showGuiaLink(charges: OpenCharges): boolean {
  return !charges.open;
}

/** «Instalar en el móvil», en los dos menús del logo: solo en Android (staff-install). */
export function InstallMenuItem() {
  const { platform, install } = useInstall();
  if (!offerStaffInstall(platform)) return null;
  return <MenuOption title="Instalar en el móvil" hint={MENU_HINTS.install} onClick={() => void install()} />;
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
      <MenuOption
        title="Este aparato"
        hint={MENU_HINTS.device}
        onClick={() => {
          closeMenu();
          setOpen(true);
        }}
      />
    ),
    sheet: <DeviceSheet open={open} onClose={() => setOpen(false)} />,
  };
}

/** «Salir», el último y aparte: acción peligrosa en rojo (solo la letra y el filete, sin llenar). */
export function LogoutMenuItem({ onLogout }: { onLogout: () => void }) {
  return (
    <div style={logoutWrap}>
      <MenuOption title="Salir" hint={MENU_HINTS.logout} onClick={onLogout} style={logoutStyle} />
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
 * tema: se elige en «Mi perfil» (por defecto, oscuro). Cada opción dice debajo para qué sirve.
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
      <div className={styles.list}>
        <MenuOption
          title="Mi perfil"
          hint={MENU_HINTS.profile}
          onClick={() => {
            onClose();
            setProfile(true);
          }}
        />
        <MenuOption
          title="Llave de acceso"
          hint={MENU_HINTS.passkey}
          onClick={() => {
            onClose();
            setPasskeys(true);
          }}
        />
        <MenuOption
          title="Pantalla del cliente"
          hint={MENU_HINTS.display}
          onClick={() => {
            onClose();
            setDisplay(true);
          }}
        />
        {device.item}
        <InstallMenuItem />
        <GuiaMenuLink />
        <LogoutMenuItem onLogout={onLogout} />
      </div>
    </Modal>
    </>
  );
}
