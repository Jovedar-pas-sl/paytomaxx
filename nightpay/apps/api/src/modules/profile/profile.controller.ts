import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ChangePasswordSchema,
  UpdateEmailSchema,
  UpdatePhoneSchema,
  UpdateProfileSchema,
  UploadProfilePhotoSchema,
  type ChangePasswordDto,
  type JwtPayload,
  type MyProfile,
  type UpdateEmailDto,
  type UpdatePhoneDto,
  type UpdateProfileDto,
  type UploadProfilePhotoDto,
} from '@nightpay/contracts';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { UserRateLimit, UserRateLimitGuard } from '../../common/guards/user-rate-limit.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ProfileService, type ProfileActor } from './profile.service';

const actorOf = (user: JwtPayload): ProfileActor => ({
  userId: user.sub,
  tenantId: user.tenantId,
  role: user.role,
  ...(user.sid ? { sid: user.sid } : {}),
});

/** Cabeceras de la foto: con sesión (privada), un año en el móvil (la huella cambia con la foto). */
export const STAFF_PHOTO_HEADERS = Object.freeze({
  'Cache-Control': 'private, max-age=31536000, immutable',
  Vary: 'Authorization',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});

/**
 * «Mi perfil» del personal. Cada ruta de `me/...` actúa sobre quien lleva el
 * token (nunca sobre otra persona); las de `staff/:userId/photo` sirven la foto
 * al personal del mismo local y dejan al dueño o al encargado quitarla.
 *  - GET    /v1/me/profile · PATCH /v1/me/profile (nombre) · PATCH /v1/me/contact (teléfono)
 *  - PATCH  /v1/me/email · POST /v1/me/password (piden la contraseña actual)
 *  - PUT/DELETE /v1/me/photo
 *  - GET    /v1/staff/:userId/photo/:hash
 *  - DELETE /v1/staff/:userId/photo (dueño o encargado)
 * Todo con tope por persona (la IP del local la comparte todo el personal).
 */
@Controller()
@UseGuards(AuthGuard)
export class ProfileController {
  private readonly profile: ProfileService;

  constructor(@Inject(ProfileService) profile: ProfileService) {
    this.profile = profile;
  }

  @Get('me/profile')
  getMine(@CurrentUser() user: JwtPayload): Promise<MyProfile> {
    return this.profile.getMine(actorOf(user));
  }

  @Patch('me/profile')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'me-profile-name' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 20, windowSec: 60, scope: 'me-profile-name' })
  updateName(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto): Promise<MyProfile> {
    return this.profile.updateName(actorOf(user), dto);
  }

  @Patch('me/contact')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'me-profile-phone' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 20, windowSec: 60, scope: 'me-profile-phone' })
  updatePhone(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(UpdatePhoneSchema)) dto: UpdatePhoneDto): Promise<MyProfile> {
    return this.profile.updatePhone(actorOf(user), dto);
  }

  /** Piden la contraseña actual: tope bajo por persona (un móvil robado no la adivina). */
  @Patch('me/email')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'me-profile-email' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 5, windowSec: 600, scope: 'me-profile-secret' })
  updateEmail(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(UpdateEmailSchema)) dto: UpdateEmailDto): Promise<MyProfile> {
    return this.profile.updateEmail(actorOf(user), dto);
  }

  @Post('me/password')
  @HttpCode(200)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'me-profile-password' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 5, windowSec: 600, scope: 'me-profile-secret' })
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<{ changed: true; otherSessionsClosed: number }> {
    return this.profile.changePassword(actorOf(user), dto);
  }

  /** Sube la foto (el móvil la manda ya recortada y reducida). Frenado por IP y por persona. */
  @Put('me/photo')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'me-photo-upload' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 10, windowSec: 60, scope: 'me-photo-upload' })
  setPhoto(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(UploadProfilePhotoSchema)) dto: UploadProfilePhotoDto): Promise<MyProfile> {
    return this.profile.setPhoto(actorOf(user), dto.data);
  }

  @Delete('me/photo')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'me-photo-remove' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 10, windowSec: 60, scope: 'me-photo-remove' })
  removeOwnPhoto(@CurrentUser() user: JwtPayload): Promise<MyProfile> {
    return this.profile.removeOwnPhoto(actorOf(user));
  }

  @Get('staff/:userId/photo/:hash')
  @IpRateLimit({ max: 1200, windowSec: 60, scope: 'staff-photo', failOpen: true })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 600, windowSec: 60, scope: 'staff-photo' })
  async photo(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('hash') hash: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new NotFoundException();
    const image = await this.profile.photoFor(user.tenantId, userId, hash);
    if (!image) throw new NotFoundException();
    reply.headers({
      ...STAFF_PHOTO_HEADERS,
      'Content-Type': image.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/webp',
      ETag: `"${image.contentHash}"`,
      'Content-Length': String(image.data.length),
    });
    return image.data;
  }

  /** El dueño o el encargado quitan la foto de alguien de su local; queda en el registro. */
  @Delete('staff/:userId/photo')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'staff-photo-remove' })
  removeStaffPhoto(@CurrentUser() user: JwtPayload, @Param('userId', ParseUUIDPipe) userId: string): Promise<{ removed: boolean }> {
    return this.profile.removePhotoOf(actorOf(user), userId);
  }
}
