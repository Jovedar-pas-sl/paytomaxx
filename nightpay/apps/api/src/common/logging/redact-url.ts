/**
 * Credenciales que viajan en la URL y no deben acabar en logs ni en Sentry:
 *  - /w/<token>                         enlace del saldo del cliente
 *  - /pay/<token>                       QR del cobro
 *  - /v1/webhooks/paytef/<secreto>      URL secreta de los avisos de Paytef
 *  - /v1/operators/self-onboarding/<t>  enlace de alta de una chica (72 h)
 *  - /v1/payments/public/<token>, /v1/wallets/public/<token>
 */
const PATTERNS: ReadonlyArray<RegExp> = [
  /^(\/w\/)[^/?#]+/,
  /^(\/pay\/)(?!result(?:[/?#]|$))[^/?#]+/,
  /^(\/v1\/webhooks\/paytef\/)[^/?#]+/,
  /^(\/v1\/operators\/self-onboarding\/)[^/?#]+/,
  /^(\/v1\/payments\/public\/)[^/?#]+/,
  /^(\/v1\/wallets\/public\/)[^/?#]+/,
];

export function redactSecretsInUrl(url: string): string {
  for (const re of PATTERNS) {
    if (re.test(url)) return url.replace(re, '$1***');
  }
  return url;
}

/** Compatibilidad: antes solo se tapaba el enlace del saldo. */
export const redactWalletToken = redactSecretsInUrl;
