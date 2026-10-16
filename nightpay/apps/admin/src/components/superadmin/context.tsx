'use client';

import { createContext, useContext } from 'react';
import type { BusinessView, VenueListItem } from '@nightpay/contracts';

/** Lo que comparten todas las secciones de la consola. */
export interface SaShared {
  /** Quién está dentro (no se da de baja ni se quita la 2FA a sí mismo). */
  currentUserId: string;
  /** Slug del local activo (para marcar «Estás aquí»). */
  currentSlug: string;
  /** ¿Tiene la 2FA activada quien está dentro? null = aún no se sabe. */
  totpEnabled: boolean | null;
  /** 429 TOTP_LOCKED: el bloqueo es de la persona, vale para todos los diálogos. */
  lockedUntil: number | null;
  setLockedUntil: (until: number | null) => void;
  /** A Ajustes (activar la 2FA). */
  goToSettings: () => void;
  /** Todos los locales y negocios, para los desplegables (null mientras llegan). */
  venues: VenueListItem[] | null;
  businesses: BusinessView[] | null;
  /** Volver a pedir locales y negocios (tras crear o cambiar uno). */
  refreshLists: () => void;
  /** Abrir el registro filtrado por una persona. */
  openAuditFor: (actor: { id: string; label: string }) => void;
}

export const SaContext = createContext<SaShared>({
  currentUserId: '',
  currentSlug: '',
  totpEnabled: null,
  lockedUntil: null,
  setLockedUntil: () => undefined,
  goToSettings: () => undefined,
  venues: null,
  businesses: null,
  refreshLists: () => undefined,
  openAuditFor: () => undefined,
});

export function useSa(): SaShared {
  return useContext(SaContext);
}
