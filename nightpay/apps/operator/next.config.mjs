/**
 * Cabeceras de seguridad para todas las páginas: no se deja meter en iframes
 * de otros (engaños con clics), no ejecuta scripts de fuera y solo habla con
 * el API. Next mete scripts en línea al hidratar: 'unsafe-inline' hace falta
 * sin nonces; 'unsafe-eval' solo en desarrollo.
 */
const isDev = process.env.NODE_ENV !== 'production';

/** esquema://host[:puerto] de una URL, o null si no lo es. */
function originOf(url) {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

// connect-src: esta web y el API de este build (NEXT_PUBLIC_* se fijan al
// compilar, igual que en el código). El WebSocket también en http(s): socket.io
// cae a polling si no conecta.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';
const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? apiUrl.replace(/^http/, 'ws');
const connectSrc = [
  "'self'",
  originOf(apiUrl),
  originOf(wsUrl),
  originOf(wsUrl.replace(/^ws/, 'http')),
  ...(isDev ? ['http://localhost:*', 'ws://localhost:*', 'http://127.0.0.1:*', 'ws://127.0.0.1:*'] : []),
].filter((src, i, all) => src && all.indexOf(src) === i);

// Los client hints del modelo van también al API (otro origen): hay que delegárselos.
const apiOrigin = originOf(apiUrl);
const clientHintsDelegation = apiOrigin
  ? `, ch-ua-model=(self "${apiOrigin}"), ch-ua-platform-version=(self "${apiOrigin}")`
  : '';

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src ${connectSrc.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  // Cámara solo para esta web: el camarero escanea el «Mi QR» de la chica
  // («Copa con invitación»); ninguna otra página (ni iframes) la pide. Web NFC
  // no pasa por Permissions-Policy (el NFC sigue funcionando).
  // Detalle del pago: el modelo y la versión del Android (client hints) en las
  // peticiones al API, que los guarda con el cobro (el iPhone no los da).
  { key: 'Accept-CH', value: 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version' },
  { key: 'Permissions-Policy', value: `camera=(self), microphone=(), geolocation=(), payment=()${clientHintsDelegation}` },
];
// Next aplica la última cabecera que coincide: en /pax va la política entera
// más frame-src 'none' (antes una regla corta dejaba /pax sin el resto).
const paxHeaders = securityHeaders.map((h) =>
  h.key === 'Content-Security-Policy' ? { ...h, value: `${h.value}; frame-src 'none'` } : h,
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No usamos next/image: sin el optimizador de imágenes (y sus fallos de seguridad).
  images: { unoptimized: true },
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: process.env.NEXT_BUILD_TRACE_ROOT || undefined,
  transpilePackages: ['@nightpay/api-client', '@nightpay/contracts', '@nightpay/ui'],
  // Pantalla del datáfono: la app del aparato le da acceso al lector, así que
  // ni carga otras páginas dentro (iframes) ni se deja meter en otras.
  async headers() {
    return [
      // Todas las páginas.
      { source: '/:path*', headers: securityHeaders },
      // El datáfono: la misma política y, además, ninguna página dentro (iframes).
      { source: '/pax', headers: paxHeaders },
      { source: '/pax/:path*', headers: paxHeaders },
    ];
  },
};

export default nextConfig;
