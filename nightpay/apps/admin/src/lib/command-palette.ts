// Buscar y saltar (Ctrl+K): lo que enseña cada grupo. Solo lo que el rol ya
// ve (sus pestañas) y solo para ir: ninguna fila hace nada con el dinero.

import type { CobroRow, WalletCardStatus } from '@nightpay/contracts';
import { cobroPaidCents } from './cobros-totals';
import { formatDateTime } from './dates';
import { fichaStatusLabel } from './fichas';
import { formatEur } from './money';
import type { PanelSection, PanelTab, TabKey } from './roles';

/** Hasta 5 filas por grupo. */
export const PALETTE_LIMIT = 5;
/** Desde 3 letras se buscan cobros (como el buscador de Cobros). */
export const COBROS_MIN = 3;

/** Sin mayúsculas, tildes ni eñes. */
export function sinTildes(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function matches(label: string, q: string): boolean {
  const needle = sinTildes(q);
  return needle.length > 0 && sinTildes(label).includes(needle);
}

/** Pantallas: las que ve este rol. */
export function pantallasDe(sections: readonly PanelSection[], q: string): Array<{ key: TabKey; label: string }> {
  return sections
    .flatMap((s) => s.tabs)
    .filter((t) => matches(t.label, q))
    .slice(0, PALETTE_LIMIT)
    .map((t) => ({ key: t.key, label: t.label }));
}

export interface Destino {
  tab: TabKey;
  /** Resumen con el cierre de la noche abierto (lo mismo que su botón «Cerrar noche»). */
  cerrarNoche?: true;
  /** Compañeras con el alta abierta. */
  nuevaCompanera?: true;
}

export interface Accion {
  id: 'cerrar-noche' | 'abrir-noche' | 'nueva-companera' | 'pagar' | 'informes';
  label: string;
  destino: Destino;
}

export interface AccionesCtx {
  tabs: readonly PanelTab[];
  isOwner: boolean;
  /** El dueño, o el encargado con «cerrar la noche». */
  canCloseNight: boolean;
  /** fetchCurrentNight() al abrir; 'unknown' mientras llega o si falla. */
  night: 'open' | 'none' | 'unknown';
}

/** Acciones: solo navegan. Cada una a una pestaña que el rol ya ve. */
export function accionesDe(ctx: AccionesCtx, q: string): Accion[] {
  const sees = (key: TabKey) => ctx.tabs.some((t) => t.key === key);
  const all: Accion[] = [];
  if (ctx.night === 'open' && ctx.canCloseNight && sees('resumen')) {
    all.push({ id: 'cerrar-noche', label: 'Cerrar noche', destino: { tab: 'resumen', cerrarNoche: true } });
  }
  if (ctx.night === 'none' && sees('nights')) all.push({ id: 'abrir-noche', label: 'Abrir noche', destino: { tab: 'nights' } });
  if (sees('operators')) all.push({ id: 'nueva-companera', label: 'Nueva compañera', destino: { tab: 'operators', nuevaCompanera: true } });
  if (sees('treasury')) all.push({ id: 'pagar', label: 'Pagar a compañeras', destino: { tab: 'treasury' } });
  if (ctx.isOwner && sees('reports')) all.push({ id: 'informes', label: 'Descargar informes', destino: { tab: 'reports' } });
  const shown = sinTildes(q) ? all.filter((a) => matches(a.label, q)) : all;
  return shown.slice(0, PALETTE_LIMIT);
}

/** Qué se busca con lo escrito: cobros desde 3 letras; fichas con «ficha 522» o solo cifras. */
export function queBuscar(raw: string): { cobros: string | null; ficha: string | null } {
  const q = raw.trim().slice(0, 128);
  const ficha = /^(?:ficha\s*)?(\d{1,12})$/i.exec(q)?.[1] ?? null;
  return { cobros: q.length >= COBROS_MIN ? q : null, ficha };
}

/** «C-0022 · 02:14 · 33,00 €». Sin referencia no sale (null). */
export function filaCobro(row: CobroRow, tz: string): string | null {
  if (!row.ref) return null;
  return `${row.ref} · ${formatDateTime(row.createdAt, tz, 'time')} · ${formatEur(cobroPaidCents(row))}`;
}

/** «Ficha 522 · Entregada». */
export function filaFicha(card: { printedNumber?: string | null; status: WalletCardStatus }): string {
  return `${card.printedNumber ? `Ficha ${card.printedNumber}` : 'Ficha sin número'} · ${fichaStatusLabel(card.status)}`;
}

export interface Persona {
  id: string;
  nombre: string;
  tipo: 'Compañera' | 'Camarero';
}

/** Personas: solo el nombre que se enseña; nunca el correo, el teléfono, el documento ni la cuenta. */
export function personasDe(
  chicas: ReadonlyArray<{ id: string; displayName: string | null }>,
  camareros: ReadonlyArray<{ id: string; displayName: string | null }>,
  q: string,
): Persona[] {
  const of = (list: ReadonlyArray<{ id: string; displayName: string | null }>, tipo: Persona['tipo']): Persona[] =>
    list.flatMap((p) => (p.displayName && matches(p.displayName, q) ? [{ id: p.id, nombre: p.displayName, tipo }] : []));
  return [...of(chicas, 'Compañera'), ...of(camareros, 'Camarero')].slice(0, PALETTE_LIMIT);
}
