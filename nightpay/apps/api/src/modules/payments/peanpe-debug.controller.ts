import { BadRequestException, Controller, Get, Inject, Logger, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { DebugEndpointsGuard } from '../../common/guards/debug-endpoints.guard';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';
import { BRAND_NAME } from '../../common/brand';

// obs #4 (review): mismo charset que el adapter (excluye 0/O/1/l/I para
// distinguir IDs reales de dry — los reales nunca contienen estos chars,
// los dry empiezan con literal "DRY" así que la separación es clara igual.
const DRY_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface PeanpeDryRunResponse {
  format: 'cents' | 'euros';
  amountInputCents: number;
  cantidadSentToPeanpe: string;
  expectedChargeEUR: number;
  url: string;
  testCard: string;
  testDNI: string;
  instructions: string[];
}

interface PeanpeConfigCheckResponse {
  /** La apikey tiene el formato de Peanpe (64 hex); ni su longitud ni si está. */
  apiKeyOk: boolean;
  accountIdPresent: boolean;
  accountId: string | null;
  baseUrl: string | null;
  thankyouUrl: string | null;
  webhookUrlExpected: string;
  amountFormatVerified: 'cents' | 'euros' | null;
  safetyGuardActive: boolean;
  // obs #2: aviso explícito al consumidor mientras no esté verificado.
  warningIfUnverified: string | null;
}

/**
 * Endpoints debug-only para verificar/diagnosticar Peanpe sin tocar al
 * compañero ni al panel peanpe.com. Solo superadmin y con `DEBUG_ENDPOINTS_ENABLED=true`
 * en todos los entornos (DebugEndpointsGuard).
 *
 * Casos de uso:
 *  - `GET /v1/debug/peanpe/keycheck` → verifica que las env vars están bien
 *    formateadas (apikey hex 64 chars, accountId numérico, etc.) sin exponer
 *    los valores.
 *  - `GET /v1/debug/peanpe/dry-run?amount=100&format=cents` → genera URL
 *    Peanpe con tarjeta debug + concept fijo. NO crea Payment ni peanpeCall
 *    en BD. Sirve para que el usuario abra la URL en una pestaña y verifique
 *    en el panel Peanpe (o en su extracto de prueba) qué importe se cargó.
 *
 * H1 verification flow:
 *  1. Llama `/v1/debug/peanpe/dry-run?amount=100&format=cents` (= 1€ en céntimos)
 *  2. Abre la URL devuelta en navegador, paga con tarjeta `4548812049400004`
 *  3. Si el panel Peanpe registra "1.00 EUR" → formato es `cents` (default).
 *     Si registra "100.00 EUR" → formato es `euros`, repite test con
 *     `format=euros&amount=100` y verifica que registre "1.00 EUR".
 *  4. Set env `PEANPE_AMOUNT_FORMAT_VERIFIED=cents` (o `euros`) en Dokploy.
 *  5. Re-deploya. El safety guard se desactiva.
 */
@Controller('debug/peanpe')
@UseGuards(DebugEndpointsGuard)
export class PeanpeDebugController {
  // obs #9: audit log de cualquier hit en producción — los debug endpoints
  // están gated por DEBUG_ENDPOINTS_ENABLED pero si por error queda activo en
  // prod, los logs alertan al ver el patrón de uso.
  private readonly logger = new Logger(PeanpeDebugController.name);
  private readonly config: ConfigService;
  private readonly peanpe: PeanpeAdapter;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(PeanpeAdapter) peanpe: PeanpeAdapter,
  ) {
    this.config = config;
    this.peanpe = peanpe;
  }

  @Get('keycheck')
  keycheck(): PeanpeConfigCheckResponse {
    this.auditHit('keycheck');
    const apiKey = this.config.get<string>('PEANPE_API_KEY') ?? '';
    const accountId = this.config.get<string>('PEANPE_ACCOUNT_ID') ?? '';
    const baseUrl = this.config.get<string>('PEANPE_API_BASE_URL') ?? null;
    const thankyouUrl = this.config.get<string>('PEANPE_THANKYOU_URL') ?? null;
    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'https://api.example.com';
    const formatRaw = this.config.get<string>('PEANPE_AMOUNT_FORMAT_VERIFIED') ?? '';
    const format =
      formatRaw === 'cents' || formatRaw === 'euros' ? formatRaw : null;
    return {
      apiKeyOk: /^[0-9a-fA-F]{64}$/.test(apiKey),
      accountIdPresent: accountId.length > 0,
      accountId: accountId.length > 0 ? accountId : null,
      baseUrl,
      thankyouUrl,
      webhookUrlExpected: `${apiBase.replace(/\/+$/, '')}/v1/webhooks/peanpe/notify`,
      amountFormatVerified: format,
      safetyGuardActive: format === null,
      warningIfUnverified:
        format === null
          ? 'PEANPE_AMOUNT_FORMAT_VERIFIED no set — cobros <€500 se procesan asumiendo formato "cents". ' +
            'Si Peanpe interpreta "cantidad" como euros enteros, el cliente paga ×100. ' +
            'Verifica con /v1/debug/peanpe/dry-run antes de procesar volumen.'
          : null,
    };
  }

  @Get('dry-run')
  dryRun(
    @Query('amount') amountRaw?: string,
    @Query('format') formatRaw?: string,
  ): PeanpeDryRunResponse {
    // obs #1: clamp 1c..99999c (max ~999€). El safety guard del adapter sigue
    // bloqueando ≥500€ en producción real, pero el dry-run permite ir por
    // encima sin riesgo (no crea Payment ni peanpeCall en BD).
    const amountInputCents = Math.max(1, Math.min(99_999, Number(amountRaw ?? '100') | 0));
    const format: 'cents' | 'euros' = formatRaw === 'euros' ? 'euros' : 'cents';
    // En euros Peanpe solo admite euros enteros (el adapter lanza con céntimos).
    if (format === 'euros' && amountInputCents % 100 !== 0) {
      throw new BadRequestException('Con format=euros el importe (amount, en céntimos) tiene que ser de euros enteros: p. ej. 100, 500.');
    }
    this.auditHit(`dry-run amount=${amountInputCents}c format=${format}`);

    // Generamos un id_llamada SIN persistir en BD (dry-run = no side effects).
    // El identificador empieza con "DRY" para que verifyWebhook lo distinga
    // claramente si Peanpe responde a esta URL: rechazaríamos el callback
    // porque no hay row en peanpe_calls, evitando confusión con cobros reales.
    // obs #4 (review): randomBytes en vez de Math.random — consistencia con
    // el resto del adapter (todo el código crypto-grade usa node:crypto).
    const dryIdBytes = randomBytes(3);
    let dryId = 'DRY';
    for (let i = 0; i < 3; i++) {
      dryId += DRY_CHARSET[dryIdBytes[i]! % DRY_CHARSET.length];
    }

    // obs #5: reusamos buildPaymentUrl del adapter con formatOverride para
    // que cualquier futuro cambio a la firma HMAC se aplique automáticamente
    // aquí. Antes era código duplicado que podía divergir.
    const url = this.peanpe.buildPaymentUrl({
      identificadorLlamada: dryId,
      amountCents: amountInputCents,
      concepto: `${BRAND_NAME} DRY-RUN ${format}`,
      debug: true,
      formatOverride: format,
    });
    const cantidadSent =
      format === 'euros'
        ? String(Math.round(amountInputCents / 100))
        : String(amountInputCents);

    return {
      format,
      amountInputCents,
      cantidadSentToPeanpe: cantidadSent,
      expectedChargeEUR: format === 'cents' ? amountInputCents / 100 : amountInputCents,
      url,
      testCard: '4548812049400004 (cualquier expiración y CVV)',
      testDNI: '123456',
      instructions: [
        '1. Abre la URL devuelta en una pestaña incógnito.',
        '2. Paga con la tarjeta de prueba indicada arriba.',
        '3. En el panel peanpe.com → Estadísticas, busca la transacción por id_llamada.',
        `4. Si el importe registrado es ${(amountInputCents / 100).toFixed(2)}€, el formato CORRECTO es "${format}".`,
        '5. Si el importe registrado es distinto, repite con el otro formato.',
        '6. Una vez confirmado: set env PEANPE_AMOUNT_FORMAT_VERIFIED=cents (o euros) en Dokploy + re-deploy.',
        'NOTA 1: este dry-run NO crea Payment ni peanpeCall en BD. Si Peanpe envía callback, será rechazado (id_llamada no existe).',
        'NOTA 2: amount está clamped a 99_999c (~999€) — el safety guard real bloquea ≥50_000c en cobros productivos.',
      ],
    };
  }

  private auditHit(operation: string): void {
    const isProd = this.config.get<string>('NODE_ENV') === 'production';
    if (!isProd) return;
    this.logger.warn(
      `[AUDIT] Peanpe debug endpoint hit in PRODUCTION: ${operation}. ` +
        `Si no esperas tráfico de debug, revisa DEBUG_ENDPOINTS_ENABLED en Dokploy.`,
    );
  }
}
