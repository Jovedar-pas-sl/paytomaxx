/**
 * QR de activación del saldo (recepción → móvil del cliente).
 *
 * Quien recarga en efectivo en la recepción no recibe el enlace privado de su
 * saldo (/w/<token>), y sin él no puede activar Face ID (ni ver su saldo al
 * acercar su NFC al móvil). Justo después de recargar, recepción lo enseña como
 * QR en la pantalla de «Cargado»: el cliente lo escanea con la cámara, activa
 * Face ID en su móvil y desde entonces ve su saldo acercando su NFC.
 *
 *   GET /v1/reception/wallets/:id/activation-link
 *
 *  - Solo recepción (puesto con «recargas»), el encargado y el dueño (403
 *    TOP_UP_RECEPTION_ONLY si no).
 *  - Solo en los ACTIVATION_LINK_WINDOW_MINUTES tras una recarga de ese saldo
 *    hecha en este local (efectivo o tarjeta), y solo si el saldo aún no tiene
 *    Face ID (passkey). Si no, 404 ACTIVATION_LINK_UNAVAILABLE con su `reason`.
 *  - Queda en el registro (wallet.activation_link) y tiene límite por IP (429).
 */

/** Tras una recarga del local, minutos en los que recepción puede enseñar el QR. */
export const ACTIVATION_LINK_WINDOW_MINUTES = 15;

/** Ruta del API (con el prefijo /v1). */
export function walletActivationLinkPath(walletId: string): string {
  return `/v1/reception/wallets/${encodeURIComponent(walletId)}/activation-link`;
}

/** 200: lo que se enseña como QR. */
export interface WalletActivationLink {
  /** Enlace privado del saldo (https://api…/w/<token>): se pinta como QR, nunca se guarda ni se registra. */
  url: string;
  /** ISO: hasta cuándo enseñarlo (fin de la ventana tras la recarga). Después, quitar el QR de la pantalla. */
  expiresAt: string;
}

/** `code` del 404 (el problem+json lleva además `reason`). */
export const ACTIVATION_LINK_UNAVAILABLE_CODE = 'ACTIVATION_LINK_UNAVAILABLE';

/**
 * Por qué no hay QR:
 *  - NOT_FOUND: el saldo no existe, no vale aquí, está bloqueado, cerrado o sumado a otro.
 *  - FACE_ID_SET: ya tiene Face ID: el cliente ve su saldo acercando su NFC al móvil.
 *  - NO_RECENT_TOP_UP: no hay una recarga de este local en los últimos 15 minutos.
 */
export const ACTIVATION_LINK_REASONS = ['NOT_FOUND', 'FACE_ID_SET', 'NO_RECENT_TOP_UP'] as const;
export type ActivationLinkUnavailableReason = (typeof ACTIVATION_LINK_REASONS)[number];

/** Texto para la pantalla de recepción (castellano, como el resto de la app del personal). */
export const ACTIVATION_LINK_REASON_TEXT: Readonly<Record<ActivationLinkUnavailableReason, string>> = {
  NOT_FOUND: 'Este saldo no admite QR de activación.',
  FACE_ID_SET: 'Este saldo ya tiene Face ID: el cliente ve su saldo acercando su NFC al móvil.',
  NO_RECENT_TOP_UP: 'El QR de activación solo sale en los 15 minutos siguientes a una recarga en este local.',
};
