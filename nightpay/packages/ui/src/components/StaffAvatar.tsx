'use client';

import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { profileInitials } from '@nightpay/contracts';

/** Cómo se pide la foto de una persona del local (con la sesión puesta): la pone cada app. */
export type StaffPhotoFetcher = (userId: string, hash: string) => Promise<Blob | null>;

const StaffPhotoContext = createContext<StaffPhotoFetcher | null>(null);

/** Una vez por app: así cualquier <StaffAvatar> sabe pedir las fotos con la sesión de la app. */
export function StaffPhotoProvider({ fetchPhoto, children }: { fetchPhoto: StaffPhotoFetcher; children: ReactNode }) {
  return <StaffPhotoContext.Provider value={fetchPhoto}>{children}</StaffPhotoContext.Provider>;
}

// La foto va por su huella: una dirección nunca cambia de contenido, así que se
// guarda para toda la visita (un blob por foto, compartido por todos los avatares).
const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function loadPhoto(fetchPhoto: StaffPhotoFetcher, userId: string, hash: string): Promise<string | null> {
  const key = `${userId}:${hash}`;
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = fetchPhoto(userId, hash)
    .then((blob) => {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      return url;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

/** La foto de una persona como dirección de imagen, o null (sin foto, cargando o sin conexión). */
export function useStaffPhotoUrl(userId: string | null | undefined, hash: string | null | undefined): string | null {
  const fetchPhoto = useContext(StaffPhotoContext);
  const key = userId && hash ? `${userId}:${hash}` : null;
  const [url, setUrl] = useState<string | null>(key ? (urls.get(key) ?? null) : null);
  useEffect(() => {
    if (!fetchPhoto || !userId || !hash) {
      setUrl(null);
      return;
    }
    let live = true;
    setUrl(urls.get(`${userId}:${hash}`) ?? null);
    void loadPhoto(fetchPhoto, userId, hash).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [fetchPhoto, userId, hash]);
  return url;
}

// Fondos de las iniciales: oscuros y apagados (la crema encima pasa de 7:1);
// la lima queda para la acción principal de cada pantalla.
const INITIALS_TONES = ['#2c3a45', '#3a2f45', '#2f4538', '#45382f', '#2f3f45', '#45303a'] as const;

/** Un color estable para esa persona (el mismo siempre, en cualquier pantalla). */
export function initialsTone(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return INITIALS_TONES[h % INITIALS_TONES.length]!;
}

interface StaffAvatarProps {
  /** Quién es (para pedir su foto y para el color). */
  userId?: string | null;
  /** La huella de su foto; sin ella, sus iniciales. */
  hash?: string | null;
  name?: string | null;
  /** Lado en píxeles. */
  size?: number;
  /** Una foto ya en memoria (la que acaba de subir quien se mira a sí mismo). */
  src?: string | null;
  style?: CSSProperties;
}

/** La foto redonda de una persona o, sin foto, sus iniciales sobre un color. */
export function StaffAvatar({ userId, hash, name, size = 40, src, style }: StaffAvatarProps) {
  const loaded = useStaffPhotoUrl(userId, hash);
  const shown = src ?? loaded;
  const seed = userId ?? name ?? '?';
  const box: CSSProperties = {
    width: size,
    height: size,
    flex: 'none',
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'inline-grid',
    placeItems: 'center',
    background: shown ? 'var(--np-surface-3)' : initialsTone(seed),
    color: 'var(--np-cream)',
    fontFamily: 'var(--np-font-mono, inherit)',
    fontWeight: 700,
    // Las iniciales, con la escala de letra (nunca menos de 14 px).
    fontSize: size >= 96 ? 'var(--np-fs-40)' : size >= 56 ? 'var(--np-fs-22)' : 'var(--np-fs-14)',
    lineHeight: 1,
    userSelect: 'none',
    ...style,
  };
  return shown ? (
    <img src={shown} alt={name ? `Foto de ${name}` : 'Foto de perfil'} width={size} height={size} style={{ ...box, objectFit: 'cover' }} />
  ) : (
    <span style={box} role="img" aria-label={name ? `Iniciales de ${name}` : 'Sin foto'}>
      {profileInitials(name)}
    </span>
  );
}
