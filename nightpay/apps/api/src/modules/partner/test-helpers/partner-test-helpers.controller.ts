import { Body, Controller, Inject, Logger } from '@nestjs/common';
import {
  DEMO_FIXTURES,
  PARTNER_ROUTES,
  TestLiveCodeRequest,
  type TestLiveCodeBody,
  type TestLiveCodeRequestBody,
} from '@nightpay/contracts';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ZodValidationPipe } from '../../../common/pipes/zod.pipe';
import { WalletLiveCodeService } from '../../wallets/wallet-live-code.service';
import { liveWalletId } from '../../wallets/wallet-merge-chain';
import { CurrentConnection, type PartnerAuth } from '../auth/current-connection.decorator';
import { PartnerRateLimiter } from '../auth/partner-rate-limit';
import { PartnerRoute } from '../http/partner-route.decorator';
import { partnerError } from '../http/partner-problem';
import { DemoFixturesMissingError, DemoResetBusyError, resetDemoFixtures } from './partner-demo-fixtures';

const REDIS_DOWN_RETRY_S = 5;
/** Otro reinicio en marcha: tarda menos de un segundo; que lo intente en unos pocos. */
const RESET_BUSY_RETRY_S = 5;

/**
 * Las ayudas de la demo (decisión 17): `POST /test/live-codes` y
 * `POST /test/fixtures/reset`, con cualquier clave de prueba. Solo existen con
 * su módulo montado (PARTNER_API_MODE=test y
 * PARTNER_TEST_HELPERS=1) y el guard las niega fuera de la demo. Nunca escribe
 * en el log el código, el enlace ni el saldo.
 */
@Controller('partner')
export class PartnerTestHelpersController {
  private readonly logger = new Logger(PartnerTestHelpersController.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletLiveCodeService) private readonly liveCodes: WalletLiveCodeService,
    @Inject(PartnerRateLimiter) private readonly rates: PartnerRateLimiter,
  ) {}

  @PartnerRoute(PARTNER_ROUTES.createTestLiveCode)
  async liveCode(@Body(new ZodValidationPipe(TestLiveCodeRequest)) body: TestLiveCodeRequestBody): Promise<TestLiveCodeBody> {
    const token = DEMO_FIXTURES[body.fixture].token;
    const walletId = await this.prisma.asSystem(async (tx) => {
      const card = await tx.walletCard.findUnique({ where: { token }, select: { walletId: true } });
      return card?.walletId ? liveWalletId(tx, card.walletId) : null;
    });
    if (!walletId) throw this.missing();
    let code: string;
    try {
      ({ code } = await this.liveCodes.issue(walletId));
    } catch (err) {
      // Sin Redis (o el saldo sumado a otro, que la semilla nunca hace): no se da código.
      this.logger.warn(`Código de prueba sin dar (${(err as Error).name})`);
      throw partnerError('try_later', {}, REDIS_DOWN_RETRY_S);
    }
    return { object: 'test_live_code', code, expires_in: 60, livemode: false };
  }

  @PartnerRoute(PARTNER_ROUTES.resetTestFixtures)
  async reset(@CurrentConnection() auth: PartnerAuth, @Body() body: unknown): Promise<void> {
    // Sin cuerpo: uno cualquiera (también `{}`) es una petición mal hecha.
    if (body !== undefined && body !== null) throw partnerError('invalid_request');
    // Su propio tope (5 por conexión y minuto), antes de tocar la base.
    let rate: Awaited<ReturnType<PartnerRateLimiter['hitDemoReset']>>;
    try {
      rate = await this.rates.hitDemoReset(auth.connection.id);
    } catch (err) {
      this.logger.warn(`Reinicio de prueba sin hacer: Redis no responde (${(err as Error).name})`);
      throw partnerError('try_later', {}, REDIS_DOWN_RETRY_S);
    }
    if (!rate.ok) throw partnerError('rate_limited', {}, rate.retryAfter);
    let previous: string[];
    try {
      previous = await this.prisma.asSystem((tx) => resetDemoFixtures(tx));
    } catch (err) {
      if (err instanceof DemoFixturesMissingError) throw this.missing();
      // Otro reinicio tiene el candado: 429 al momento, sin esperar dentro de la transacción.
      if (err instanceof DemoResetBusyError) throw partnerError('rate_limited', {}, RESET_BUSY_RETRY_S);
      throw err;
    }
    // Tras el commit: los códigos del móvil de los saldos de antes mueren (si falla, viven sus 60 s).
    for (const walletId of previous) {
      await this.liveCodes.dropWallet(walletId).catch((err: unknown) => this.logger.warn(`Códigos de prueba sin anular (${(err as Error).name})`));
    }
  }

  private missing() {
    this.logger.error(new DemoFixturesMissingError().message);
    return partnerError('internal_error');
  }
}
