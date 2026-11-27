import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { YAVIN_CANCEL_LINK_FAILED_EVENT, YavinAdapter } from '../gateways/yavin.adapter';
import { PaymentsService } from './payments.service';

/**
 * Al cancelar un cobro de Yavin, su enlace se anula en Yavin (cancel_link):
 * el cliente ya no puede pagarlo. Si Yavin no responde, el cobro queda
 * cancelado igual (el enlace caduca a las 72 h) y, si aun así se paga, el
 * aviso lo deja en Incidencias como «Pagó después de cancelar». También con
 * YAVIN_ENABLED apagado: el enlace ya abierto se sigue pudiendo pagar.
 */
@Injectable()
export class YavinCancelHook implements OnModuleInit {
  private readonly logger = new Logger(YavinCancelHook.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(YavinAdapter) private readonly yavin: YavinAdapter,
  ) {}

  onModuleInit(): void {
    this.payments.registerCancelHook((paymentId, tenantId) => this.cancelLinks(paymentId, tenantId));
  }

  /**
   * El enlace sigue vivo (hasta 72 h): queda apuntado en el cobro para que el
   * repaso de cancelados lo vuelva a mirar esas 72 h, no solo media hora
   * (requeueBankChecks). Si ni esto se puede apuntar, solo el log.
   */
  private async recordCancelFailed(paymentId: string, tenantId: string, cartId: string): Promise<void> {
    try {
      await this.prisma.asSystem((tx) =>
        tx.paymentEvent.create({
          data: { paymentId, tenantId, eventType: YAVIN_CANCEL_LINK_FAILED_EVENT, payload: { provider: 'YAVIN', cartId }, traceId: randomUUID() },
        }),
      );
    } catch (err) {
      this.logger.error(`Cancelar ${paymentId}: no se pudo apuntar que el enlace ${cartId} de Yavin sigue vivo: ${(err as Error).message}`);
    }
  }

  /** Anula los enlaces de Yavin aún abiertos de ese cobro (normalmente uno). */
  async cancelLinks(paymentId: string, tenantId: string): Promise<void> {
    const attempts = await this.prisma.asSystem((tx) =>
      tx.paymentAttempt.findMany({
        where: { paymentId, tenantId, provider: 'YAVIN', status: 'PENDING' },
        select: { providerTxId: true },
      }),
    );
    for (const a of attempts) {
      try {
        await this.yavin.cancelLink(tenantId, a.providerTxId);
      } catch (err) {
        this.logger.warn(`Cancelar ${paymentId}: Yavin no anuló el enlace ${a.providerTxId}: ${(err as Error).message}`);
        await this.recordCancelFailed(paymentId, tenantId, a.providerTxId);
      }
    }
  }
}
