import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CobroDetailService } from './cobro-detail.service';

/**
 * «Detalle del pago» (CobroDetailService): lo usan el panel y la app del
 * personal (MoneyMapModule) y la página del saldo del cliente (WalletsModule).
 * Aparte para que esos dos módulos no se importen entre sí.
 * AuthModule: StepUpService (la verificación del momento para lo delicado).
 */
@Module({
  imports: [AuthModule],
  providers: [CobroDetailService],
  exports: [CobroDetailService],
})
export class CobroDetailModule {}
