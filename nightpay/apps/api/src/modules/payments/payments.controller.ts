import {
  Body,
  Controller,
  Get,
  GoneException,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ConfirmPosPaymentSchema,
  CreatePaymentSchema,
  type ConfirmPosPaymentDto,
  type CreatePaymentDto,
  type CreatedPaymentResponse,
  type PublicPaymentView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotent.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CardGatewayChoice, JwtPayload } from '@nightpay/contracts';
import { cardGatewayChoicesIn } from '../gateways/card-gateway';
import { PaymentsService } from './payments.service';
import { mayReadCobro } from './payment-read-access';
import { staffBankRef, type StaffBankRef } from './staff-bank-ref';
import { listUnpaidCobros, type UnpaidCobro } from './unpaid-cobros';

@Controller('payments')
export class PaymentsController {
  private readonly payments: PaymentsService;
  private readonly prisma: PrismaService;
  constructor(@Inject(PaymentsService) payments: PaymentsService, @Inject(PrismaService) prisma: PrismaService) {
    this.payments = payments;
    this.prisma = prisma;
  }

  /**
   * TPV crea un pago. Requiere AuthGuard (global) + role.
   * Idempotency-Key obligatoria — clave de las mutaciones financieras.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async create(
    @Tenant() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreatePaymentSchema)) dto: CreatePaymentDto,
  ): Promise<CreatedPaymentResponse> {
    return this.payments.create(tenantId, idempotencyKey, dto, {
      userId: user.sub,
      role: user.role,
    });
  }

  /**
   * Lista cobros POS pendientes — para el panel del camarero. Tenant-scoped.
   * Soporta filtro opcional por zona vía query param `?zone=BARRA`.
   */
  @Get('pending-pos')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async pendingPos(
    @Tenant() tenantId: string,
    @Query('zone') zone?: string,
  ) {
    return this.payments.listPendingPos(tenantId, zone);
  }

