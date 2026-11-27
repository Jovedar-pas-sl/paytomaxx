// Primeros pasos (entrega 10 A, idea 23): la tarjeta del dueño sobre «Resumen»
// para dejar listo un local nuevo. Lógica pura: los cinco pasos, cuántos están
// hechos y si la tarjeta sale. En el navegador solo se guardan dos marcas.

import type { TabKey } from './roles';

/** Lo que dicen las cinco preguntas al API (y la marca de Formas de cobro). */
export interface PrimerosPasosDatos {
  /** Platos y bebidas de la carta (fetchCarta). */
  carta: number;
  /** Compañeras (fetchOperators()) y camareros (fetchOperators('WAITER')): cualquiera cuenta. */
  companeras: number;
  camareros: number;
  /** El dueño ya abrió Ajustes → Formas de cobro (la marca que pone Dashboard). */
  formasVistas: boolean;
  /** fetchTotpStatus().enabled */
  dosPasos: boolean;
  /** Noches del local (fetchNights). */
  noches: number;
}

export interface PrimerPaso {
  key: 'carta' | 'equipo' | 'formas' | 'dos-pasos' | 'noche';
  label: string;
  done: boolean;
  tab: TabKey;
}

export interface PrimerosPasosVista {
  visible: boolean;
  pasos: PrimerPaso[];
  hechos: number;
  /** «2 de 5». */
  texto: string;
  /** Los cinco hechos: el aviso «Tu local está listo» (una vez) y se oculta. */
  completo: boolean;
}

/** Con tantas noches el local ya está en marcha: la tarjeta no sale. */
const NOCHES_EN_MARCHA = 3;

/** `datos` null: aún no se saben los cinco (o alguno falló): no sale. */
export function primerosPasos(datos: PrimerosPasosDatos | null, { oculto = false }: { oculto?: boolean } = {}): PrimerosPasosVista {
  const d = datos;
  const pasos: PrimerPaso[] = [
    { key: 'carta', label: 'Pon tu carta', done: Boolean(d && d.carta > 0), tab: 'carta' },
    { key: 'equipo', label: 'Da de alta a tu equipo', done: Boolean(d && d.companeras + d.camareros > 0), tab: 'operators' },
    { key: 'formas', label: 'Revisa cómo cobras', done: Boolean(d?.formasVistas), tab: 'methods' },
    { key: 'dos-pasos', label: 'Activa la verificación en dos pasos', done: Boolean(d?.dosPasos), tab: 'security' },
    { key: 'noche', label: 'Abre tu primera noche', done: Boolean(d && d.noches > 0), tab: 'nights' },
  ];
  const hechos = pasos.filter((p) => p.done).length;
  return {
    visible: d !== null && !oculto && d.noches < NOCHES_EN_MARCHA,
    pasos,
    hechos,
    texto: `${hechos} de ${pasos.length}`,
    completo: hechos === pasos.length,
  };
}

/** «Ocultar» o 5 de 5: la tarjeta ya no sale en ese local (valor «oculto»). */
export function primerosPasosKey(tenantId: string): string {
  return `np-primeros-pasos:${tenantId}`;
}

/** El dueño vio Ajustes → Formas de cobro (la pone Dashboard). */
export function primerosPasosFormasKey(tenantId: string): string {
  return `np-primeros-pasos-formas:${tenantId}`;
}
