import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PaymentStatus } from '@nightpay/contracts';

const ListPaymentsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? (v.split(',').filter(Boolean) as PaymentStatus[])
        : undefined,
    ),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});
type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;

@Controller('admin')
@UseGuards(RolesGuard)
export class AdminController {
  private readonly prisma: PrismaService;
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * Lista paginada de pagos del venue (cursor-based).
   * Filtros: status (lista comma-separated), limit, cursor (id del ultimo de la pagina anterior).
   */
  @Get('payments')
  @Roles('OWNER', 'MANAGER')
  async listPayments(
    @Tenant() _tenantId: string,
    @Query(new ZodValidationPipe(ListPaymentsQuerySchema)) q: ListPaymentsQuery,
  ) {
    // tenantId lo inyecta el middleware Prisma desde CLS
    const items = await this.prisma.payment.findMany({
      where: q.status ? { status: { in: q.status } } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        amountCents: true,
        availableAmountCents: true,
        currency: true,
        status: true,
        provider: true,
        providerTxId: true,
        createdAt: true,
        updatedAt: true,
        terminal: { select: { externalId: true, label: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Metricas agregadas del venue (hoy + 7 dias).
   * Bruto = sum amountCents AUTHORIZED|PARTIALLY_REFUNDED|REFUNDED
   * Refundeado = sum refunds.amountCents SUCCEEDED
   * Neto = bruto - refundeado
   */
  @Get('metrics')
  @Roles('OWNER', 'MANAGER')
  async metrics() {
    const today = startOfDay(new Date());
    const lastWeek = new Date(today.getTime() - 7 * 24 * 3600 * 1000);

    const [todayAggregate, weekAggregate, todayRefunds, weekRefunds, statusBreakdown] =
      await Promise.all([
        this.prisma.payment.aggregate({
          where: {
            createdAt: { gte: today },
            status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: {
            createdAt: { gte: lastWeek },
            status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        this.prisma.refund.aggregate({
          where: { createdAt: { gte: today }, status: 'SUCCEEDED' },
          _sum: { amountCents: true },
        }),
        this.prisma.refund.aggregate({
          where: { createdAt: { gte: lastWeek }, status: 'SUCCEEDED' },
          _sum: { amountCents: true },
        }),
        this.prisma.payment.groupBy({
          by: ['status'],
          where: { createdAt: { gte: today } },
          _count: { _all: true },
        }),
      ]);

    const todayGross = todayAggregate._sum.amountCents ?? 0;
    const todayRefunded = todayRefunds._sum.amountCents ?? 0;
    const weekGross = weekAggregate._sum.amountCents ?? 0;
    const weekRefunded = weekRefunds._sum.amountCents ?? 0;

    return {
      today: {
        count: todayAggregate._count._all,
        grossCents: todayGross,
        refundedCents: todayRefunded,
        netCents: todayGross - todayRefunded,
      },
      week: {
        count: weekAggregate._count._all,
        grossCents: weekGross,
        refundedCents: weekRefunded,
        netCents: weekGross - weekRefunded,
      },
      statusBreakdown: statusBreakdown.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      }, {}),
    };
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
