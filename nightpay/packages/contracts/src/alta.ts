import { z } from 'zod';
import { displayNameSchema } from './profile';

// ─── Alta de la compañera con tres caminos de cobro (19-nov-2026) ─────
// Nombre legal y fecha de nacimiento (con menos de 18 años no se activa la
// cuenta), el titular de su IBAN contra su nombre legal y la OxioCard
// (solo la petición y cómo va; sin emisor ni documentos).

/** Edad mínima para activar la cuenta. */
export const ADULT_AGE = 18;

/** 403 al activar la cuenta (o ponerle contraseña) de quien tiene menos de 18 años. */
export const MINOR_CANNOT_ACTIVATE = 'MINOR_CANNOT_ACTIVATE';

/** 409 al pagar (o pedirlo) a una cuenta cuyo titular no coincide con su nombre legal sin la confirmación del dueño. */
export const PAYOUT_HOLDER_UNCONFIRMED = 'PAYOUT_HOLDER_UNCONFIRMED';

const MADRID_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** El día de hoy en Madrid, «AAAA-MM-DD». */
export function madridToday(now: Date = new Date()): string {
  const part = (type: string) => MADRID_DAY.formatToParts(now).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Años cumplidos el día `today` por quien nació el `birthDate` (los dos «AAAA-MM-DD»). */
export function ageOn(birthDate: string, today: string): number {
  const years = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  // Nacida un 29 de febrero: los cumple el 1 de marzo de un año que no es bisiesto.
  return today.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

/** Tiene menos de 18 años ese día. Sin fecha no se sabe: false. */
export function isMinor(birthDate: string | null | undefined, today: string): boolean {
  return Boolean(birthDate) && ageOn(birthDate!, today) < ADULT_AGE;
}

/** «AAAA-MM-DD» de un día que existe («2001-02-30», no). */
function isRealDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const BIRTH_DATE_MESSAGE = 'Pon tu fecha de nacimiento (día, mes y año)';

/** Fecha de nacimiento: un día que existe, desde 1900 y no después de hoy. */
export const BirthDateSchema = z
  .string({ error: BIRTH_DATE_MESSAGE })
  .refine(isRealDay, BIRTH_DATE_MESSAGE)
  .refine((v) => v >= '1900-01-01' && v <= madridToday(), 'Esa fecha de nacimiento no puede ser');

const LEGAL_NAME_MESSAGE = 'Pon el nombre y los apellidos como en el documento';

/** Nombre legal completo, como en el documento: al menos nombre y un apellido. */
export const LegalNameSchema = displayNameSchema(3, 120).refine((v) => v.split(' ').length >= 2, LEGAL_NAME_MESSAGE);

/** La OxioCard de la compañera: si la pidió y cómo va. El estado lo cambia a mano el dueño. */
export const OxiocardStatusSchema = z.enum(['NO_SOLICITADA', 'SOLICITADA', 'EN_VERIFICACION', 'APROBADA', 'RECHAZADA']);
export type OxiocardStatus = z.infer<typeof OxiocardStatusSchema>;

export const OXIOCARD_STATUS_LABELS: Readonly<Record<OxiocardStatus, string>> = {
  NO_SOLICITADA: 'No solicitada',
  SOLICITADA: 'Solicitada',
  EN_VERIFICACION: 'En verificación',
  APROBADA: 'Aprobada',
  RECHAZADA: 'Rechazada',
};

/** Su OxioCard en su app (GET /operators/me/payout-info y POST /operators/me/oxiocard). */
export interface OxiocardView {
  status: OxiocardStatus;
  /** Último cambio de estado (null: nunca la pidió). */
  at: string | null;
}
