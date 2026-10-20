import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { effectivePost, paymentMethodsOf, postSection, sectionsOf, type JwtPayload } from '@nightpay/contracts';

@Controller('venues')
@UseGuards(RolesGuard)
export class VenuesController {
  private readonly prisma: PrismaService;
  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * El local de quien llama y sus formas de cobro (Ajustes): las apps del
   * personal esconden lo apagado. También la chica (OPERATOR). El mapa del
   * dinero: las secciones del local y el puesto de quien llama (la app
   * marca su sección en «Otro importe»).
   */
  @Get('me')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async getMyVenue(@CurrentUser() user: JwtPayload) {
    // Query directa sin filtro: Venue NO está en TENANT_SCOPED_MODELS (no tiene tenantId;
    // ES el tenant). Filtramos por id explícito desde el JWT.
    const [{ paymentMethods, sections, ...venue }, me] = await Promise.all([
      this.prisma.venue.findUniqueOrThrow({
        where: { id: user.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          createdAt: true,
          paymentMethods: true,
          sections: true,
        },
      }),
      this.prisma.user.findFirst({ where: { id: user.sub }, select: { post: true } }),
    ]);
    const myPost = effectivePost({ role: user.role, post: me?.post ?? null });
    return {
      ...venue,
      paymentMethods: paymentMethodsOf(paymentMethods),
      sections: sectionsOf(sections),
      myPost,
      /** La sección que la app marca por defecto (la de su puesto). */
      myDefaultCategory: postSection(myPost),
    };
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
