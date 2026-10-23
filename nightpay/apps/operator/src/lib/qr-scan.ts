// «Escanea el QR de la chica» (EscanearChica), lógica pura: cuándo se vuelve
// a preguntar al API por un QR leído. La cámara lo lee 4 veces por segundo:
// un QR que el API ya rechazó (caducado, de otro local, de alguien que no es
// una chica) no se vuelve a mandar mientras siga delante de la cámara. Si no,
// en medio minuto se gasta el límite por IP de /staff-qr/resolve (60 por
// minuto), que es el de TODO el local: los móviles del wifi del local salen
// por la misma IP y nadie más podría cobrar una «Copa con invitación».

/** Un QR rechazado y desde cuándo se puede volver a preguntar por él (Infinity: hasta que se lea otro). */
export interface RejectedQr {
  raw: string;
  retryAt: number;
}

/** Sin red o con el servidor caído: el mismo QR se vuelve a mandar pasado este rato. */
export const QR_RETRY_AFTER_MS = 3_000;
/** «Demasiadas peticiones» (429): se espera más. */
export const QR_RETRY_AFTER_LIMIT_MS = 30_000;

/** El API (o la app) dijo que este QR no vale; `status` 0 = sin respuesta. */
export function rejectedQr(raw: string, status: number, now: number): RejectedQr {
  if (status === 429) return { raw, retryAt: now + QR_RETRY_AFTER_LIMIT_MS };
  if (status === 0 || status === 408 || status >= 500) return { raw, retryAt: now + QR_RETRY_AFTER_MS };
  return { raw, retryAt: Number.POSITIVE_INFINITY };
}

/** ¿Se pregunta al API por este QR? Otro QR, siempre; el rechazado, solo cuando toque. */
export function shouldResolveQr(raw: string, rejected: RejectedQr | null, now: number): boolean {
  return !rejected || rejected.raw !== raw || now >= rejected.retryAt;
}

/** El código HTTP de un error del API (0 si no hubo respuesta). */
export function statusOf(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}
