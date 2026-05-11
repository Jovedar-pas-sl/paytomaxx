import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { TreasuryService } from './treasury.service';
import { TreasuryController } from './treasury.controller';
import { PayoutVerifierFactory } from './payout-verifier.factory';

/**
 * Phase 1A — Treasury module.
 *
 * Expone endpoints admin para:
 *  - Estadísticas treasury (saldo pendiente, payouts mes, split por método)
 *  - Verificación on-chain de payouts (Tronscan/BscScan/Polygonscan/Solscan)
 *  - Confirmación manual de payouts no auto-verificables (e-wallets, wires, etc.)
 *  - Reconciliación on-demand (también vía cron nocturno)
 */
@Module({
  imports: [AuditModule],
  controllers: [TreasuryController],
  providers: [TreasuryService, PrismaService, PayoutVerifierFactory],
  exports: [TreasuryService],
})
export class TreasuryModule {}
