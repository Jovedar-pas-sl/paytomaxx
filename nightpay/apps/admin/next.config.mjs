/**
 * Cabeceras de seguridad para todas las páginas: no se deja meter en iframes
 * de otros (engaños con clics), no ejecuta scripts de fuera y solo habla con
 * el API. Next mete scripts en línea al hidratar: 'unsafe-inline' hace falta
 * sin nonces; 'unsafe-eval' solo en desarrollo.
 */
const isDev = process.env.NODE_ENV !== 'production';
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:" + (isDev ? ' http: ws:' : ''),
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No usamos next/image: sin el optimizador de imágenes (y sus fallos de seguridad).
  images: { unoptimized: true },
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: process.env.NEXT_BUILD_TRACE_ROOT || undefined,
  transpilePackages: ['@nightpay/contracts', '@nightpay/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
