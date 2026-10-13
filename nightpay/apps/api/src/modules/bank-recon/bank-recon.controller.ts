import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { BankReconService, type StatementItemView, type StatementSummary } from './bank-recon.service';

/** El cuerpo de la petición tiene un tope de 1 MB: el fichero va en base64 (≈ 700 KB). */
const MAX_FILE_BASE64 = 950_000;
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Día como AAAA-MM-DD');

const ImportSchema = z
  .object({
    source: z.enum(['REDSYS', 'PAYTEF']),
    fileName: z.string().trim().min(1).max(200),
    contentBase64: z
      .string()
      .min(1)
      .max(MAX_FILE_BASE64, 'El fichero es muy grande: descárgalo por semanas')
      .regex(/^[A-Za-z0-9+/=\r\n]+$/, 'Fichero no válido'),
    periodFrom: DAY.optional(),
    periodTo: DAY.optional(),
  })
  .refine((b) => Boolean(b.periodFrom) === Boolean(b.periodTo), {
    message: 'Indica el primer y el último día, o ninguno',
  });

/**
 * Cuadre con el banco (solo el dueño).
 *  - POST /v1/bank-recon/import → sube el fichero del portal (Redsys o Paytef) y lo cuadra.
 *  - GET  /v1/bank-recon        → los últimos cuadres del grupo.
 *  - GET  /v1/bank-recon/:id    → líneas de un cuadre (lo que no cuadra, primero).
 */
@Controller('bank-recon')
@UseGuards(RolesGuard)
export class BankReconController {
  private readonly recon: BankReconService;

  constructor(@Inject(BankReconService) recon: BankReconService) {
    this.recon = recon;
  }

  @Post('import')
  @HttpCode(201)
  @Roles('OWNER')
  async import(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ImportSchema)) body: z.infer<typeof ImportSchema>,
  ): Promise<StatementSummary> {
    return this.recon.importStatement(
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
      {
        source: body.source,
        fileName: body.fileName,
        content: Buffer.from(body.contentBase64, 'base64'),
        periodFrom: body.periodFrom,
        periodTo: body.periodTo,
      },
    );
  }

  @Get()
  @Roles('OWNER')
  async list(@CurrentUser() user: JwtPayload): Promise<StatementSummary[]> {
    return this.recon.list({ userId: user.sub, role: user.role, tenantId: user.tenantId });
  }

  @Get(':id')
  @Roles('OWNER')
  async detail(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ statement: StatementSummary; items: StatementItemView[] }> {
    return this.recon.detail({ userId: user.sub, role: user.role, tenantId: user.tenantId }, id);
  }
}
