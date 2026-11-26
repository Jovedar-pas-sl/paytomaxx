'use client';

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { MyProfile, ProfileApi } from '@nightpay/contracts';
import {
  applyBigFont,
  applyThemeChoice,
  browserStore,
  hapticEnabled,
  readBigFont,
  readThemeChoice,
  writeHaptic,
  type ThemeChoice,
} from '../lib/device-settings';
import { haptic } from '../lib/haptic';
import { Button } from './Button';
import { ProfileContact, ProfileSecurity } from './ProfileAccount';
import { errorText, ProfileIdentity } from './ProfileIdentity';
import { ProfileBlock, Segmented, touchButton, type Choice } from './profile-parts';
import { Skeleton } from './Skeleton';

const THEMES: readonly Choice<ThemeChoice>[] = [
  { value: 'dark', label: 'Oscuro' },
  { value: 'light', label: 'Claro' },
  { value: 'system', label: 'Como el móvil' },
];
const YES_NO: readonly Choice<'yes' | 'no'>[] = [
  { value: 'yes', label: 'Sí' },
  { value: 'no', label: 'No' },
];

/**
 * «Este móvil»: lo que se guarda solo en este móvil (localStorage), nunca en el
 * servidor. `full` (el personal): tema, vibrar y letra grande; `theme` (el
 * panel): solo el tema.
 */
export function ProfileDevice({ mode, title, themeFallback }: { mode: 'full' | 'theme'; title: string; themeFallback: ThemeChoice }) {
  const [theme, setTheme] = useState<ThemeChoice>(themeFallback);
  const [vibrate, setVibrate] = useState(true);
  const [big, setBig] = useState(false);
  useEffect(() => {
    setTheme(readThemeChoice(browserStore(), themeFallback));
    setVibrate(hapticEnabled());
    setBig(readBigFont());
  }, [themeFallback]);
  return (
    <ProfileBlock title={title}>
      <Segmented
        label="Tema"
        value={theme}
        options={THEMES}
        onChange={(next) => {
          setTheme(next);
          applyThemeChoice(next);
        }}
      />
      {mode === 'full' ? (
        <>
          <Segmented
            label="Vibrar al tocar"
            value={vibrate ? 'yes' : 'no'}
            options={YES_NO}
            onChange={(next) => {
              setVibrate(next === 'yes');
              writeHaptic(browserStore(), next === 'yes');
              if (next === 'yes') haptic();
            }}
          />
          <Segmented
            label="Letra más grande"
            value={big ? 'yes' : 'no'}
            options={YES_NO}
            onChange={(next) => {
              setBig(next === 'yes');
              applyBigFont(next === 'yes');
            }}
          />
        </>
      ) : null}
    </ProfileBlock>
  );
}

export interface ProfileScreenProps {
  api: ProfileApi;
  onLogout: () => void;
  /** `full`: tema, vibrar y letra grande (el personal). `theme`: solo el tema (el panel). */
  device?: 'full' | 'theme';
  deviceTitle?: string;
  /** El tema de partida si el móvil no ha elegido (el personal: oscuro; el panel: como el equipo). */
  themeFallback?: ThemeChoice;
  /** El «?» de la cabecera (ScreenHelp). */
  help?: ReactNode;
  /** Cada vez que cambia algo del perfil (foto, nombre…): para que el menú se ponga al día. */
  onProfile?: (profile: MyProfile) => void;
  /** Si se pinta dentro de una ventana que ya tiene título, sin cabecera propia. */
  bare?: boolean;
  /** Lo de cada app, detrás de «Contacto» (la compañera: su cuenta de cobro y el aviso cuando le pagan). */
  children?: ReactNode;
}

/**
 * «Mi perfil» del personal y del panel: tu foto y tu nombre, contacto
 * (teléfono y correo), seguridad (contraseña y cerrar sesión) y este móvil.
 * Cada persona cambia solo lo suyo.
 */
export function ProfileScreen({ api, onLogout, device = 'full', deviceTitle = 'Este móvil', themeFallback = 'dark', help, onProfile, bare, children }: ProfileScreenProps) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get()
      .then((p) => {
        setProfile(p);
        onProfile?.(p);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, [api, onProfile]);
  useEffect(load, [load]);

  const changed = useCallback(
    (next: MyProfile) => {
      setProfile(next);
      onProfile?.(next);
    },
    [onProfile],
  );

  return (
    <div style={wrap}>
      {bare ? null : (
        <header style={head}>
          <h1 style={title}>Mi perfil</h1>
          {help}
        </header>
      )}
      {error ? (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={{ margin: 0, color: 'var(--np-danger-text)', fontSize: 'var(--np-fs-16)' }}>{error}</p>
          <div>
            <Button variant="ghost" style={touchButton} onClick={load}>
              Volver a intentarlo
            </Button>
          </div>
        </div>
      ) : null}
      {profile ? (
        <>
          <div data-tour="perfil-foto">
            <ProfileIdentity profile={profile} api={api} onChange={changed} />
          </div>
          <div data-tour="perfil-contacto">
            <ProfileContact profile={profile} api={api} onChange={changed} />
          </div>
          {children}
          <div data-tour="perfil-seguridad">
            <ProfileSecurity api={api} onLogout={onLogout} />
          </div>
        </>
      ) : error ? null : (
        // La silueta de la foto (el círculo de StaffAvatar, 112) y dos líneas.
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span className="np-sr-only" role="status">Cargando…</span>
          <Skeleton width="7rem" height="7rem" round />
          <Skeleton lines={2} width="60%" style={{ marginTop: '1rem' }} />
        </div>
      )}
      <div data-tour="perfil-movil">
        <ProfileDevice mode={device} title={deviceTitle} themeFallback={themeFallback} />
      </div>
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.875rem', minWidth: 0, maxWidth: '32rem', width: '100%', margin: '0 auto' };
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem' };
const title: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-22)', fontWeight: 600, color: 'var(--np-text)' };
