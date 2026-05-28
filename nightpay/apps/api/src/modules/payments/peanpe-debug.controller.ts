import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { DebugEndpointsGuard } from '../../common/guards/debug-endpoints.guard';

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
  apiKeyPresent: boolean;
  apiKeyLength: number;
  apiKeyLooksHex: boolean;
  accountIdPresent: boolean;
  accountId: string | null;
  baseUrl: string | null;
  thankyouUrl: string | null;
  webhookUrlExpected: string;
  amountFormatVerified: 'cents' | 'euros' | null;
  safetyGuardActive: boolean;
}

/**
 * Endpoints debug-only para verificar/diagnosticar Peanpe sin tocar al
 * compañero ni al panel peanpe.com. Gated por `DEBUG_ENDPOINTS_ENABLED=true`
 * en producción (en dev siempre activos).
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
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  @Public()
  @Get('keycheck')
  keycheck(): PeanpeConfigCheckResponse {
    const apiKey = this.config.get<string>('PEANPE_API_KEY') ?? '';
    const accountId = this.config.get<string>('PEANPE_ACCOUNT_ID') ?? '';
    const baseUrl = this.config.get<string>('PEANPE_API_BASE_URL') ?? null;
    const thankyouUrl = this.config.get<string>('PEANPE_THANKYOU_URL') ?? null;
    const apiBase = this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'https://api.example.com';
    const formatRaw = this.config.get<string>('PEANPE_AMOUNT_FORMAT_VERIFIED') ?? '';
    const format =
      formatRaw === 'cents' || formatRaw === 'euros' ? formatRaw : null;
    return {
      apiKeyPresent: apiKey.length > 0,
      apiKeyLength: apiKey.length,
      apiKeyLooksHex: /^[0-9a-fA-F]+$/.test(apiKey) && apiKey.length === 64,
      accountIdPresent: accountId.length > 0,
      accountId: accountId.length > 0 ? accountId : null,
      baseUrl,
      thankyouUrl,
      webhookUrlExpected: `${apiBase.replace(/\/+$/, '')}/v1/webhooks/peanpe/notify`,
      amountFormatVerified: format,
      safetyGuardActive: format === null,
    };
  }

  @Public()
  @Get('dry-run')
  dryRun(
    @Query('amount') amountRaw?: string,
    @Query('format') formatRaw?: string,
  ): PeanpeDryRunResponse {
    const amountInputCents = Math.max(1, Math.min(50_000, Number(amountRaw ?? '100') | 0));
    const format: 'cents' | 'euros' = formatRaw === 'euros' ? 'euros' : 'cents';

    // Generamos un id_llamada SIN persistir en BD (dry-run = no side effects).
    // El identificador empieza con "DRY" para que verifyWebhook lo distinga
    // claramente si Peanpe responde a esta URL: rechazaríamos el callback
    // porque no hay row en peanpe_calls, evitando confusión con cobros reales.
    const dryId = 'DRY' + Math.random().toString(36).slice(2, 5).toUpperCase();

    const cantidadSent =
      format === 'euros'
        ? String(Math.round(amountInputCents / 100))
        : String(amountInputCents);

    // Construimos URL con la misma lógica que el adapter pero forzando el
    // formato pedido por query, sin tocar el env (que el guard lee en runtime).
    const apiKey = this.config.get<string>('PEANPE_API_KEY');
    const accountId = this.config.get<string>('PEANPE_ACCOUNT_ID');
    if (!apiKey || !accountId) {
      throw new Error('PEANPE_API_KEY o PEANPE_ACCOUNT_ID no configurado');
    }
    const base = this.config.get<string>('PEANPE_API_BASE_URL') ?? 'http://peanpe.com';

    const concat = `${dryId}${accountId}${cantidadSent}`;
    const apiKeyBytes = Buffer.from(apiKey, 'hex');
    const firma = createHmac('sha256', apiKeyBytes).update(concat).digest('hex');
    const params = new URLSearchParams({
      accion: 'pagar',
      identificador_cuenta_peanpe: accountId,
      identificador_llamada: dryId,
      cantidad: cantidadSent,
      concepto: `NightPay DRY-RUN ${format}`,
      firma,
      debug: '1',
    });
    const url = `${base.replace(/\/$/, '')}/api?${params.toString()}`;

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
        'NOTA: este dry-run NO crea Payment ni peanpeCall en BD. Si Peanpe envía callback, será rechazado (id_llamada no existe).',
      ],
    };
  }
}
