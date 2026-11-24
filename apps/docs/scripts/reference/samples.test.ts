import { expect, test } from "bun:test";
import { readCliTree } from "./cli-tree.ts";
import { buildDocsOpenApi } from "./openapi-document.ts";
import { buildOperations } from "./operations.ts";

test("SDK samples fill enum path parameters with an allowed value and keep placeholders for the rest", async () => {
  const document = buildDocsOpenApi(buildOperations(await readCliTree()));
  const operation = document.paths["/v1/organizations/{id}/model-credentials/{provider}"]?.get;

  expect(operation?.["x-codeSamples"]?.[0]?.source).toBe(
    [
      'import { createClient, createConfig, getModelCredential } from "@agentifiers/deployments-sdk";',
      "",
      "const client = createClient(",
      "  createConfig({",
      '    baseUrl: "https://api.example.com",',
      "    headers: { authorization: `Bearer ${process.env.DEPLOYMENTS_API_KEY}` },",
      "  }),",
      ");",
      "",
      "const { data, error } = await getModelCredential({",
      "  client,",
      '  path: { id: "<id>", provider: "openai" },',
      "  headers: {",
      '    "x-deployments-organization": "<organization-id>",',
      "  },",
      "});",
      "",
    ].join("\n"),
  );
});
