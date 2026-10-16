import type { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/context/request-context';

/**
 * Ejecuta `fn` como si la petición fuera de ese local: el middleware de
 * Prisma filtra (y pone el local en las altas) con `venueId` en vez del local
 * activo en la sesión del super-admin. Para reutilizar servicios del panel
 * que trabajan "en el local de la sesión" (p. ej. el alta de una chica) sobre
 * otro local. Fuera de `fn`, el contexto de siempre.
 */
export function inVenue<T>(cls: ClsService<{ ctx: RequestContext }>, venueId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run({ ifNested: 'inherit' }, () => {
    cls.set('ctx', { ...(cls.get('ctx') ?? {}), tenantId: venueId });
    return fn();
  });
}
