import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const config = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
} satisfies NextConfig;

export default createMDX()(config);
