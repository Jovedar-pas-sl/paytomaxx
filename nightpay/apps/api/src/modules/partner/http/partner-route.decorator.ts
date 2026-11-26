import { Get, HttpCode, Post, SetMetadata, UseGuards, UseInterceptors, applyDecorators } from '@nestjs/common';
import type { PartnerRouteDef } from '@nightpay/contracts';
import { Public } from '../../../common/decorators/public.decorator';
import { PartnerKeyGuard } from '../auth/partner-key.guard';
import { PARTNER_ROUTE } from './partner-route.meta';
import { PartnerResponseInterceptor } from './partner-response.interceptor';

export { PARTNER_ROUTE };

/**
 * La única forma de declarar una ruta de la API de socios:
 * `@PartnerRoute(PARTNER_ROUTES.x)` (partner.wiring.spec.ts). Pública para el
 * JWT del personal (la clave la mira PartnerKeyGuard), con la definición de la
 * tabla para el guard (permisos, dinero) y el interceptor (lo que sale).
 */
export function PartnerRoute(def: PartnerRouteDef): MethodDecorator {
  return applyDecorators(
    SetMetadata(PARTNER_ROUTE, def),
    Public(),
    UseGuards(PartnerKeyGuard),
    UseInterceptors(PartnerResponseInterceptor),
    def.method === 'POST' ? Post(def.path) : Get(def.path),
    HttpCode(def.successStatus),
  );
}
