import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@nightpay/db';
import type { RequestContext } from '../context/request-context';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { TENANT_SCOPED_MODELS, scopeToTenant } from './tenant-scope';

export { TENANT_SCOPED_MODELS };

/**
 * Consulta a un modelo por local sin local en el contexto y sin decir que es
 * a propósito (asSystem / acrossVenues). Solo se lanza con
 * TENANCY_UNSCOPED_QUERIES=throw; por defecto se registra (log + métrica).
 */
export class UnscopedTenantQueryError extends Error {
  constructor(model: string, action: string) {
    super(`Consulta a ${model}.${action} sin local: usa asSystem/acrossVenues o una sesión con local`);
    this.name = 'UnscopedTenantQueryError';
  }
}

/** Un aviso por modelo.acción cada 10 min (la métrica cuenta todas). */
const UNSCOPED_LOG_EVERY_MS = 10 * 60 * 1000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly config?: ConfigService;
  private readonly metrics?: MetricsService;
  private readonly lastUnscopedLog = new Map<string, number>();

  constructor(
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Optional() @Inject(ConfigService) config?: ConfigService,
    @Optional() @Inject(MetricsService) metrics?: MetricsService,
  ) {
    super({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });
    this.cls = cls;
    this.config = config;
    this.metrics = metrics;
  }

  async onModuleInit(): Promise<void> {
    // Middleware: inyecta tenantId desde CLS en todas las queries tenant-scoped
    this.$use(async (params, next) => {
      if (!params.model || !TENANT_SCOPED_MODELS.has(params.model)) return next(params);
      const ctx = this.currentContext();
      if (ctx?.tenantId) return next(scopeToTenant(params, ctx.tenantId));
      // Sin local: solo vale si el código lo dice (asSystem/acrossVenues).
      // Si no, es un posible fallo de aislamiento: se avisa (y con
      // TENANCY_UNSCOPED_QUERIES=throw se corta).
      if (!ctx?.system && !ctx?.acrossVenues) this.reportUnscoped(params.model, params.action, ctx?.traceId);
      return next(params);
    });

    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Escapa RLS para operaciones de sistema (seed, CLI, jobs, rutas públicas
   * que comprueban el acceso en código). Si el contexto tiene local, el
   * middleware sigue filtrando por él: solo se salta RLS. Marca la consulta
   * como "de sistema" a propósito (no cuenta como consulta sin local).
   * SQL literal — sin input externo, no injection-prone.
   */
  async asSystem<T>(fn: (tx: TransactionalClient) => Promise<T>): Promise<T> {
    return this.withContext({ system: true }, () =>
      this.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        return fn(tx);
      }),
    );
  }

  /**
   * Como asSystem y, además, sin el filtro por local del middleware: para lo
   * que cruza locales a propósito (el saldo NightPay vale en todos los locales
   * del grupo). Quien lo use comprueba el acceso en código.
   */
  async acrossVenues<T>(fn: (tx: TransactionalClient) => Promise<T>): Promise<T> {
    return this.withContext({ tenantId: undefined, acrossVenues: true }, () => this.asSystem(fn));
  }

  /** Ejecuta fn con una copia del contexto CLS con estos cambios (fuera, el de siempre). */
  private withContext<T>(patch: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> {
    return this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('ctx', { ...(this.cls.get('ctx') ?? {}), ...patch });
      return fn();
    });
  }

  private currentContext(): RequestContext | undefined {
    return this.cls.isActive() ? this.cls.get('ctx') : undefined;
  }

  private reportUnscoped(model: string, action: string, traceId: string | undefined): void {
    this.metrics?.tenantUnscopedQueries.inc({ model, action });
    const key = `${model}.${action}`;
    const now = Date.now();
    if (now - (this.lastUnscopedLog.get(key) ?? 0) >= UNSCOPED_LOG_EVERY_MS) {
      this.lastUnscopedLog.set(key, now);
      this.logger.error(
        `Consulta a ${key} sin local ni asSystem/acrossVenues (traceId=${traceId ?? '-'}): revisar aislamiento por local`,
      );
    }
    if (this.unscopedPolicy() === 'throw') throw new UnscopedTenantQueryError(model, action);
  }

  private unscopedPolicy(): 'log' | 'throw' {
    const raw = this.config?.get<string>('TENANCY_UNSCOPED_QUERIES') ?? process.env.TENANCY_UNSCOPED_QUERIES;
    return raw === 'throw' ? 'throw' : 'log';
  }
}

/**
 * Tipo del cliente dentro de una transacción Prisma ($transaction callback).
 * Alineado con el tipo interno que usa Prisma (omite lifecycle + extends).
 */
export type TransactionalClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'
>;
