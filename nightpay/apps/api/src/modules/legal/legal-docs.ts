import type { PayLanguage } from '../payments/customer-lang';
import { legalDocsEn } from './legal-docs.en';
import { legalDocsEs } from './legal-docs.es';
import type { LegalOwner } from './legal-owner';

/** Las cuatro páginas, por su ruta: /legal/<id>. */
export const LEGAL_DOC_IDS = ['aviso-legal', 'privacidad', 'cookies', 'condiciones'] as const;
export type LegalDocId = (typeof LEGAL_DOC_IDS)[number];

/**
 * Un bloque de texto. En los textos, [texto](enlace) es un enlace: solo
 * https://, mailto: y /legal/… (a estos el renderer les añade el idioma).
 */
export type LegalBlock =
  | { readonly h: string; readonly id?: string }
  | { readonly p: string }
  | { readonly ul: readonly string[] }
  | { readonly table: { readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] } };

export interface LegalDoc {
  readonly title: string;
  readonly blocks: readonly LegalBlock[];
}

export type LegalDocs = Readonly<Record<LegalDocId, LegalDoc>>;

export function isLegalDocId(value: unknown): value is LegalDocId {
  return typeof value === 'string' && (LEGAL_DOC_IDS as readonly string[]).includes(value);
}

/** Los textos están en castellano (el que vale) y en inglés; francés y portugués leen el inglés. */
export function legalTextLanguage(lang: PayLanguage): 'es' | 'en' {
  return lang === 'es' ? 'es' : 'en';
}

export function legalDocs(lang: PayLanguage, owner: LegalOwner): LegalDocs {
  return legalTextLanguage(lang) === 'es' ? legalDocsEs(owner) : legalDocsEn(owner);
}
