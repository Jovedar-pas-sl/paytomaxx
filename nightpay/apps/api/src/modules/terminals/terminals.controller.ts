import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { TerminalsService } from './terminals.service';
import {
  BulkCreateTerminalsSchema,
  CreateTerminalSchema,
  UpdateTerminalSchema,
  type BulkCreateTerminalsDto,
  type CreateTerminalDto,
  type JwtPayload,
  type TerminalView,
  type UpdateTerminalDto,
  type ZoneView,
} from '@nightpay/contracts';

@Controller('terminals')
@UseGuards(AuthGuard)
export class TerminalsController {
  private readonly service: TerminalsService;

  constructor(@Inject(TerminalsService) service: TerminalsService) {
    this.service = service;
  }

  /**
   * Lista zonas del venue con counts. Disponible para todos los roles
   * (OPERATOR la usa para el dropdown del CreatePayment).
   */
  @Get('zones')
  async listZones(@CurrentUser() user: JwtPayload): Promise<ZoneView[]> {
    return this.service.listZones(user.tenantId);
  }

  /** Lista todos los terminales del venue. */
  @Get()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async list(@CurrentUser() user: JwtPayload): Promise<TerminalView[]> {
    return this.service.list(user.tenantId);
  }

  /** Crea un terminal. */
  @Post()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateTerminalSchema)) dto: CreateTerminalDto,
  ): Promise<TerminalView> {
    return this.service.create(user.tenantId, user.sub, dto);
  }

  /** Crea N terminales con prefijo + zona común. */
  @Post('bulk')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async bulkCreate(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(BulkCreateTerminalsSchema)) dto: BulkCreateTerminalsDto,
  ): Promise<TerminalView[]> {
    return this.service.bulkCreate(user.tenantId, user.sub, dto);
  }

  /** Edita un terminal (label, zona, activación, etc.). */
  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async update(
    @Param('id') terminalId: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateTerminalSchema)) dto: UpdateTerminalDto,
  ): Promise<TerminalView> {
    return this.service.update(user.tenantId, terminalId, user.sub, dto);
  }
}
