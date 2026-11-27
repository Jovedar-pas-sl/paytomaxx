import { z } from 'zod';
import type { InvitableStaff } from './invitations';

/**
 * La ficha NFC de la compañera (cobro por el encargado, fase 2,
 * 20261127030000_ficha_companera). Se graba en un Android desde su hoja, como
 * las de los clientes (el mismo enlace con su código), y al cobrar un servicio
 * a su nombre se acerca además de su «Mi QR». Vale solo el chip original: se
 * guarda su número de serie y una copia no vale. Una viva por compañera: al
 * darle otra, la de antes deja de valer al momento. No es una ficha de saldo:
 * acercada como la de un cliente (cobro, recarga o saldo), se rechaza.
 */

const CARD = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
/** Número de serie leído del chip (Android o datáfono): sin él no se sabe si es la original. */
const UID = z.string().trim().min(8, 'Acércala a un Android: hace falta el número de serie del chip').max(64);

/** POST /v1/admin/operators/:id/staff-card: la ficha recién grabada pasa a ser la suya. */
export const IssueStaffCardSchema = z.object({ card: CARD, uid: UID }).strict();
export type IssueStaffCardDto = z.infer<typeof IssueStaffCardSchema>;

/** POST /v1/operators/staff-card/resolve: quien cobra acerca la ficha de la compañera. */
export const ResolveStaffCardSchema = z.object({ card: CARD, uid: UID }).strict();
export type ResolveStaffCardDto = z.infer<typeof ResolveStaffCardSchema>;

/** Su ficha en su hoja del panel. */
export interface StaffCardView {
  /** «Ficha nº 0522»: el número para siempre (la misma secuencia que las de los clientes). */
  number: number;
  issuedAt: string;
}

/** La ficha acercada → la compañera, con un «Mi QR» firmado para cobrar a su nombre (dura lo mismo que el QR). */
export interface StaffCardResolved extends InvitableStaff {
  token: string;
  cardNumber: number;
}

/** «0522» (cuatro cifras como mínimo, como en las fichas de los clientes). */
export function staffCardNumberText(n: number): string {
  return String(n).padStart(4, '0');
}

/** 400 en cobros, recargas y saldo: la ficha acercada es la de una compañera. */
export const STAFF_CARD_NOT_CUSTOMER_CODE = 'STAFF_CARD_NOT_CUSTOMER';
export const STAFF_CARD_NOT_CUSTOMER_MESSAGE =
  'Esta es la ficha de una compañera, no la de un cliente: con ella no se cobra, ni se recarga, ni se mira un saldo.';

export const STAFF_CARD_INVALID_CODE = 'STAFF_CARD_INVALID';
export const STAFF_CARD_UNKNOWN_MESSAGE = 'Esa ficha no es la de ninguna compañera de este local.';
export const STAFF_CARD_COPY_MESSAGE = 'Esta ficha no es la original (¿copiada?): no vale. Avisa al encargado.';
export const STAFF_CARD_REVOKED_MESSAGE = 'Esta ficha ya no vale: la compañera tiene otra (o se anuló).';
export const STAFF_CARD_NOT_BLANK_MESSAGE = 'Esta ficha ya está grabada con otra cosa: usa una en blanco.';
