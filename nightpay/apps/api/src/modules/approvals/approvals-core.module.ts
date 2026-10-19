import { Module } from '@nestjs/common';
import { TelegramService } from '../incidents/telegram.service';
import { ApprovalNotifier } from './approval-notifier';
import { ApprovalRequestsService } from './approval-requests.service';

/**
 * Lo de «Por aprobar» que necesitan los endpoints de siempre para decidir si
 * hacen o piden (pagos a las chicas, devoluciones). Sin pagos ni devoluciones
 * dentro: así RefundsModule y AdminModule lo importan sin ciclos.
 */
@Module({
  providers: [ApprovalRequestsService, ApprovalNotifier, TelegramService],
  exports: [ApprovalRequestsService],
})
export class ApprovalsCoreModule {}
