import { InternalServerErrorException, Logger } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { Role } from '@nightpay/contracts';
import type { ClientDevice } from '../http/client-device';

export interface RequestContext {
  tenantId?: string;
  userId?: string;
  role?: Role;
  venueSlug?: string;
  traceId?: string;
  /** Dentro de PrismaService.acrossVenues: consulta entre locales a propósito. */
  acrossVenues?: boolean;
  /** Dentro de PrismaService.asSystem: consulta de sistema a propósito (sin local si no lo hay). */
  system?: boolean;
  /**
   * El dispositivo y la IP real de quien hace la petición (setup de CLS en
   * app.module.ts): se guarda con el cobro en los eventos `payment.device`.
   */
  device?: ClientDevice;
  /** La sesión del personal (el `sid` del token): la verificación del momento va atada a ella. */
  sessionId?: string;
  /** La prueba de la llave de acceso para la acción de esta petición (cabecera X-Step-Up-Token). */
  stepUpToken?: string;
  /** La acción para la que ya se gastó esa prueba en esta petición. */
  stepUpSpentFor?: string;
  /** La petición llega de la «Pantalla del cliente» de la barra (su credencial), como su camarero. */
  customerScreen?: boolean;
}

const logger = new Logger('RequestContext');

/**
 * Pone el local (y quién es) en el contexto de la petición para que el
 * middleware de Prisma filtre por él. Si el contexto CLS no está activo (el
 * middleware de CLS no corrió: p. ej. una ruta que se salta el middleware),
 * se corta la petición: seguir sería consultar SIN filtro por local.
 * Conserva lo que ya hubiera (traceId).
 */
export function bindTenantContext(
  cls: ClsService<{ ctx: RequestContext }>,
  ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'role' | 'venueSlug' | 'sessionId' | 'stepUpToken' | 'customerScreen'>,
): void {
  if (!cls.isActive()) {
    logger.error('Contexto CLS inactivo en una petición con sesión: se rechaza (sin él no habría filtro por local)');
    throw new InternalServerErrorException('Contexto de la petición no disponible');
  }
  cls.set('ctx', { ...(cls.get('ctx') ?? {}), ...ctx });
}
