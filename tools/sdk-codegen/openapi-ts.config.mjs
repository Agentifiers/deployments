import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "../../packages/sdk/dist/codegen-openapi.json",
  output: {
    importFileExtension: ".js",
    path: "../../packages/sdk/dist/generated-src",
  },
  client: "@hey-api/client-fetch",
});
