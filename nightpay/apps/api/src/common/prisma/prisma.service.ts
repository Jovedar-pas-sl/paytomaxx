import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { Prisma, PrismaClient } from '@nightpay/db';
import type { RequestContext } from '../context/request-context';
import { MetricsService } from '../../modules/metrics/metrics.service';
import { TENANT_SCOPED_MODELS, scopeToTenant } from './tenant-scope';
import { TENANT_GUC, forcedRlsTarget } from './rls';

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

/**
 * Consulta a una tabla con FORCE RLS fuera de una transacción de
 * PrismaService: esa conexión no lleva ni el local ni el bypass, así que con
 * un rol sin superusuario no ve filas. Solo se lanza con
 * TENANCY_UNSCOPED_QUERIES=throw; por defecto se registra (log + métrica).
 */
export class RlsOutsideTransactionError extends Error {
  constructor(target: string, action: string) {
    super(`Consulta a ${target} (${action}) fuera de una transacción: usa withTenant, asSystem o acrossVenues`);
    this.name = 'RlsOutsideTransactionError';
  }
}

/** Un aviso por modelo.acción cada 10 min (la métrica cuenta todas). */
const UNSCOPED_LOG_EVERY_MS = 10 * 60 * 1000;

type BatchOptions = { isolationLevel?: Prisma.TransactionIsolationLevel };
type ItxOptions = BatchOptions & { maxWait?: number; timeout?: number };
type UnwrapTuple<P extends readonly unknown[]> = { [K in keyof P]: Awaited<P[K]> };

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
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
      // Las tablas con FORCE RLS solo dentro de una transacción (local o bypass en la sesión).
      if (!params.runInTransaction) this.checkForcedRls(params);
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

  /**
   * Al final del apagado (onApplicationShutdown, después de cerrar el HTTP y
   * los workers: main.ts → shutdown.ts), no en onModuleDestroy, que Nest corre
   * ANTES de cerrar el servidor: las peticiones en vuelo se quedaban sin base.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * El $transaction de Prisma y, si es trabajo de un local (contexto con
   * local, fuera de asSystem/acrossVenues), con ese local en la sesión de la
   * transacción (`app.current_tenant_id`, solo mientras dura): las políticas
   * de RLS de la base aíslan por local también en las tablas con FORCE RLS.
   * Cuesta una sentencia más por transacción. Sin local en el contexto, igual
   * que antes.
   */
  override $transaction<P extends Prisma.PrismaPromise<unknown>[]>(
    arg: [...P],
    options?: BatchOptions,
  ): Promise<UnwrapTuple<P>>;
  override $transaction<R>(fn: (tx: TransactionalClient) => Promise<R>, options?: ItxOptions): Promise<R>;
  override $transaction(arg: unknown, options?: ItxOptions): Promise<unknown> {
    const tenantId = this.sessionTenant();
    if (typeof arg === 'function') {
      const fn = arg as (tx: TransactionalClient) => Promise<unknown>;
      if (!tenantId) return super.$transaction(fn, options);
      return super.$transaction(async (tx) => {
        await tx.$executeRaw(tenantStatement(tenantId));
        return fn(tx);
      }, options);
    }
    const ops = arg as Prisma.PrismaPromise<unknown>[];
    if (!tenantId) return super.$transaction(ops, options);
    return super.$transaction([this.$executeRaw(tenantStatement(tenantId)), ...ops], options).then(([, ...rest]) => rest);
  }

  /**
   * Trabajo de UN local con RLS de verdad: una transacción con ese local en
   * la sesión y sin bypass. En las tablas con FORCE RLS solo se ven (y solo se
   * pueden escribir) filas de ese local aunque la consulta no filtrara, y el
   * middleware también filtra por él. Para el panel y la app de las chicas, y
   * para trabajos que saben de qué local son.
   */
  async withTenant<T>(tenantId: string, fn: (tx: TransactionalClient) => Promise<T>): Promise<T> {
    if (!tenantId) throw new Error('withTenant necesita un local');
    return this.withContext({ tenantId, system: false, acrossVenues: false }, () => this.$transaction(fn));
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

  /** El local que va en la sesión de las transacciones (no en asSystem/acrossVenues: llevan bypass). */
  private sessionTenant(): string | undefined {
    const ctx = this.currentContext();
    return ctx?.tenantId && !ctx.system && !ctx.acrossVenues ? ctx.tenantId : undefined;
  }

  /** Tabla con FORCE RLS fuera de una transacción: se avisa (y con la política throw se corta). */
  private checkForcedRls(params: { model?: string; action: string; args?: unknown }): void {
    const target = forcedRlsTarget(params);
    if (!target) return;
    this.metrics?.rlsOutsideTransaction.inc({ target, action: params.action });
    const traceId = this.currentContext()?.traceId ?? '-';
    this.logEvery10Min(
      `rls:${target}.${params.action}`,
      `Consulta a ${target} (${params.action}) fuera de una transacción (traceId=${traceId}): ` +
        'con un rol de base de datos sin superusuario no ve filas (FORCE RLS). Usa withTenant/asSystem/acrossVenues',
    );
    if (this.unscopedPolicy() === 'throw') throw new RlsOutsideTransactionError(target, params.action);
  }

  private reportUnscoped(model: string, action: string, traceId: string | undefined): void {
    this.metrics?.tenantUnscopedQueries.inc({ model, action });
    this.logEvery10Min(
      `${model}.${action}`,
      `Consulta a ${model}.${action} sin local ni asSystem/acrossVenues (traceId=${traceId ?? '-'}): revisar aislamiento por local`,
    );
    if (this.unscopedPolicy() === 'throw') throw new UnscopedTenantQueryError(model, action);
  }

  private logEvery10Min(key: string, message: string): void {
    const now = Date.now();
    if (now - (this.lastUnscopedLog.get(key) ?? 0) < UNSCOPED_LOG_EVERY_MS) return;
    this.lastUnscopedLog.set(key, now);
    this.logger.error(message);
  }

  private unscopedPolicy(): 'log' | 'throw' {
    const raw = this.config?.get<string>('TENANCY_UNSCOPED_QUERIES') ?? process.env.TENANCY_UNSCOPED_QUERIES;
    return raw === 'throw' ? 'throw' : 'log';
  }
}

/** Pone el local en la sesión solo para la transacción en curso (is_local = true). */
function tenantStatement(tenantId: string): Prisma.Sql {
  return Prisma.sql`SELECT set_config(${TENANT_GUC}, ${tenantId}, true)`;
}

/**
 * Tipo del cliente dentro de una transacción Prisma ($transaction callback).
 * Alineado con el tipo interno que usa Prisma (omite lifecycle + extends).
 */
export type TransactionalClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'
>;
