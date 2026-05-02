/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      os: false,
      path: false,
      stream: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
