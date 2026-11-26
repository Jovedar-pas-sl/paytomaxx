// Cobro por el encargado (fase 1): con «Las compañeras cobran desde su móvil»
// apagada, el encargado, el dueño o recepción con permiso cobran el servicio a
// nombre de la compañera. La app no lo adivina: cuando el API contesta que
// falta su «Mi QR» (o que el leído ya no vale), escanea el suyo con la misma
// cuenta. Funciones puras y textos.

import { SERVICE_OPERATOR_INVALID_CODE, SERVICE_OPERATOR_REQUIRED_CODE } from '@nightpay/contracts';
import { CobroApiError } from './api-cobro';
import { cuentaTotals, type Cuenta } from './cuenta';

/** ¿El API pide la compañera del servicio? (falta su «Mi QR» o el leído ha caducado). */
export function needsCompanera(err: unknown): boolean {
  return err instanceof CobroApiError && (err.code === SERVICE_OPERATOR_REQUIRED_CODE || err.code === SERVICE_OPERATOR_INVALID_CODE);
}

/** Lo de Servicios que se le apunta (los packs, solo su parte de Servicios) y el total del cobro. */
export function servicioDe(cuenta: Cuenta): { serviceCents: number; totalCents: number } {
  const totals = cuentaTotals(cuenta);
  return { serviceCents: totals.bySection.find((s) => s.section === 'CHICA_SERVICE')?.cents ?? 0, totalCents: totals.totalCents };
}

/** Los textos del escáner del «Mi QR» (EscanearChica). */
export interface ScanTexts {
  heading: string;
  /** El QR leído no es el «Mi QR» de nadie del personal. */
  notStaff: string;
  /** Debajo, sin «Elegir de la lista». */
  hint: string;
  camLabel: string;
  /** Sin lector en el navegador: con la cámara del móvil. */
  noCamera: string;
}

export const SERVICIO_SCAN_TEXTS: ScanTexts = {
  heading: 'Escanea el «Mi QR» de la compañera',
  notStaff: 'Ese QR no es el de una compañera. Que abra «Mi QR» en su app.',
  hint: 'En su app: «Mi QR». ¿Sin móvil? Que entre con su usuario en otro móvil.',
  camLabel: 'Cámara para leer el QR de la compañera',
  noCamera: 'Abre la cámara del móvil y apunta a su QR: llega aquí solo.',
};

/** La espera del datáfono: para la compañera (avisa al camarero) o para quien lo cobra él mismo. */
export interface PosWaitTexts {
  /** Antes del código corto (#ABC123). */
  codeLead: string;
  /** «Camarero: escanea el QR…»: solo si lo cobra otra persona. */
  callWaiter: boolean;
  /** Detrás de «Cobra 66 € en el datáfono»: cómo se confirma. */
  after: string;
}

export function posWaitTexts(byStaff: boolean): PosWaitTexts {
  return byStaff
    ? {
        codeLead: 'Cóbralo en el datáfono. Código:',
        callWaiter: false,
        after: '. Si no se confirma solo, confírmalo en la pestaña «POS» con el código del ticket.',
      }
    : { codeLead: 'Llama al camarero. Código:', callWaiter: true, after: ', luego confirma en tu app.' };
}
