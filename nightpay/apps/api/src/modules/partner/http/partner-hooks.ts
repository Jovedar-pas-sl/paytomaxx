import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PARTNER_KEY_IN_TEXT_RE } from '@nightpay/contracts';
import { clientIp } from '../../../common/http/client-ip';
import { decodeAsciiEscapes } from '../../../common/logging/redact-url';
import { isPartnerPath } from '../../../common/http/partner-path';
import { partnerApiOn } from '../partner-flag';
import { partnerError } from './partner-problem';
import { PartnerKeyExposureService } from './partner-key-exposure.service';

/** El cuerpo más grande de la API de socios (16 KB). El global sigue en 1 MB. */
export const PARTNER_BODY_LIMIT = 16_384;

const logger = new Logger('PartnerHooks');

/**
 * Antes de registrar las rutas (main.ts, tras NestFactory.create): las de
 * /v1/partner llevan su `bodyLimit` (también con un cuerpo troceado, sin
 * content-length) → 413 body_too_large.
 */
export function installPartnerBodyLimit(app: NestFastifyApplication): void {
  app.getHttpAdapter().getInstance().addHook('onRoute', (route) => {
    if (isPartnerPath(route.url)) route.bodyLimit = PARTNER_BODY_LIMIT;
  });
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Una clave en la URL, tal cual o codificada (por trozos: un % roto no la
 * esconde; y en cada trozo, también con solo los escapes ASCII válidos
 * decodificados, por si el roto está en el mismo trozo que la clave).
 */
export function partnerKeyInUrl(url: string): string | null {
  for (const piece of [url, ...url.split(/[/?&=#;]/)]) {
    for (const text of [piece, safeDecode(piece) ?? '', decodeAsciiEscapes(piece)]) {
      const found = PARTNER_KEY_IN_TEXT_RE.exec(text);
      if (found) return found[0];
    }
  }
  return null;
}

/**
 * Con la API encendida, una clave en la ruta o en la query de /v1/partner/…
 * (también en rutas que no existen) es un 400 api_key_in_url antes de nada.
 * Si la clave existe, el dueño recibe el aviso (sin retrasar la respuesta).
 */
export function installPartnerUrlCheck(app: NestFastifyApplication): void {
  app.getHttpAdapter().getInstance().addHook('onRequest', async (req) => {
    if (!partnerApiOn() || !isPartnerPath(req.url)) return;
    const key = partnerKeyInUrl(req.url);
    if (!key) return;
    void app
      .get(PartnerKeyExposureService)
      .report(key, clientIp(req))
      .catch((err: unknown) => logger.warn(`Clave en una URL sin apuntar: ${(err as Error).message}`));
    throw partnerError('api_key_in_url');
  });
}

/** Una petición de socios con el momento en que llegó (onRequest). */
export type PartnerTimedRequest = { headers: Record<string, string | string[] | undefined>; partnerReceivedAt?: number };

/**
 * El sello de llegada de cada petición de /v1/partner (onRequest, antes de
 * leer el cuerpo): una carga se guarda en los 25 s siguientes o nunca.
 */
export function installPartnerReceivedAt(app: NestFastifyApplication): void {
  app.getHttpAdapter().getInstance().addHook('onRequest', async (req) => {
    if (isPartnerPath(req.url)) (req as unknown as PartnerTimedRequest).partnerReceivedAt = Date.now();
  });
}

/** Cuándo llegó (sin el gancho, ahora: nunca más tarde de lo que de verdad llegó). */
export function partnerReceivedAt(req: PartnerTimedRequest): number {
  return typeof req.partnerReceivedAt === 'number' ? req.partnerReceivedAt : Date.now();
}
