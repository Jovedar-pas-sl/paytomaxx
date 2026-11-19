'use client';

import { useEffect, type CSSProperties } from 'react';
import { ProfileScreen, ScreenHelp } from '@nightpay/ui';
import { profileApi } from '@/lib/api';
import { TOURS } from '@/lib/tours';
import { useMyProfile } from './my-profile';
import { PayoutProfile } from './PayoutProfile';

/**
 * «Mi perfil», a pantalla completa desde el menú del logo: foto, nombre,
 * contacto, (la compañera) su cuenta de cobro y el aviso cuando le pagan,
 * seguridad y los ajustes de este móvil. «Atrás» (o Esc) vuelve a
 * donde se estaba; «Cerrar sesión» sale como el «Salir» del menú.
 */
export function ProfileSheet({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const mine = useMyProfile();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Mi perfil" style={overlay}>
      <header style={head}>
        <button type="button" onClick={onClose} aria-label="Atrás" style={backBtn}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 style={title}>Mi perfil</h1>
        <ScreenHelp {...TOURS.perfil} />
      </header>
      <div style={body}>
        <ProfileScreen api={profileApi} onLogout={onLogout} device="full" themeFallback="dark" bare onProfile={mine?.setProfile}>
          {/* Solo la compañera tiene cuenta de cobro y pagos en la app (/operators/me/*). */}
          {mine?.user.role === 'OPERATOR' ? <PayoutProfile /> : null}
        </ProfileScreen>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'var(--np-bg)',
  color: 'var(--np-text)',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  display: 'flex',
  flexDirection: 'column',
};
const head: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: 'calc(0.5rem + env(safe-area-inset-top)) 1rem 0.5rem',
  background: 'var(--np-bg)',
  borderBottom: '1px solid var(--np-border)',
};
const backBtn: CSSProperties = {
  width: '2.75rem',
  height: '2.75rem',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--np-surface)',
  color: 'var(--np-text)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  cursor: 'pointer',
  flex: 'none',
};
const title: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 600, flex: 1 };
const body: CSSProperties = { padding: '1rem 1rem calc(2rem + env(safe-area-inset-bottom))' };
