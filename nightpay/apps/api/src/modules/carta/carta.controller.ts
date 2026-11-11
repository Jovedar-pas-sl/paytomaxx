import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CreateServiceItemSchema,
  ApplyCartaTemplateSchema,
  UpdateServiceItemSchema,
  UploadServiceImageSchema,
  type UploadServiceImageDto,
  type CreateServiceItemDto,
  type ApplyCartaTemplateDto,
  type ApplyCartaTemplateResult,
  type JwtPayload,
  type ServiceItem,
  type UpdateServiceItemDto,
} from '@nightpay/contracts';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CartaService } from './carta.service';

/**
 * Carta de servicios (Fase 1A).
 *  - GET /v1/services        → lo que puede cobrar quien llama (apps).
 *  - GET /v1/services/all    → carta completa para el panel.
 *  - POST/PATCH              → el dueño o el encargado la mantienen.
 *  - PUT/DELETE :id/image    → su logo o foto (WebP o PNG de 128 px como mucho).
 *  - GET :id/image/:hash     → la imagen, sin sesión (la pide un <img>), versionada
 *                              por su huella: el navegador la guarda un año.
 */
@Controller('services')
@UseGuards(AuthGuard)
export class CartaController {
  private readonly carta: CartaService;

  constructor(@Inject(CartaService) carta: CartaService) {
    this.carta = carta;
  }

  @Get()
  async list(@CurrentUser() user: JwtPayload): Promise<ServiceItem[]> {
    return this.carta.listForStaff(user.tenantId, user.role, user.sub);
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async listAll(@CurrentUser() user: JwtPayload): Promise<ServiceItem[]> {
    return this.carta.listAll(user.tenantId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreateServiceItemSchema)) dto: CreateServiceItemDto,
  ): Promise<ServiceItem> {
    return this.carta.create(user.tenantId, user.sub, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateServiceItemSchema)) dto: UpdateServiceItemDto,
  ): Promise<ServiceItem> {
    return this.carta.update(user.tenantId, user.sub, id, dto);
  }

  /** Sube el logo o la foto (el panel la manda ya reducida a WebP). Frenado por IP: la IP del local la comparte todo el personal. */
  @Put(':id/image')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'carta-image-upload' })
  async setImage(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UploadServiceImageSchema)) dto: UploadServiceImageDto,
  ): Promise<ServiceItem> {
    return this.carta.setImage(user.tenantId, user.sub, id, dto.data);
  }

  @Delete(':id/image')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'carta-image-remove' })
  async removeImage(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ServiceItem> {
    return this.carta.removeImage(user.tenantId, user.sub, id);
  }

  @Post('template')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER')
  async applyTemplate(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ApplyCartaTemplateSchema)) dto: ApplyCartaTemplateDto,
  ): Promise<ApplyCartaTemplateResult> {
    return this.carta.applyTemplate(user.tenantId, user.sub, dto);
  }
}

/** Cabeceras de la imagen de la carta: para siempre en el navegador (la huella cambia con la imagen). */
export const CARTA_IMAGE_HEADERS = Object.freeze({
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  // La pide una página de otro origen (la app del personal): helmet ya lo pone cross-origin; aquí, explícito.
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});

/**
 * GET /v1/services/:id/image/:hash — sin sesión: un <img> no manda el token.
 * Hacen falta el producto Y la huella de su imagen actual (si no, 404), y no
 * se adivinan. Con su propio freno por IP (el global no la cuenta).
 */
@Controller('services')
export class CartaImageController {
  private readonly carta: CartaService;

  constructor(@Inject(CartaService) carta: CartaService) {
    this.carta = carta;
  }

  @Get(':id/image/:hash')
  @Public()
  @IpRateLimit({ max: 1200, windowSec: 60, scope: 'carta-image', failOpen: true })
  async image(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('hash') hash: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new NotFoundException();
    const image = await this.carta.imageFor(id, hash);
    if (!image) throw new NotFoundException();
    reply.headers({ ...CARTA_IMAGE_HEADERS, 'Content-Type': image.contentType === 'image/png' ? 'image/png' : 'image/webp', ETag: `"${image.contentHash}"`, 'Content-Length': String(image.data.length) });
    return image.data;
  }
}
