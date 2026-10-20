import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { nightSettingsOf, paymentMethodsOf, type JwtPayload } from '@nightpay/contracts';

@Controller('venues')
@UseGuards(RolesGuard)
export class VenuesController {
  private readonly prisma: PrismaService;
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * El local de quien llama, sus formas de cobro y los ajustes de la noche
   * (Ajustes): las apps del personal esconden lo apagado y usan el teclado
   * del PIN y la recepción que tocan. También la chica (OPERATOR).
   */
  @Get('me')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async getMyVenue(@CurrentUser() user: JwtPayload) {
    // Query directa sin filtro: Venue NO está en TENANT_SCOPED_MODELS (no tiene tenantId;
    // ES el tenant). Filtramos por id explícito desde el JWT.
    const { paymentMethods, nightSettings, ...venue } = await this.prisma.venue.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        createdAt: true,
        paymentMethods: true,
        nightSettings: true,
      },
    });
    return { ...venue, paymentMethods: paymentMethodsOf(paymentMethods), nightSettings: nightSettingsOf(nightSettings) };
  }

  @Get('me/terminals')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async listTerminals() {
    // Middleware Prisma inyecta tenantId automáticamente
    return this.prisma.terminal.findMany({
      where: { active: true },
      select: { id: true, externalId: true, label: true, active: true },
    });
  }

  @Get('me/staff')
  @Roles('OWNER', 'MANAGER')
  async listStaff() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      select: { id: true, email: true, role: true, createdAt: true },
    });
  }
}
