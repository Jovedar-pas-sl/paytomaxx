import { ConflictException } from '@nestjs/common';
import { SELF_ONBOARDING_ALREADY_SAVED } from '@nightpay/contracts';

/**
 * El enlace de alta de la chica es de un solo uso: al guardar, en
 * users.selfOnboardingToken se deja `used:<hash>` en vez del hash del enlace
 * activo. El mismo enlace ya no deja guardar ni leer nada, pero si se perdió la
 * respuesta y la chica reintenta (o lo vuelve a abrir), se le dice que sus
 * datos ya están guardados en vez de «Token inválido». Un enlace nuevo del
 * admin pisa la marca (y el viejo pasa a ser inválido, como siempre).
 */
const USED_PREFIX = 'used:';

export function usedTokenMarker(tokenHash: string): string {
  return `${USED_PREFIX}${tokenHash}`;
}

export function selfOnboardingAlreadySaved(): ConflictException {
  return new ConflictException({
    message: 'Tus datos ya se guardaron con este enlace. Si quieres cambiar algo, pide al admin un enlace nuevo.',
    code: SELF_ONBOARDING_ALREADY_SAVED,
  });
}

/** Prisma: el update con `where` no encontró la fila (otro «Guardar» ganó o el admin hizo otro enlace). */
export function isRecordNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';
}
