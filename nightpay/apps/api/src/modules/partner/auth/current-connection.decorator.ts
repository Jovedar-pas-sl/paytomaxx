import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Prisma } from '@nightpay/db';
import type { PartnerScope } from '@nightpay/contracts';
import { partnerError } from '../http/partner-problem';

/** Lo que el guard lee de la conexión (con su socio y su local), en asSystem. */
export const PARTNER_CONNECTION_INCLUDE = {
  partner: { select: { id: true, name: true, status: true, allowedScopes: true, egressIps: true } },
  venue: { select: { name: true, deletedAt: true, businessId: true, business: { select: { name: true, taxId: true } } } },
} as const satisfies Prisma.PartnerConnectionInclude;

export type PartnerGuardConnection = Prisma.PartnerConnectionGetPayload<{ include: typeof PARTNER_CONNECTION_INCLUDE }>;

/** La clave de la petición, ya comprobada por PartnerKeyGuard. */
export interface PartnerAuth {
  connection: PartnerGuardConnection;
  /** La actual o la anterior (durante el solape de una rotación). */
  keyMatch: 'current' | 'previous';
  /** La pista de la clave con la que llamó. */
  keyHint: string;
  /** El sha256 de la clave con la que llamó (la carga comprueba, con la conexión bloqueada, que aún vale). */
  keyHash: string;
  /** Los de la conexión dentro del techo del socio, leído ahora. */
  effectiveScopes: PartnerScope[];
}

export const CurrentConnection = createParamDecorator((_data: unknown, ctx: ExecutionContext): PartnerAuth => {
  const auth = ctx.switchToHttp().getRequest<{ partner?: PartnerAuth }>().partner;
  // Sin guard no hay clave: nunca se llega aquí desde una ruta @PartnerRoute.
  if (!auth) throw partnerError('invalid_api_key');
  return auth;
});
