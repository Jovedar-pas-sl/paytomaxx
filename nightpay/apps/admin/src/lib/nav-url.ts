// La sección y la pestaña del panel viven en la URL (?s=ajustes&t=formas):
// recargar, o volver a entrar tras caducar la sesión, deja al dueño donde
// estaba, y «atrás» vuelve a la pestaña de antes. Hoy · Resumen (lo primero)
// no lleva nada: la URL limpia de siempre; ?t=cobros sigue abriendo Cobros. Solo nombres de sección y pestaña,
// nunca ids de cobros ni nada secreto; los otros parámetros no se tocan.

import type { Edition } from '@nightpay/contracts';
import { PANEL_EDITION } from './edition';
import { sectionOf, SECTION_LABELS, type PanelSection, type SectionKey, type TabKey } from './roles';

export const SECTION_PARAM = 's';
export const TAB_PARAM = 't';

/** Donde se empieza: Hoy · Resumen. */
export const DEFAULT_TAB: TabKey = 'resumen';
/** OxioParty empieza en «En directo». */
export const PARTY_DEFAULT_TAB: TabKey = 'live';

/** La pestaña de inicio de cada edición (la de la URL limpia). */
export function defaultTabOf(edition: Edition = PANEL_EDITION): TabKey {
  return edition === 'party' ? PARTY_DEFAULT_TAB : DEFAULT_TAB;
}

/** Cómo se escribe cada pestaña en la URL (en castellano, como se ve). */
const TAB_SLUG: Readonly<Record<TabKey, string>> = {
  resumen: 'resumen',
  payments: 'cobros',
  money: 'mapa',
  incidents: 'avisos',
  operators: 'chicas',
  treasury: 'pagos',
  wallets: 'saldos',
  fichas: 'fichas',
  reservations: 'reservados',
  nights: 'noches',
  reports: 'informes',
  bank: 'banco',
  oxiopay: 'liquidaciones-oxiopay',
  carta: 'carta',
  sections: 'secciones',
  terminals: 'datafonos',
  rules: 'reglas',
  methods: 'formas',
  night: 'noche',
  permissions: 'permisos',
  alerts: 'telegram',
  security: 'seguridad',
  superadmin: 'superadmin',
  live: 'directo',
  stalls: 'casetas',
  wristbands: 'pulseras',
  partyRefunds: 'devoluciones',
  settlement: 'cierre',
  party: 'fiesta',
};

const SECTION_KEYS = Object.keys(SECTION_LABELS) as SectionKey[];

const SLUG_TAB: ReadonlyMap<string, TabKey> = new Map(
  (Object.entries(TAB_SLUG) as Array<[TabKey, string]>).map(([tab, slug]) => [slug, tab]),
);

/** Lo que pide la URL. `tab: null` con `hasTab`: traía una pestaña que no existe. */
export interface NavRequest {
  section: SectionKey | null;
  tab: TabKey | null;
  /** La URL traía ?t= (aunque no valga): entonces no se abre la sección sin más. */
  hasTab: boolean;
}

function clean(value: string | null): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

export function parseNav(search: string): NavRequest {
  const params = new URLSearchParams(search);
  const s = clean(params.get(SECTION_PARAM));
  const t = clean(params.get(TAB_PARAM));
  const section = SECTION_KEYS.find((key) => key === s) ?? null;
  return { section, tab: t === null ? null : (SLUG_TAB.get(t) ?? null), hasTab: t !== null };
}

/** Lo que pide quien navega a una pestaña. */
export function navRequestFor(tab: TabKey, edition: Edition = PANEL_EDITION): NavRequest {
  return { section: sectionOf(tab, edition), tab, hasTab: true };
}

/**
 * La pestaña que se enseña con lo que ve este rol:
 *  - la pedida, si la ve (la sección sale de ella);
 *  - solo la sección (?s=ajustes): su primera pestaña;
 *  - otra cosa (no existe, o este rol o este local no la tienen): Hoy · Resumen
 *    (en OxioParty, En directo).
 */
export function resolveNav(req: NavRequest, sections: readonly PanelSection[], edition: Edition = PANEL_EDITION): TabKey {
  const visible = sections.flatMap((s) => s.tabs.map((t) => t.key));
  if (req.tab !== null && visible.includes(req.tab)) return req.tab;
  if (!req.hasTab && req.section !== null) {
    const first = sections.find((s) => s.key === req.section)?.tabs[0];
    if (first) return first.key;
  }
  const home = defaultTabOf(edition);
  return visible.includes(home) ? home : (visible[0] ?? home);
}

/**
 * La query con esa pestaña (?s=ajustes&t=formas), sin tocar los otros
 * parámetros. Hoy · Resumen los quita. Devuelve '' o '?…'.
 */
export function navSearch(search: string, tab: TabKey, edition: Edition = PANEL_EDITION): string {
  const params = new URLSearchParams(search);
  if (tab === defaultTabOf(edition)) {
    params.delete(SECTION_PARAM);
    params.delete(TAB_PARAM);
  } else {
    params.set(SECTION_PARAM, sectionOf(tab, edition));
    params.set(TAB_PARAM, TAB_SLUG[tab]);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
