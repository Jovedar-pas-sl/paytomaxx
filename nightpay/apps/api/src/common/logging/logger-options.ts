import { clientIp, type ClientIpRequest } from '../http/client-ip';
import { redactSecretsInUrl } from './redact-url';

type LogRequest = ClientIpRequest & { method: string; url: string; hostname?: string };

/**
 * Rutas que pino tapa siempre (defensa en profundidad: el serializador de
 * `req` ya no saca cabeceras, pero cualquier objeto que se loguee con estos
 * campos sale tapado).
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-origin-auth"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.pin',
  '*.pin2',
  '*.secret',
  '*.tokenizationData',
  '*.Ds_MerchantParameters',
  '*.Ds_Signature',
  // BTCPay: la clave de API y el secreto del aviso de cada local, y la firma del aviso.
  '*.apiKey',
  '*.apiKeyEnc',
  '*.webhookSecret',
  '*.webhookSecretEnc',
  'req.headers["btcpay-sig"]',
  // API de socios: lo que identifica un saldo (QR, chip), el texto del socio y la clave sellada del enlace.
  '*.qr',
  '*.nfc_uid',
  '*.description',
  // El motivo de una anulación (API de socios): solo en sus columnas y el panel.
  '*.reason',
  '*.keyClaimSealed',
];

/** Opciones del logger de Fastify (main.ts). */
export function httpLoggerOptions(level: string) {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      // Tokens de la URL (saldo, QR, avisos de Paytef…) tapados; IP de fiar.
      req: (req: LogRequest) => ({
        method: req.method,
        url: redactSecretsInUrl(req.url),
        hostname: req.hostname,
        remoteAddress: clientIp(req) ?? undefined,
      }),
    },
  };
}
