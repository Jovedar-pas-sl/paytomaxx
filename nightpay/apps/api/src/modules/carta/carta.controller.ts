import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import {
  CreateServiceItemSchema,
  UpdateServiceItemSchema,
  type CreateServiceItemDto,
  type JwtPayload,
  type ServiceItem,
  type UpdateServiceItemDto,
} from '@nightpay/contracts';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CartaService } from './carta.service';

/**
 * Carta de servicios (Fase 1A).
 *  - GET /v1/services        → lo que puede cobrar quien llama (apps).
 *  - GET /v1/services/all    → carta completa para el panel.
 *  - POST/PATCH              → el dueño o el encargado la mantienen.
 */
@Controller('services')
@UseGuards(AuthGuard)
export class CartaController {
  private readonly carta: CartaService;

  constructor(@Inject(CartaService) carta: CartaService) {
    this.carta = carta;
  }

  @Get()
  async list(@CurrentUser() user: JwtPayload): Promise<ServiceItem[]> {
    return this.carta.listForStaff(user.tenantId, user.role);
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async listAll(@CurrentUser() user: JwtPayload): Promise<ServiceItem[]> {
    return this.carta.listAll(user.tenantId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateServiceItemSchema)) dto: CreateServiceItemDto,
  ): Promise<ServiceItem> {
    return this.carta.create(user.tenantId, user.sub, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateServiceItemSchema)) dto: UpdateServiceItemDto,
  ): Promise<ServiceItem> {
    return this.carta.update(user.tenantId, user.sub, id, dto);
  }
}
