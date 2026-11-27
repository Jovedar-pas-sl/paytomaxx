import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import {
  INVITATION_QR_REQUIRED,
  INVITATION_TOKEN_INVALID,
  invitationRulesOf,
  staffTokenFrom,
  type InvitableStaff,
  type JwtPayload,
  type StaffQrView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { photoHashesOf } from '../profile/photo-hashes';
import { operatorAppBaseUrl } from './operator-app-url';
import { signStaffToken, staffQrSecret, verifyStaffToken } from './staff-qr';

const ResolveSchema = z.object({ token: z.string().trim().min(20).max(600) });

/** Nombre que ve el camarero: el suyo o, sin él, lo de antes de la @ del correo. */
export function staffName(u: { displayName: string | null; email: string }): string {
  return u.displayName?.trim() || u.email.split('@')[0] || 'Chica';
}

/**
 * «Mi QR» (Copa con invitación):
 *  - GET  /v1/operators/me/staff-qr      → el QR personal de la chica, firmado y
 *    de vida corta (la app lo renueva). Lleva la app del personal con
 *    ?invita=<token>: el camarero lo escanea con su app o con la cámara.
 *  - POST /v1/operators/staff-qr/resolve → el camarero lo acaba de leer: de
 *    quién es («Nerea reconocida»). Solo de su local y sin caducar.
 *  - GET  /v1/operators/invitables       → las chicas del local, para elegirla
 *    de la lista si el local no pide su QR (Ajustes → Invitaciones).
 */
@Controller('operators')
@UseGuards(RolesGuard)
export class StaffQrController {
  private readonly config: ConfigService;
  private readonly prisma: PrismaService;

  constructor(@Inject(ConfigService) config: ConfigService, @Inject(PrismaService) prisma: PrismaService) {
    this.config = config;
    this.prisma = prisma;
  }

  @Get('me/staff-qr')
  @Roles('OPERATOR')
  async myStaffQr(@CurrentUser() user: JwtPayload): Promise<StaffQrView> {
    const { token, expiresAt } = signStaffToken({ userId: user.sub, tenantId: user.tenantId }, Date.now(), staffQrSecret());
    const base = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    const url = base ? `${base}/?invita=${token}` : token;
    const qrPngDataUrl = await QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
    return { url, token, qrPngDataUrl, expiresAt: expiresAt.toISOString() };
  }

  @Post('staff-qr/resolve')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'staff-qr-resolve' })
  async resolve(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ResolveSchema)) body: z.infer<typeof ResolveSchema>,
  ): Promise<InvitableStaff> {
    const token = staffTokenFrom(body.token);
    const who = token ? verifyStaffToken(token, Date.now(), staffQrSecret()) : null;
    if (!who || who.tenantId !== user.tenantId || who.userId === user.sub) throw new BadRequestException(INVITATION_TOKEN_INVALID);
    const chica = await this.prisma.asSystem((tx) =>
      tx.user.findFirst({
        where: { id: who.userId, tenantId: user.tenantId, role: 'OPERATOR', deletedAt: null },
        select: { id: true, displayName: true, email: true },
      }),
    );
    if (!chica) throw new BadRequestException(INVITATION_TOKEN_INVALID);
    // Su foto, para que quien cobra a su nombre vea que es ella (cobro por el encargado).
    const photos = await photoHashesOf(this.prisma, user.tenantId, [chica.id]);
    return { id: chica.id, name: staffName(chica), photoHash: photos.get(chica.id) ?? null };
  }

  @Get('invitables')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async invitables(@CurrentUser() user: JwtPayload): Promise<InvitableStaff[]> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: user.tenantId }, select: { invitationRules: true } }),
    );
    if (invitationRulesOf(venue.invitationRules).requireQr) throw new ForbiddenException(INVITATION_QR_REQUIRED);
    const chicas = await this.prisma.asSystem((tx) =>
      tx.user.findMany({
        where: { tenantId: user.tenantId, role: 'OPERATOR', deletedAt: null, id: { not: user.sub } },
        select: { id: true, displayName: true, email: true },
        orderBy: [{ displayName: 'asc' }, { email: 'asc' }],
        take: 200,
      }),
    );
    return chicas.map((c) => ({ id: c.id, name: staffName(c) }));
  }
}
