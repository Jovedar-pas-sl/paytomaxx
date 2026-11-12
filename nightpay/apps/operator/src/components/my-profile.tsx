'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MyProfile } from '@nightpay/contracts';
import { Logo, StaffAvatar, StaffPhotoProvider } from '@nightpay/ui';
import { profileApi, type OperatorUser } from '@/lib/api';

interface MyProfileValue {
  user: OperatorUser;
  profile: MyProfile | null;
  /** Lo último que dijo el servidor (tras cambiar foto o nombre): el botón del menú se pone al día. */
  setProfile: (next: MyProfile) => void;
}

const MyProfileContext = createContext<MyProfileValue | null>(null);

/**
 * Mi foto y mi nombre para el botón del menú de todas las pantallas, y la forma
 * de pedir las fotos con la sesión (StaffPhotoProvider). Un fallo al cargar no
 * molesta: el botón enseña las iniciales del nombre de la sesión.
 */
export function MyProfileProvider({ user, children }: { user: OperatorUser; children: ReactNode }) {
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
  const set = useCallback((next: MyProfile) => setProfile(next), []);
  const value = useMemo(() => ({ user, profile, setProfile: set }), [user, profile, set]);
  return (
    <StaffPhotoProvider fetchPhoto={profileApi.fetchPhoto}>
      <MyProfileContext.Provider value={value}>{children}</MyProfileContext.Provider>
    </StaffPhotoProvider>
  );
}

export function useMyProfile(): MyProfileValue | null {
  return useContext(MyProfileContext);
}

/** Dentro del botón del menú de la cabecera: mi foto o, sin ella, mis iniciales sobre un color (sin sesión, el logo de siempre). */
export function MenuAvatar() {
  const mine = useMyProfile();
  if (!mine) return <Logo variant="symbol" height="2.625rem" alt="" />;
  const name = mine.profile?.displayName ?? mine.user.displayName ?? mine.user.email;
  return <StaffAvatar userId={mine.user.id} hash={mine.profile?.photoHash ?? null} name={name} size={42} />;
}
