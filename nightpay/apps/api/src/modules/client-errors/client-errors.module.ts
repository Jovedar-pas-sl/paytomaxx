import { Module } from '@nestjs/common';
import { TelegramService } from '../incidents/telegram.service';
import { ClientErrorsController } from './client-errors.controller';
import { ClientErrorsService } from './client-errors.service';

/** Los fallos de pantalla de las apps (error.tsx): registro, métrica y Telegram. */
@Module({
  controllers: [ClientErrorsController],
  providers: [ClientErrorsService, TelegramService],
})
export class ClientErrorsModule {}
