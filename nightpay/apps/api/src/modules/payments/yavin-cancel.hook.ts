import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { YavinAdapter } from '../gateways/yavin.adapter';
import { yavinEnabled } from '../gateways/yavin-flag';
import { PaymentsService } from './payments.service';

/**
 * Al cancelar un cobro de Yavin, su enlace se anula en Yavin (cancel_link):
 * el cliente ya no puede pagarlo. Si Yavin no responde, el cobro queda
 * cancelado igual (el enlace caduca a las 72 h) y, si aun así se paga, el
 * aviso lo deja en Incidencias como «Pagó después de cancelar».
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

  /** Anula los enlaces de Yavin aún abiertos de ese cobro (normalmente uno). */
  async cancelLinks(paymentId: string, tenantId: string): Promise<void> {
    if (!yavinEnabled()) return;
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
      }
    }
  }
}
