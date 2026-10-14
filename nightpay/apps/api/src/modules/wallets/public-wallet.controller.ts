import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import * as QRCode from 'qrcode';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { resolveLanguage } from '../payments/pay-i18n';
import { deviceCookieHeader, readDeviceToken } from './client-device';
import { ClientDevicesService } from './client-devices.service';
import { WalletChargesService, type ClientWalletState } from './wallet-charges.service';
import { renderNoWalletPage, renderWalletPage } from './wallet-page';
import { operatorBaseUrl, walletCodeQrContent } from './wallet-rules';

/** Lo que manda la página al aceptar o al pedir la devolución. */
interface DecisionBody {
  /** Respuesta de Face ID / huella (si el saldo está protegido). */
  passkey?: unknown;
}

/**
 * Saldo NightPay — páginas del cliente (fuera de /v1). Sin cuenta: el enlace
 * con su token es la credencial (como el QR del cobro), y el móvil que lo
 * abre primero se lo queda (cookie __Host-np_dev, ver client-device.ts).
 *  - GET  /w                                  → el saldo de este móvil (sin enlace).
 *  - GET  /w/:token                           → página del saldo.
 *  - GET  /w/:token/state                     → estado (la página lo refresca).
 *  - POST /w/:token/claim                     → la página pide el saldo para este móvil.
 *  - POST /w/:token/requests/:id/accept|reject → aceptar o rechazar un cobro.
 *  - POST /w/:token/close                     → "Me voy: devolver mi saldo".
 *  - POST /w/:token/passkey/options | /passkey → activar Face ID / huella.
 *  - POST /w/:token/passkey/challenge         → reto antes de aceptar o irse.
 *
 * Límites por IP holgados: en un local muchos clientes comparten el wifi y la
 * página consulta su estado cada pocos segundos. El token (144 bits) no se
 * puede adivinar; el límite es contra abusos, no contra fuerza bruta.
 */
@Controller('w')
export class PublicWalletController {
  private readonly charges: WalletChargesService;
  private readonly devices: ClientDevicesService;

  constructor(
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(ClientDevicesService) devices: ClientDevicesService,
  ) {
    this.charges = charges;
    this.devices = devices;
  }

  /** "Mi saldo" sin el enlace: si este móvil tiene uno, a él. */
  @Public()
  @Get()
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-mine' })
  async mine(
    @Headers('cookie') cookie: string | undefined,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const lang = resolveLanguage(langQuery, acceptLanguage);
    const device = await this.devices.find(readDeviceToken(cookie));
    const token = device ? await this.devices.latestWalletToken(device.id) : null;
    if (token) {
      res
        .status(303)
        .header('Location', `/w/${encodeURIComponent(token)}?lang=${lang}`)
        .header('Cache-Control', 'no-store')
        .send();
      return;
    }
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(renderNoWalletPage(lang));
  }

  @Public()
  @Get(':token')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-page' })
  async page(
    @Param('token') token: string,
    @Query('lang') langQuery: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    // Abrir el enlace no cambia nada (lo abren también las vistas previas de
    // WhatsApp…): el saldo lo pide la página con POST /claim al cargar.
    const state = await this.withDevice(token, cookie, await this.charges.clientState(token));
    // El QR lleva solo el código (la chica lo escanea), no el enlace del saldo.
    const codeQrSvg =
      state.status === 'ACTIVE'
        ? await QRCode.toString(
            walletCodeQrContent(
              state.code,
              operatorBaseUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NEXT_PUBLIC_OPERATOR_URL),
            ),
            { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0b0b0b', light: '#ffffff' } },
          )
        : null;
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(renderWalletPage(token, resolveLanguage(langQuery, acceptLanguage), state, { codeQrSvg }));
  }

  @Public()
  @Get(':token/state')
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 1500, windowSec: 60, scope: 'wallet-state' })
  async state(@Param('token') token: string, @Headers('cookie') cookie: string | undefined): Promise<ClientWalletState> {
    return this.withDevice(token, cookie, await this.charges.clientState(token));
  }

  /** La página ya cargada en el móvil: si el saldo aún no es de nadie, es de este móvil. */
  @Public()
  @Post(':token/claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-claim' })
  async claim(
    @Param('token') token: string,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<ClientWalletState> {
    const charges = await this.charges.clientState(token);
    const { wallet, viewerId, newToken } = await this.devices.claimForViewer(
      await this.devices.walletByToken(token),
      readDeviceToken(cookie),
    );
    if (newToken) res.header('Set-Cookie', deviceCookieHeader(newToken));
    return { ...charges, device: await this.devices.stateFor(wallet, viewerId) };
  }

  @Public()
  @Post(':token/requests/:id/accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-decide' })
  async accept(
    @Param('token') token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionBody | undefined,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<ClientWalletState> {
    // Saldo protegido: sin la cara o la huella de su móvil no se gasta.
    await this.devices.assertPresence(await this.devices.walletByToken(token), host, body?.passkey);
    return this.withDevice(token, cookie, await this.charges.accept(token, id));
  }

  @Public()
  @Post(':token/requests/:id/reject')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-decide' })
  async reject(
    @Param('token') token: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecisionBody | undefined,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<ClientWalletState> {
    // Protegido: solo el dueño decide (también para decir que no).
    await this.devices.assertPresence(await this.devices.walletByToken(token), host, body?.passkey);
    return this.withDevice(token, cookie, await this.charges.reject(token, id));
  }

  @Public()
  @Post(':token/close')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-close' })
  async close(
    @Param('token') token: string,
    @Body() body: DecisionBody | undefined,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<ClientWalletState> {
    await this.devices.assertPresence(await this.devices.walletByToken(token), host, body?.passkey);
    return this.withDevice(token, cookie, await this.charges.requestClose(token));
  }

  /** Activar Face ID / huella, paso 1: opciones para el navegador. */
  @Public()
  @Post(':token/passkey/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyOptions(
    @Param('token') token: string,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<unknown> {
    const viewer = await this.devices.find(readDeviceToken(cookie));
    return this.devices.registrationOptions(await this.devices.walletByToken(token), viewer?.id ?? null, host);
  }

  /** Activar Face ID / huella, paso 2: la respuesta del móvil. */
  @Public()
  @Post(':token/passkey')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyRegister(
    @Param('token') token: string,
    @Body() body: { response?: unknown } | undefined,
    @Headers('host') host: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<ClientWalletState> {
    const viewer = await this.devices.find(readDeviceToken(cookie));
    await this.devices.register(await this.devices.walletByToken(token), viewer?.id ?? null, host, body?.response);
    return this.withDevice(token, cookie, await this.charges.clientState(token));
  }

  /** Reto para la cara o el dedo antes de aceptar un cobro o irse. */
  @Public()
  @Post(':token/passkey/challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'wallet-passkey' })
  async passkeyChallenge(@Param('token') token: string, @Headers('host') host: string | undefined): Promise<unknown> {
    return this.devices.challenge(await this.devices.walletByToken(token), host);
  }

  private async withDevice(token: string, cookie: string | undefined, state: ClientWalletState): Promise<ClientWalletState> {
    const viewer = await this.devices.find(readDeviceToken(cookie));
    const wallet = await this.devices.walletByToken(token);
    return { ...state, device: await this.devices.stateFor(wallet, viewer?.id ?? null) };
  }
}
