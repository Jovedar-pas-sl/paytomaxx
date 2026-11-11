import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ContactPhoneSchema, type ContactPhoneDto, type JwtPayload, type WalletByPhone } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletContactService } from './wallet-contact.service';

/**
 * El teléfono opcional al dar una ficha nueva:
 *  - POST /v1/reception/wallets/:id/phone → lo deja quien le acaba de dar la
 *    ficha (o el encargado o el dueño);
 *  - POST /v1/reception/wallets/by-phone {phone} → el encargado o el dueño
 *    encuentran el saldo de quien lo ha perdido todo. En el cuerpo, no en la
 *    URL: así el teléfono no acaba en los logs.
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionContactController {
  constructor(@Inject(WalletContactService) private readonly contacts: WalletContactService) {}

  @Post('wallets/:id/phone')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-wallet-phone' })
  async setPhone(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ContactPhoneSchema)) body: ContactPhoneDto,
  ): Promise<{ ok: true }> {
    return this.contacts.setPhone({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id, body.phone);
  }

  @Post('wallets/by-phone')
  @HttpCode(200)
  @Roles('MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-wallet-phone-search' })
  async byPhone(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(ContactPhoneSchema)) body: ContactPhoneDto): Promise<WalletByPhone[]> {
    return this.contacts.findByPhone({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body.phone);
  }
}