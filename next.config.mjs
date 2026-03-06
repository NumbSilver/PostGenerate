/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "@remotion/bundler",
      "@remotion/renderer",
      "remotion",
      "esbuild",
      "@rspack/core",
      "@rspack/binding",
      "@rspack/binding-darwin-arm64",
      "unrs-resolver"
    ]
  },
  webpack: (config, { dev }) => {
    // Avoid ENOSPC in constrained environments (webpack filesystem cache).
    if (!dev) config.cache = false;
    return config;
  }
};

export default nextConfig;
