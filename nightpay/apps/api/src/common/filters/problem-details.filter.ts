import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { reportError } from '../observability/sentry';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId?: string;
}

/**
 * Global filter — convierte cualquier excepcion a RFC 7807 ProblemDetails.
 * En produccion no expone stack traces ni mensajes internos.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);
  private readonly isProd: boolean;

  constructor(isProd: boolean) {
    this.isProd = isProd;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    let extra: Record<string, unknown> = {};

    // DIAGNOSTIC MARKER — confirma que esta versión del filter está activa.
    // Si la response no incluye "filterVersion", el deploy no está aplicado.
    extra._filterVersion = 'v3-diag-2026-05-15';
    // Capturar TODO lo que sepamos de la exception, sea Error, undefined,
    // null, o un objeto exótico.
    try {
      extra._excType = exception === null ? 'null' : exception === undefined ? 'undefined' : typeof exception;
      if (exception instanceof Error) {
        extra._errName = exception.name;
        extra._errMsg = exception.message;
        extra._errStack = exception.stack?.split('\n').slice(0, 8).join(' | ');
        if ('code' in exception) extra._errCode = (exception as { code: unknown }).code;
        if ('meta' in exception) extra._errMeta = (exception as { meta: unknown }).meta;
      } else if (exception && typeof exception === 'object') {
        extra._excDump = JSON.stringify(exception).slice(0, 500);
      } else {
        extra._excValue = String(exception).slice(0, 200);
      }
    } catch {
      extra._diagFailed = true;
    }

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        title = resp;
      } else if (resp && typeof resp === 'object') {
        const r = resp as Record<string, unknown>;
        title = (r.title as string) || (r.error as string) || exception.message;
        detail = (r.detail as string) || (r.message as string);
        // Pasa por extra los campos custom (issues de zod, etc.)
        for (const k of Object.keys(r)) {
          if (!['statusCode', 'message', 'error', 'title', 'detail'].includes(k)) {
            extra[k] = r[k];
          }
        }
      }
    } else if (exception instanceof Error) {
      // TEMP DIAGNOSTIC: exponemos el mensaje incluso en prod hasta que el
      // sistema esté estable. El usuario no tiene acceso a logs de Dokploy
      // y necesitamos ver el error en la response para depurar. Revertir
      // cuando la app esté en producción real con tráfico de clientes.
      title = exception.name;
      detail = exception.message;
      this.logger.error(`Unhandled: ${exception.message}`, exception.stack);
      // Sentry: solo reportar 5xx (errores no-HttpException son 500 por default).
      reportError(exception, { tag: 'http.unhandled' });
    } else {
      this.logger.error(`Unhandled non-Error throw: ${JSON.stringify(exception)}`);
      reportError(new Error(`Non-Error throw: ${JSON.stringify(exception)}`), {
        tag: 'http.unhandled',
      });
    }

    // Reportar también HttpException >= 500 (no las 4xx, que son cliente).
    if (exception instanceof HttpException && exception.getStatus() >= 500) {
      reportError(exception, { tag: 'http.5xx' });
    }

    // traceId — desde header X-Trace-Id o desde req.id
    const traceHeader = req.headers['x-trace-id'];
    const traceId =
      typeof traceHeader === 'string'
        ? traceHeader
        : Array.isArray(traceHeader)
          ? traceHeader[0]
          : (req.id as string | undefined);

    const body: ProblemDetails & Record<string, unknown> = {
      type: 'about:blank',
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: req.url,
      ...(traceId ? { traceId } : {}),
      ...extra,
    };

    res.status(status).type('application/problem+json').send(body);
  }
}
