import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  NO_SECTION_ENABLED_MESSAGE,
  UpdateInvitationRulesSchema,
  UpdatePostRulesSchema,
  UpdatePuestoSchema,
  UpdateSectionsSchema,
  effectivePost,
  isPostCode,
  invitationRulesOf,
  mergeInvitationRules,
  mergePostRules,
  mergeSections,
  postRulesOf,
  postSection,
  sectionsOf,
  type InvitationRules,
  type JwtPayload,
  type PostRules,
  type UpdateInvitationRulesDto,
  type UpdatePostRulesDto,
  type PuestoPerson,
  type UpdatePuestoDto,
  type UpdateSectionsDto,
  type VenueSection,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** Las chicas no tienen puesto: siempre Sala (Servicios). */
const PUESTO_ROLES = ['MANAGER', 'WAITER'] as const;

/**
 * El mapa del dinero en Ajustes (20261023100000):
 *  - GET/PATCH /v1/admin/venue/sections        → secciones del local (nombre, color, encendida).
 *  - GET       /v1/admin/venue/puestos         → el personal con su puesto.
 *  - PATCH     /v1/admin/venue/puestos/:userId → cambiar el puesto de una persona.
 *  - GET/PATCH /v1/admin/venue/post-rules      → qué cobra cada puesto (secciones,
 *    propinas, efectivo y recargas).
 *  - GET/PATCH /v1/admin/venue/invitation-rules → «Copa con invitación»: parte de la
 *    chica (% o fijo) y, solo si el local se la da, del camarero; el resto, del local.
 * Cada cambio queda en el registro (antes y después).
 */
@Controller('admin/venue')
@UseGuards(RolesGuard)
export class VenueSectionsController {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  /** Todo el personal: las apps y el panel pintan cada sección con su nombre y su color. */
  @Get('sections')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async sections(@CurrentUser() user: JwtPayload): Promise<{ sections: VenueSection[] }> {
    return { sections: sectionsOf(await this.storedSections(user.tenantId)) };
  }

  @Patch('sections')
  @Roles('OWNER')
  async updateSections(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateSectionsSchema)) dto: UpdateSectionsDto,
  ): Promise<{ sections: VenueSection[] }> {
    const current = await this.storedSections(user.tenantId);
    const after = mergeSections(current, dto);
    if (!after) throw new BadRequestException(NO_SECTION_ENABLED_MESSAGE);
    await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: user.tenantId }, data: { sections: after }, select: { id: true } }),
    );
    await this.log(user, 'venue.sections.updated', 'Venue', user.tenantId, { before: sectionsOf(current), after: sectionsOf(after) });
    return { sections: sectionsOf(after) };
  }

  @Get('puestos')
  @Roles('OWNER')
  async puestos(@CurrentUser() user: JwtPayload): Promise<PuestoPerson[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.user.findMany({
        where: { tenantId: user.tenantId, deletedAt: null, role: { in: [...PUESTO_ROLES] } },
        select: { id: true, email: true, displayName: true, role: true, post: true },
        orderBy: [{ role: 'asc' }, { displayName: 'asc' }, { email: 'asc' }],
      }),
    );
    return rows.map(puestoView);
  }

  @Patch('puestos/:userId')
  @Roles('OWNER')
  async updatePuesto(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(UpdatePuestoSchema)) dto: UpdatePuestoDto,
  ): Promise<PuestoPerson> {
    const person = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: { id: userId, tenantId: user.tenantId, deletedAt: null, role: { in: [...PUESTO_ROLES] } },
        select: { id: true, post: true },
      }),
    );
    if (!person) throw new NotFoundException('Esa persona no es del personal de este local');
    const updated = await this.prisma.asSystem((tx) =>
      tx.user.update({
        where: { id: userId },
        data: { post: dto.post },
        select: { id: true, email: true, displayName: true, role: true, post: true },
      }),
    );
    await this.log(user, 'user.post.updated', 'User', userId, { before: person.post, after: dto.post });
    return puestoView(updated);
  }

  @Get('post-rules')
  @Roles('OWNER')
  async postRules(@CurrentUser() user: JwtPayload): Promise<PostRules> {
    return postRulesOf(await this.storedPostRules(user.tenantId));
  }

  @Patch('post-rules')
  @Roles('OWNER')
  async updatePostRules(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdatePostRulesSchema)) dto: UpdatePostRulesDto,
  ): Promise<PostRules> {
    const current = await this.storedPostRules(user.tenantId);
    const after = mergePostRules(current, dto);
    await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: user.tenantId }, data: { postRules: after as never }, select: { id: true } }),
    );
    await this.log(user, 'venue.post_rules.updated', 'Venue', user.tenantId, { before: postRulesOf(current), after });
    return after;
  }

  /** El personal también: la app enseña «Copa con invitación» con lo que le toca a la chica. */
  @Get('invitation-rules')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async invitationRules(@CurrentUser() user: JwtPayload): Promise<InvitationRules> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: user.tenantId }, select: { invitationRules: true } }),
    );
    return invitationRulesOf(venue.invitationRules);
  }

  @Patch('invitation-rules')
  @Roles('OWNER')
  async updateInvitationRules(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateInvitationRulesSchema)) dto: UpdateInvitationRulesDto,
  ): Promise<InvitationRules> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: user.tenantId }, select: { invitationRules: true } }),
    );
    const after = mergeInvitationRules(venue.invitationRules, dto);
    await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: user.tenantId }, data: { invitationRules: after as never }, select: { id: true } }),
    );
    await this.log(user, 'venue.invitation_rules.updated', 'Venue', user.tenantId, {
      before: invitationRulesOf(venue.invitationRules),
      after,
    });
    return after;
  }

  private async storedPostRules(tenantId: string): Promise<unknown> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: { postRules: true } }),
    );
    return venue.postRules;
  }

  private async storedSections(tenantId: string): Promise<unknown> {
    // Venue no va por local en el middleware: id explícito del JWT.
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: { sections: true } }),
    );
    return venue.sections;
  }

  private log(
    user: JwtPayload,
    action: string,
    targetType: string,
    targetId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.log({ action, tenantId: user.tenantId, actorId: user.sub, actorEmail: user.email, targetType, targetId, payload });
  }
}

export function puestoView(u: {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  post: string | null;
}): PuestoPerson {
  const post = isPostCode(u.post) ? u.post : null;
  const effective = effectivePost({ role: u.role, post });
  return {
    id: u.id,
    name: u.displayName?.trim() || u.email,
    role: u.role as PuestoPerson['role'],
    post,
    effectivePost: effective,
    defaultCategory: postSection(effective),
  };
}
