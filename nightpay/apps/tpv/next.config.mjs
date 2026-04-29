/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: process.env.NEXT_BUILD_TRACE_ROOT || undefined,
  transpilePackages: ['@nightpay/contracts'],
};

export default nextConfig;
