import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  nitro: {
    awsLambda: { streaming: false },
    // API Gateway HTTP API adapter; nitro's generic AWS adapter duplicates Set-Cookie.
    entry: "./src/server/lambda-entry.ts",
    plugins: ["./src/server/validate-config-plugin.ts"],
    preset: "aws-lambda",
  },
  plugins: [
    nitro(),
    tailwindcss(),
    tanstackStart({ router: { quoteStyle: "double", semicolons: true } }),
    viteReact(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 3030,
  },
});
