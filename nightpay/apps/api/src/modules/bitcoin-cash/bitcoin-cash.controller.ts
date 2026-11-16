import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  BitcoinCashRefundSchema,
  isApprovalRequested,
  type ApprovalRequestedResponse,
  type BitcoinCashConfig,
  type BitcoinCashDone,
  type BitcoinCashRefundDto,
  type JwtPayload,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { actorOf } from '../approvals/approvals.controller';
import { BitcoinCashService } from './bitcoin-cash.service';

/**
 * Devolver en efectivo lo pagado con bitcoin (solo el encargado y el dueño;
 * apagado de fábrica en cada local). Ver @nightpay/contracts bitcoin-cash.ts.
 * Pasado el umbral del local, en vez de hacerlo, lo pide al dueño: 202.
 */
@Controller()
@UseGuards(RolesGuard)
@Roles('OWNER', 'MANAGER')
export class BitcoinCashController {
  constructor(@Inject(BitcoinCashService) private readonly cash: BitcoinCashService) {}

  @Get('bitcoin-cash/config')
  config(@CurrentUser() user: JwtPayload): Promise<BitcoinCashConfig> {
    return this.cash.config(actorOf(user));
  }

  @Post('payments/:id/bitcoin-cash-refund')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'bitcoin-cash' })
  async refundPayment(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body(new ZodValidationPipe(BitcoinCashRefundSchema)) dto: BitcoinCashRefundDto,
    @Res({ passthrough: true }) reply?: FastifyReply,
  ): Promise<BitcoinCashDone | ApprovalRequestedResponse> {
    const out = await this.cash.refundPayment(actorOf(user), paymentId, dto);
    if (isApprovalRequested(out)) reply?.status(202);
    return out;
  }

  @Post('btcpay/invoices/:invoiceId/cash-return')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'bitcoin-cash' })
  async returnInvoice(
    @CurrentUser() user: JwtPayload,
    @Param('invoiceId') invoiceId: string,
    @Body(new ZodValidationPipe(BitcoinCashRefundSchema)) dto: BitcoinCashRefundDto,
    @Res({ passthrough: true }) reply?: FastifyReply,
  ): Promise<BitcoinCashDone | ApprovalRequestedResponse> {
    const out = await this.cash.returnInvoice(actorOf(user), safeInvoiceId(invoiceId), dto);
    if (isApprovalRequested(out)) reply?.status(202);
    return out;
  }

  /** «Entregado»: el dueño ya lo aprobó y el dinero sale ahora de la caja. */
  @Post('approvals/:id/handed')
  @HttpCode(200)
  handed(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) approvalId: string): Promise<BitcoinCashDone> {
    return this.cash.handOver(actorOf(user), approvalId);
  }
}

/** El id de una factura de BTCPay: letras y números (nada que acabe en una consulta rara). */
function safeInvoiceId(raw: string): string {
  const id = raw.trim();
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return '-';
  return id;
}
