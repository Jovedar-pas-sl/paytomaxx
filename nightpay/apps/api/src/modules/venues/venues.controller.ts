import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { VENUE_SERVICE_FEE_SELECT, venueServiceFeeOf } from '../payments/service-fee';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  chargeRightsOf,
  initialOfferedSection,
  nightSettingsOf,
  paymentMethodsOf,
  postRulesOf,
  sectionsOf,
  type JwtPayload,
} from '@nightpay/contracts';

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
   * del PIN y la recepción que tocan. También la chica (OPERATOR). El mapa
   * del dinero: las secciones del local y el puesto de quien llama (la app
   * marca su sección en «Otro importe»).
   */
  @Get('me')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async getMyVenue(@CurrentUser() user: JwtPayload) {
    // Query directa sin filtro: Venue NO está en TENANT_SCOPED_MODELS (no tiene tenantId;
    // ES el tenant). Filtramos por id explícito desde el JWT.
    const [{ paymentMethods, nightSettings, sections, postRules, serviceFeeEnabled, serviceFeeBps, topUpServiceFeeBps, ...venue }, me] = await Promise.all([
      this.prisma.venue.findUniqueOrThrow({
        where: { id: user.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          createdAt: true,
          paymentMethods: true,
          nightSettings: true,
          sections: true,
          postRules: true,
          ...VENUE_SERVICE_FEE_SELECT,
        },
      }),
      this.prisma.user.findFirst({ where: { id: user.sub }, select: { post: true } }),
    ]);
    const rights = chargeRightsOf({ role: user.role, post: me?.post ?? null }, postRulesOf(postRules));
    const venueSections = sectionsOf(sections);
    return {
      ...venue,
      paymentMethods: paymentMethodsOf(paymentMethods),
      nightSettings: nightSettingsOf(nightSettings),
      sections: venueSections,
      myPost: rights.post,
      /** Lo que puede cobrar quien llama (su puesto): la app solo enseña eso. */
      myRights: { sections: rights.sections, tips: rights.tips, cash: rights.cash, topUps: rights.topUps },
      /** La sección que la app marca por defecto (la de su puesto, si la puede cobrar). */
      myDefaultCategory: initialOfferedSection(venueSections, rights),
      /** «Comisión del servicio al cliente»: el interruptor y los % (las apps enseñan lo que paga el cliente). */
      serviceFee: venueServiceFeeOf({ serviceFeeEnabled, serviceFeeBps, topUpServiceFeeBps }),
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
