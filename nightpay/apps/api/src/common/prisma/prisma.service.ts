import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '@nightpay/db';
import type { RequestContext } from '../context/request-context';

/**
 * Modelos que requieren aislamiento por tenant_id.
 * Si añades un modelo con tenantId, agrégalo aquí o el middleware no lo protegerá.
 */
const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Terminal',
  'GatewayCredential',
  'Payment',
  'PaymentEvent',
  'Refund',
  'Reconciliation',
  'OperatorEarning',
  'OperatorPayout',
  'ServiceItem',
]);

// Operaciones de lectura a filtrar y de escritura a inyectar tenantId
const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const WRITE_OPS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(@Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>) {
    super({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });
    this.cls = cls;
  }

  async onModuleInit(): Promise<void> {
    // Middleware: inyecta tenantId desde CLS en todas las queries tenant-scoped
    this.$use(async (params, next) => {
      if (!params.model || !TENANT_SCOPED_MODELS.has(params.model)) {
        return next(params);
      }

      const ctx = this.cls.get('ctx');
      const tenantId = ctx?.tenantId;

      // Si no hay tenant en contexto (ej. bootstrap, seed, jobs de sistema), dejar pasar.
      // Jobs de sistema deben usar `this.prisma.$transaction(...)` y setear tenant explícito.
      if (!tenantId) {
        // Solo loggeamos en producción si encontramos queries sin tenant — posible bug
        if (process.env.NODE_ENV === 'production') {
          this.logger.warn(
            `Prisma query on ${params.model}.${params.action} without tenantId in CLS`,
          );
        }
        return next(params);
      }

      // Inyectar tenantId en queries
      if (READ_OPS.has(params.action)) {
        params.args ??= {};
        params.args.where = { ...(params.args.where ?? {}), tenantId };
      } else if (WRITE_OPS.has(params.action)) {
        params.args ??= {};
        if (params.action === 'create') {
          params.args.data = { ...(params.args.data ?? {}), tenantId };
        } else if (params.action === 'createMany') {
          const data = params.args.data;
          if (Array.isArray(data)) {
            params.args.data = data.map((row: Record<string, unknown>) => ({ ...row, tenantId }));
          }
        } else if (params.action === 'upsert') {
          params.args.where = { ...(params.args.where ?? {}), tenantId };
          params.args.create = { ...(params.args.create ?? {}), tenantId };
        } else {
          params.args.where = { ...(params.args.where ?? {}), tenantId };
        }
      }

      return next(params);
    });

    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Ejecuta una transaccion con contexto RLS aplicado (SET LOCAL app.current_tenant_id).
   * SECURITY: tenantId se valida como UUID antes de interpolar — Postgres SET LOCAL
   * no admite placeholders parametrizados, asi que validamos en codigo.
   */
  async withTenantTransaction<T>(
    tenantId: string,
    fn: (tx: TransactionalClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_REGEX.test(tenantId)) {
      throw new Error('withTenantTransaction: tenantId is not a valid UUID');
    }
    return this.$transaction(async (tx) => {
      // tenantId valido por regex — interpolacion segura
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return fn(tx);
    });
  }

  /**
   * Escapa RLS para operaciones de sistema (seed, CLI, migraciones, jobs globales).
   * SQL literal — sin input externo, no injection-prone.
   */
  async asSystem<T>(fn: (tx: TransactionalClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      return fn(tx);
    });
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tipo del cliente dentro de una transacción Prisma ($transaction callback).
 * Alineado con el tipo interno que usa Prisma (omite lifecycle + extends).
 */
export type TransactionalClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'
>;
