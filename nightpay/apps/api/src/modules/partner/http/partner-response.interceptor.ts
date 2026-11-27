import { Inject, Injectable, Logger, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PartnerRouteDef } from '@nightpay/contracts';
import { map, type Observable } from 'rxjs';
import { partnerRequestId } from './partner-problem';
import { PARTNER_ROUTE } from './partner-route.meta';

interface HeaderReply {
  header(key: string, value: string): unknown;
}

/**
 * Lo que sale de una ruta de socios pasa por su esquema publicado
 * (`def.response`, el mismo que el OpenAPI): lo que sobra se quita (nunca sale
 * un campo interno) y lo que no cumple es un 500 internal_error (nunca sale
 * algo que la documentación no dice). Con `Request-Id` y `Cache-Control: no-store`.
 */
@Injectable()
export class PartnerResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PartnerResponseInterceptor.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const def = this.reflector.get<PartnerRouteDef | undefined>(PARTNER_ROUTE, ctx.getHandler());
    if (!def) throw new Error('Ruta de socios sin su definición (@PartnerRoute)');
    const http = ctx.switchToHttp();
    const reply = http.getResponse<HeaderReply>();
    reply.header('Request-Id', partnerRequestId(http.getRequest()));
    reply.header('Cache-Control', 'no-store');
    return next.handle().pipe(
      map((body: unknown) => {
        const parsed = def.response.safeParse(body);
        if (parsed.success) return parsed.data;
        // Solo dónde falla, nunca los valores.
        const where = parsed.error.issues.map((i) => i.path.join('.') || '(raíz)').join(', ');
        this.logger.error(`La respuesta de ${def.operationId} no cumple su esquema publicado: ${where}`);
        throw new Error(`Respuesta de ${def.operationId} fuera de su esquema`);
      }),
    );
  }
}
