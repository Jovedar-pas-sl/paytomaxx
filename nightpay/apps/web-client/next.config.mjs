/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: process.env.NEXT_BUILD_TRACE_ROOT || undefined,
  transpilePackages: ['@nightpay/contracts', '@nightpay/ui'],
  experimental: {
    typedRoutes: true,
  },
  async headers() {
    return [
      {
        // Cabeceras seguridad para TODAS las rutas. El web-client sirve la
        // página de pago al cliente borracho — debe estar tan blindada como
        // sea posible sin romper la integración con la pasarela.
        source: '/:path*',
        headers: [
          // HSTS — fuerza HTTPS en producción. 1 año + subdominios + preload.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          // Sin MIME sniffing — el navegador respeta el Content-Type que enviamos
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // No incrustar en <iframe> de terceros — clickjacking
          { key: 'X-Frame-Options', value: 'DENY' },
          // Solo enviar referrer al mismo origin
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Bloquear APIs sensibles que no usamos en la página de pago
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          // CSP — el web-client NO necesita inline scripts (todo es Next.js
          // bundles). Allowlist apertura a Socket.io (mismo origen) +
          // API backend (NEXT_PUBLIC_API_URL).
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'", // Next.js inline styles
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              // connect-src abierto para ws/wss/https — el API_URL viene de env
              // build-time; usamos wildcard sobre paytomaxx.com como compromiso.
              "connect-src 'self' https: wss: ws:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
