// La carta del puesto en la app del personal (useCarta): se vuelve a pedir al
// volver a la pestaña (focus / visibilitychange). Funciones puras: un refetch
// que falla con la carta ya a la vista, o que trae lo mismo, devuelve el MISMO
// estado (React no vuelve a pintar ni reinicia la cámara del escáner) (APP-04).

import type { ServiceItem } from './api';

export interface CartaState {
  services: ServiceItem[];
  /** No se pudo cargar ninguna vez: se cobra tecleando el importe y se ofrece reintentar. */
  failed: boolean;
  /** Ya contestó (con servicios, sin ninguno o con error). */
  loaded: boolean;
}

export const CARTA_START: CartaState = { services: [], failed: false, loaded: false };

function sameCarta(a: readonly ServiceItem[], b: readonly ServiceItem[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/** Llegó la carta: si es la que ya se ve, el mismo estado; si no, la nueva (y sin aviso). */
export function cartaArrived(prev: CartaState, list: ServiceItem[]): CartaState {
  if (prev.loaded && !prev.failed && sameCarta(prev.services, list)) return prev;
  return { services: list, failed: false, loaded: true };
}

/**
 * La petición falló: con una carta buena ya cargada no cambia nada (sigue a
 * la vista, sin «No se pudo cargar la carta»); sin ninguna, el aviso.
 */
export function cartaFailed(prev: CartaState): CartaState {
  if (prev.loaded) return prev;
  return { ...prev, failed: true, loaded: true };
}
