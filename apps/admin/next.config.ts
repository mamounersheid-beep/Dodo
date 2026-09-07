import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@dodo/ui", "@dodo/shared-types"],
};

export default nextConfig;
