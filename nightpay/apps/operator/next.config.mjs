/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: process.env.NEXT_BUILD_TRACE_ROOT || undefined,
  transpilePackages: ['@nightpay/contracts', '@nightpay/ui'],
  // Pantalla del datáfono: la app del aparato le da acceso al lector, así que
  // ni carga otras páginas dentro (iframes) ni se deja meter en otras.
  async headers() {
    return [
      {
        source: '/pax/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-src 'none'; frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/pax',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-src 'none'; frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
