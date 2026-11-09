import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CLIENT_ERROR_APPS, ClientErrorsService, type ClientErrorApp } from './client-errors.service';

// Huella de Next y marca del build: letras, cifras y . _ + - (nada que falsee el registro).
const TAG = /^[\w.+-]{1,64}$/;
export const ClientErrorSchema = z.object({
  app: z.enum(Object.keys(CLIENT_ERROR_APPS) as [ClientErrorApp, ...ClientErrorApp[]]),
  message: z.string().max(2_000),
  digest: z.string().regex(TAG).optional(),
  // location.pathname: empieza por «/» y no lleva espacios ni caracteres de control.
  path: z.string().max(500).regex(/^\/[\x21-\x7E]*$/).optional(),
  build: z.string().regex(TAG).optional(),
});

/**
 * POST /v1/client-errors → 204. Lo manda la pantalla de fallo de las apps
 * (error.tsx). Sin sesión: la app puede haber fallado justo por ella. Con
 * límite por IP holgado (el wifi del local lo comparten todos) y sin contestar
 * nada: quien lo manda no espera respuesta.
 */
@Controller('client-errors')
export class ClientErrorsController {
  constructor(@Inject(ClientErrorsService) private readonly errors: ClientErrorsService) {}

  @Public()
  @Post()
  @HttpCode(204)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'client-error', failOpen: true })
  async report(@Body(new ZodValidationPipe(ClientErrorSchema)) body: z.infer<typeof ClientErrorSchema>): Promise<void> {
    await this.errors.report(body);
  }
}
