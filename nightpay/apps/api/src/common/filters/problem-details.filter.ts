import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ClsServiceManager } from 'nestjs-cls';
import { reportError } from '../observability/sentry';
import { redactSecretsInUrl } from '../logging/redact-url';
import { sanitizeTraceId } from '../context/trace-id';
import type { RequestContext } from '../context/request-context';

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
 *
 * D-fix (2026-05-29): el isProd recibido ahora SÍ se aplica:
 *  - dev: response incluye campos `_*` diagnóstico (stack, errName, etc.).
 *  - prod: response solo expone fields RFC 7807 + traceId + _filterVersion.
 *    Para depurar prod, usar el log del servidor + Sentry (los `_*` siguen
 *    yendo a logs locales y a reportError, solo NO se devuelven al cliente).
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
    // diagExtra: SIEMPRE se rellena (para logs locales). Solo se incluye en
    // la response al cliente si !isProd.
    const diagExtra: Record<string, unknown> = {};
    const httpExtra: Record<string, unknown> = {};

    // DIAGNOSTIC MARKER — confirma que esta versión del filter está activa.
    // Útil para post-deploy verification. Sin leak de internal info.
    const filterMarker = 'v4-prod-safe-2026-05-29';

    try {
      diagExtra._excType =
        exception === null ? 'null' : exception === undefined ? 'undefined' : typeof exception;
      if (exception instanceof Error) {
        diagExtra._errName = exception.name;
        diagExtra._errMsg = exception.message;
        diagExtra._errStack = exception.stack?.split('\n').slice(0, 8).join(' | ');
        if ('code' in exception) diagExtra._errCode = (exception as { code: unknown }).code;
        if ('meta' in exception) diagExtra._errMeta = (exception as { meta: unknown }).meta;
      } else if (exception && typeof exception === 'object') {
        diagExtra._excDump = JSON.stringify(exception).slice(0, 500);
      } else {
        diagExtra._excValue = String(exception).slice(0, 200);
      }
    } catch {
      diagExtra._diagFailed = true;
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
        // Pasa por extra los campos custom (issues de zod, hint, etc.) —
        // estos son CONTROLADOS por nuestro código, no leak. Se incluyen
        // siempre (dev y prod). Los del propio ProblemDetails no: el cuerpo
        // dice siempre el código de la respuesta HTTP (antes el ZodValidationPipe
        // respondía 400 con "status": 422 en el cuerpo).
        for (const k of Object.keys(r)) {
          if (!RESERVED_BODY_KEYS.has(k)) httpExtra[k] = r[k];
        }
      }
    } else if (isClientStatusError(exception)) {
      // Errores de Fastify y sus plugins con statusCode 4xx (límite global de
      // peticiones, cuerpo demasiado grande, JSON mal formado…): mensajes del
      // framework, sin datos internos. Antes salían como 500.
      status = exception.statusCode;
      title = exception.message;
    } else if (exception instanceof Error) {
      // En prod NO exponemos message ni name al cliente (puede leak DB
      // internals tipo "column does not exist", paths de archivos, etc.).
      // En dev sí lo exponemos para feedback inmediato.
      status = serverStatusOf(exception);
      if (this.isProd) {
        title = 'Internal Server Error';
        detail = undefined;
      } else {
        title = exception.name;
        detail = exception.message;
      }
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

    const traceId = traceIdOf(req);

    const body: ProblemDetails & Record<string, unknown> = {
      type: 'about:blank',
      title,
      status,
      ...(detail ? { detail } : {}),
      // Sin el token de la URL (/w/<token>, /pay/<token>…).
      instance: redactSecretsInUrl(req.url),
      ...(traceId ? { traceId } : {}),
      // httpExtra: campos custom de HttpException (hint, issues, etc.) —
      // controlados por nuestro código, OK en prod.
      ...httpExtra,
      // _filterVersion: deploy marker, sin info sensible. Útil en prod.
      _filterVersion: filterMarker,
      // diagExtra (stack, errName, etc.): SOLO en dev/test. En prod usar logs.
      ...(this.isProd ? {} : diagExtra),
    };

    res.status(status).type('application/problem+json').send(body);
  }
}

/** Campos que pone el filtro (o que Nest usa para el título y el detalle): no se copian del cuerpo de la excepción. */
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
  'statusCode',
  'message',
  'error',
  'title',
  'detail',
  'status',
  'type',
  'instance',
  'traceId',
  '_filterVersion',
]);

type StatusError = Error & { statusCode: number };

function hasStatusCode(exception: unknown): exception is StatusError {
  return exception instanceof Error && typeof (exception as Partial<StatusError>).statusCode === 'number';
}

function isClientStatusError(exception: unknown): exception is StatusError {
  return hasStatusCode(exception) && exception.statusCode >= 400 && exception.statusCode < 500;
}

/** 5xx de Fastify (p. ej. 503 al cerrar) se respeta; el resto, 500. */
function serverStatusOf(exception: Error): number {
  return hasStatusCode(exception) && exception.statusCode >= 500 && exception.statusCode <= 599
    ? exception.statusCode
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * El mismo traceId que se guarda en audit_events (contexto CLS, ya validado
 * en app.module); si no hay contexto, la cabecera solo si es válida, o el id
 * de la petición.
 */
function traceIdOf(req: FastifyRequest): string | undefined {
  const cls = ClsServiceManager.getClsService<{ ctx?: RequestContext }>();
  const fromCls = cls.isActive() ? cls.get('ctx')?.traceId : undefined;
  return fromCls ?? sanitizeTraceId(req.headers['x-trace-id']) ?? (req.id as string | undefined);
}
