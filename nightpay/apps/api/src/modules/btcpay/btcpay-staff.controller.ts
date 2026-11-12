import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { BtcpayInvoiceView, JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BtcpayInvoiceService } from './btcpay-invoice.service';
import { BtcpayEnabledGuard } from './btcpay-flag';

/**
 * Para las apps del personal (la pantalla llega en la fase 2). Quien hizo el
 * cobro, o el encargado y el dueño:
 *  - POST /v1/payments/:id/bitcoin  crea la factura de bitcoin del cobro (o devuelve la abierta)
 *  - GET  /v1/payments/:id/bitcoin  su QR, su importe en BTC y su estado (null si no hay)
 */
@Controller('payments')
@UseGuards(BtcpayEnabledGuard, RolesGuard)
@Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
export class BtcpayStaffController {
  constructor(@Inject(BtcpayInvoiceService) private readonly invoices: BtcpayInvoiceService) {}

  @Post(':id/bitcoin')
  @HttpCode(200)
  create(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload): Promise<BtcpayInvoiceView> {
    return this.invoices.startForStaff(id, { userId: user.sub, role: user.role, tenantId: user.tenantId });
  }

  @Get(':id/bitcoin')
  async read(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload): Promise<{ invoice: BtcpayInvoiceView | null }> {
    return { invoice: await this.invoices.viewForStaff(id, { userId: user.sub, role: user.role, tenantId: user.tenantId }) };
  }
}
