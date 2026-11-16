/**
 * El titular de OxioPay: sale en el Aviso legal, en Privacidad y en las
 * Condiciones. Cambiarlo aquí cambia las cuatro páginas.
 */
export interface LegalOwner {
  readonly name: string;
  readonly taxId: string;
  readonly address: string;
  readonly email: string;
  /** Inscripción en el Registro Mercantil (LSSI art. 10). Null: la línea no sale. */
  readonly registry: string | null;
}

export const LEGAL_OWNER: LegalOwner = Object.freeze({
  name: 'JOVEDAR PAS S.L.',
  taxId: 'B56932551',
  // Domicilio social y datos registrales: certificación del Registro Mercantil de Valencia (16-01-2025).
  address: 'Calle Almirante Cadarso, 26, bajo, 46005 Valencia (España)',
  email: 'info@oxiocard.com',
  registry: 'Registro Mercantil de Valencia, tomo 11511, folio 171, hoja V-216074',
});

/** Última revisión de los textos (sale arriba de cada página). */
export const LEGAL_UPDATED = '2026-11-16';
