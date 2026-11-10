import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  StaffPasskeyOptionsSchema,
  StaffPasskeyRegisterSchema,
  type JwtPayload,
  type StaffPasskeyOptionsDto,
  type StaffPasskeyRegisterDto,
  type StaffPasskeyView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { StaffPasskeysService } from './staff-passkeys.service';
import { stepUpActorOf } from './step-up.controller';

/**
 * Las llaves de acceso de cada uno (su móvil), desde su app o el panel:
 *   GET    /v1/auth/passkeys           → las suyas (sin la clave).
 *   POST   /v1/auth/passkeys/options   { password, totpCode? } → el alta, paso 1 (pide la contraseña otra vez).
 *   POST   /v1/auth/passkeys           { response, name? } → el alta, paso 2.
 *   DELETE /v1/auth/passkeys/:id       → quitar una suya.
 * Errores: 403 contraseña o código malos, 429 demasiadas contraseñas, 409 a
 * destiempo o repetida.
 */
@Controller('auth/passkeys')
export class StaffPasskeysController {
  private readonly passkeys: StaffPasskeysService;

  constructor(@Inject(StaffPasskeysService) passkeys: StaffPasskeysService) {
    this.passkeys = passkeys;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@CurrentUser() user: JwtPayload | undefined): Promise<StaffPasskeyView[]> {
    return this.passkeys.list(stepUpActorOf(user).userId);
  }

  @Post('options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-passkey-setup' })
  options(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(StaffPasskeyOptionsSchema)) body: StaffPasskeyOptionsDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<unknown> {
    return this.passkeys.registrationOptions(stepUpActorOf(user), body.password, body.totpCode, origin);
  }

  @Post()
  @HttpCode(201)
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'auth-passkey-setup' })
  register(
    @CurrentUser() user: JwtPayload | undefined,
    @Body(new ZodValidationPipe(StaffPasskeyRegisterSchema)) body: StaffPasskeyRegisterDto,
    @Headers('origin') origin: string | undefined,
  ): Promise<StaffPasskeyView> {
    return this.passkeys.register(stepUpActorOf(user), body.response, body.name, origin);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: JwtPayload | undefined, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.passkeys.remove(stepUpActorOf(user), id);
  }
}

/** El dueño quita las llaves de alguien de su local (un móvil perdido): DELETE /v1/admin/operators/:id/passkeys. */
@Controller('admin/operators')
@UseGuards(RolesGuard)
export class StaffPasskeysAdminController {
  private readonly passkeys: StaffPasskeysService;

  constructor(@Inject(StaffPasskeysService) passkeys: StaffPasskeysService) {
    this.passkeys = passkeys;
  }

  @Delete(':id/passkeys')
  @Roles('OWNER')
  async removeAll(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) userId: string): Promise<{ removed: number }> {
    const owner = stepUpActorOf(user);
    return { removed: await this.passkeys.removeAllOf({ ...owner, tenantId: user.tenantId }, userId) };
  }
}
