import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletChargesService } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { mayReadWallet } from './wallet-view-access';

/** Las rutas de compatibilidad y los pases no evitan el desbloqueo de la página del saldo. */
@Injectable()
export class WalletViewGuard implements CanActivate {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ params: { token?: string; qrToken?: string }; headers: { cookie?: string } }>();
    const token = req.params.token ?? req.params.qrToken;
    if (!token || !(await mayReadWallet({
      walletRefByToken: (value) => this.charges.walletRefByToken(value),
      hasPasskey: (id) => this.passkeys.hasPasskey(id),
      secret: this.config.get<string>('COOKIE_SECRET') ?? '',
    }, token, req.headers.cookie))) {
      throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    }
    return true;
  }
}
