/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nightpay/contracts'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
