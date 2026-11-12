'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MyProfile } from '@nightpay/contracts';
import { Modal, ProfileScreen, ScreenHelp, StaffAvatar, StaffPhotoProvider } from '@nightpay/ui';
import { profileApi, type User } from '@/lib/api';
import { TOURS } from '@/lib/tours';

/**
 * Mi foto en la cabecera del panel: abre «Mi perfil» (foto, nombre, contacto,
 * seguridad y el tema de este equipo). Sin foto, mis iniciales sobre un color.
 * También da a todo el panel la forma de pedir las fotos con la sesión.
 */
export function ProfileProvider({ children }: { children: React.ReactNode }) {
  return <StaffPhotoProvider fetchPhoto={profileApi.fetchPhoto}>{children}</StaffPhotoProvider>;
}

export function MyProfileButton({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<MyProfile | null>(null);
  useEffect(() => {
    let live = true;
    profileApi
      .get()
      .then((p) => {
        if (live) setProfile(p);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user.id]);
  const changed = useCallback((next: MyProfile) => setProfile(next), []);
  const name = profile?.displayName ?? user.email;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Mi perfil"
        title="Mi perfil"
        className="np-profile-btn"
        style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', borderRadius: '50%', minWidth: '2.75rem', minHeight: '2.75rem', display: 'grid', placeItems: 'center' }}
      >
        <StaffAvatar userId={user.id} hash={profile?.photoHash ?? null} name={name} size={36} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} width="min(36rem, 100%)">
        <ProfileScreen
          api={profileApi}
          onLogout={onLogout}
          device="theme"
          deviceTitle="Este equipo"
          themeFallback="system"
          help={<ScreenHelp {...TOURS.perfil} />}
          onProfile={changed}
        />
      </Modal>
    </>
  );
}
