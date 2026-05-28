import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';

interface KeyCheckResponse {
  merchantCodePresent: boolean;
  merchantCodeLength: number;
  terminalPresent: boolean;
  terminal: string | null;
  secretKeyPresent: boolean;
  secretKeyLength: number;
  secretKeyLooksBase64: boolean;
  secretKeyExpectedLength: number;
  secretKeyMatchesExpected: boolean;
  apiUrl: string | null;
  hint: string;
}

/**
 * TEMP DIAG. Reports presence + length of Redsys env vars so user can verify
 * from browser whether the secret key has the expected 32 chars (base64 of
 * 24-byte 3DES key). SIS0042 ("Firma incorrecta") is most commonly caused
 * by a truncated key copied from BBVA onboarding email.
 *
 * Does NOT leak the key value. Returns only length + first char mask.
 */
@Controller('debug/redsys')
export class RedsysDebugController {
  private readonly logger = new Logger(RedsysDebugController.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  @Public()
  @Get('keycheck')
  keycheck(): KeyCheckResponse {
    const merchantCode = this.config.get<string>('REDSYS_MERCHANT_CODE') ?? '';
    const terminal = this.config.get<string>('REDSYS_TERMINAL') ?? '';
    const secretKey = this.config.get<string>('REDSYS_SECRET_KEY') ?? '';
    const apiUrl = this.config.get<string>('REDSYS_API_URL') ?? null;

    const looksBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(secretKey);
    const expectedLen = 32;

    let hint = '';
    if (!secretKey) {
      hint = 'REDSYS_SECRET_KEY no está configurado en Dokploy.';
    } else if (secretKey.length !== expectedLen) {
      hint = `Clave tiene ${secretKey.length} chars; estándar Redsys es ${expectedLen} (base64 de 24 bytes). Probable causa del SIS0042. Reenvía la clave del email BBVA/Peanpe y verifica que copiaste todo el string.`;
    } else if (!looksBase64) {
      hint = 'Clave tiene 32 chars pero contiene caracteres fuera del set base64 — verifica si tiene espacios al inicio/fin.';
    } else {
      hint = 'Clave tiene longitud y charset correctos. SIS0042 puede venir de: merchantCode/terminal incorrectos, parámetros mal formados, o el TPV está apagado en panel BBVA.';
    }

    return {
      merchantCodePresent: merchantCode.length > 0,
      merchantCodeLength: merchantCode.length,
      terminalPresent: terminal.length > 0,
      terminal: terminal || null,
      secretKeyPresent: secretKey.length > 0,
      secretKeyLength: secretKey.length,
      secretKeyLooksBase64: looksBase64,
      secretKeyExpectedLength: expectedLen,
      secretKeyMatchesExpected: secretKey.length === expectedLen && looksBase64,
      apiUrl,
      hint,
    };
  }
}
