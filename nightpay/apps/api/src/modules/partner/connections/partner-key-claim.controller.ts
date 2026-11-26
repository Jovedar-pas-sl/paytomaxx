import { Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';
import { IpRateLimit } from '../../../common/guards/ip-rate-limit.guard';
import { clientIp } from '../../../common/http/client-ip';
import { PartnerApiEnabledGuard } from '../partner-flag';
import { claimInvalidPage, claimKeyPage, claimLandingPage } from './partner-key-claim';
import { PartnerKeyClaimService } from './partner-key-claim.service';

const CLAIM_LIMIT = { max: 10, windowSec: 60, scope: 'partner-key-claim' };
/** 32 bytes en base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function html(res: FastifyReply, body: string): void {
  res
    .status(200)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex')
    .send(body);
}

/**
 * El enlace de un uso con la clave nueva (fuera de /v1, en UNPREFIXED_ROUTES:
 * así redact-url.ts tapa el token en los logs). 24 h; se ve una vez.
 */
@Controller('partner-key')
@UseGuards(PartnerApiEnabledGuard)
export class PartnerKeyClaimController {
  constructor(@Inject(PartnerKeyClaimService) private readonly claims: PartnerKeyClaimService) {}

  @Public()
  @Get(':token')
  @IpRateLimit(CLAIM_LIMIT)
  async landing(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    const peek = TOKEN_RE.test(token) ? await this.claims.peek(token) : null;
    html(res, peek?.valid ? claimLandingPage(peek.partner, peek.venue, token) : claimInvalidPage());
  }

  @Public()
  @Post(':token')
  @IpRateLimit(CLAIM_LIMIT)
  async open(@Param('token') token: string, @Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const opened = TOKEN_RE.test(token) ? await this.claims.open(token, clientIp(req)) : null;
    html(res, opened?.ok ? claimKeyPage(opened.key) : claimInvalidPage());
  }
}