  /**
   * Los cobros sin pagar de todo el local (app del personal → Cobros): para
   * cancelar también los de otra persona. Cualquiera del personal del local.
   */
  @Get('sin-pagar')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'OPERATOR', 'WAITER')
  async unpaid(@Tenant() tenantId: string, @CurrentUser() user: JwtPayload): Promise<{ items: UnpaidCobro[] }> {
    return { items: await listUnpaidCobros(this.prisma, { tenantId, userId: user.sub }) };
  }

  /**
   * Entre qué pasarelas de tarjeta elige el personal al cobrar: «BBVA» y
   * «Yavin» solo si el local tiene las dos (card-gateway.ts); si no, ninguna
   * elección (como hoy).
   */
  @Get('card-gateways')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'OPERATOR', 'WAITER')
  async cardGateways(@Tenant() tenantId: string): Promise<CardGatewayChoice> {
    return { options: await this.prisma.asSystem((tx) => cardGatewayChoicesIn(tx, tenantId)) };
  }

  /**
   * Camarero confirma cobrado tras procesar la tarjeta en el datáfono externo.
   * Solo válido para captureMethod=POS_EXTERNAL en estado CREATED.
   * La transición dispara el hook que crea OperatorEarning para la chica.
   */
  @Post(':id/confirm-pos')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async confirmPos(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ConfirmPosPaymentSchema)) dto: ConfirmPosPaymentDto,
  ): Promise<{ status: string }> {
    return this.payments.confirmPosPayment(
      id,
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
      dto,
    );
  }

  /**
   * Cancela un cobro sin pagar del local (también con el cliente en su banco).
   * Cualquiera del personal del local, sea suyo o de otra persona.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'OPERATOR', 'WAITER')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ status: string }> {
    return this.payments.cancel(id, {
      userId: user.sub,
      role: user.role,
      tenantId: user.tenantId,
    });
  }

  /**
   * Detalle interno — pasa por Prisma middleware tenant filter. El dueño y el
   * encargado, cualquiera del local; el camarero, solo los suyos (uno de otra
   * persona, 404: antes enseñaba cualquier cobro).
   */
  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    const payment = await this.payments.findById(id);
    if (!mayReadCobro({ userId: user.sub, role: user.role }, payment.createdByUserId)) throw new NotFoundException('Payment not found');
    return payment;
  }

  /**
   * «El banco no lo ha confirmado» (Esperando, cobro ORPHAN): la referencia
   * corta y el pedido del banco, para que el encargado lo busque en el portal.
   * La chica y el camarero, solo de sus cobros (staff-bank-ref.ts).
   */
  @Get(':id/bank-ref')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async bankRef(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload): Promise<StaffBankRef> {
    return staffBankRef(this.prisma, id, { userId: user.sub, role: user.role, tenantId: user.tenantId });
  }

  /**
   * Lookup público por QR token — el cliente lo escanea sin auth.
   * Sólo expone datos seguros (importe, venue, terminal; el id solo pagado).
   * Lo sondean también las apps del personal (sin sesión, cada 4-10 s por
   * cobro abierto, todas desde la IP del local): fuera del límite global, con
   * el suyo. Cada cobro tiene su cupo desde esa IP y la IP un tope alto (con
   * 600 por IP, unos 60 cobros abiertos a la vez ya daban 429; carga 19-11).
   */
  @Public()
  @Get('public/:token')
  // Es el estado vivo de un cobro: ni el navegador ni un proxy del local lo guardan.
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 6_000, windowSec: 60, scope: 'payment-public', failOpen: true, perKey: { param: 'token', max: 60 } })
  async getPublic(@Param('token') token: string): Promise<PublicPaymentView> {
    return this.payments.getByToken(token);
  }

  /**
   * Retirado (410 Gone). Era el «voy a pagar» del web-client antiguo, que
   * desde el 15-oct-2026 (89bd484) redirige a la página del API: ninguna app
   * lo llama. Abría el pago en la pasarela sin la página de pago: sin propina
   * ni método, con el intento sin la marca del navegador que paga (la página
   * «Pagado» de una recarga no reconocía a nadie) y, a quien lo llamara con el
   * enlace del QR antes que el cliente, le dejaba el cobro en AUTHORIZING. El
   * pago va por POST /pay/{token} (PublicPayController), con la elección del
   * cliente. Sigue pública para que quien la llame reciba el 410 y no un 401.
   */
  @Public()
  @Post('public/:token/start-authorization')
  startAuthorization(@Param('token') _token: string): never {
    throw new GoneException({
      message: 'Endpoint retirado',
      hint: 'El cliente paga en GET /pay/{token} (sin el prefijo /v1): la página envía POST /pay/{token} con su elección.',
      migratedAt: '2026-10-26',
    });
  }

  /**
   * obs #10 (code review): endpoint eliminado. Tras C1, doAuthorize() persiste
   * la URL Peanpe en `gatewayPaymentUrl` y `/pay/{token}` la sirve via 302.
   * Ningún frontend del repo lo llama. Lo dejamos respondiendo **410 Gone**
   * para que cualquier cliente externo experimental sepa que tiene que migrar.
   *
   * Por qué 410 y no 200 deprecated: el handler antiguo devolvía la URL
   * Peanpe firmada con HMAC válida. Cualquiera con un qrToken válido podía
   * obtenerla — vector de enumeración + filtración del flujo PSP. 410 cierra
   * el oracle sin afectar al flujo legítimo (que pasa por /pay/{token}).
   */
  @Public()
  @Get('public/:token/peanpe-redirect-url')
  peanpeRedirectUrl(@Param('token') _token: string): never {
    throw new GoneException({
      message: 'Endpoint deprecated y eliminado',
      hint:
        'Usa GET /pay/{token} (sin /v1 prefix). Hace 302 automáticamente al ' +
        'formulario hosted del PSP correspondiente (Peanpe, Wipay, Paytef).',
      migratedAt: '2026-05-29',
    });
  }
}
