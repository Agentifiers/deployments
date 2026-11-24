import type { CommandCatalog } from "./types.ts";
import { action, requiredText } from "./catalog-helpers.ts";

export const hostedCodeCommandCatalog: CommandCatalog = {
  "hosted-code-artifact": {
    summary: "Immutable hosted code tool artifacts",
    actions: {
      create: action({
        summary: "Upload hosted code tool source",
        method: "POST",
        path: "/v1/hosted-code-artifacts",
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          language: requiredText("javascript, typescript, or python"),
          source: requiredText("Tool source code"),
        },
      }),
      show: action({
        summary: "Show a hosted code tool artifact",
        method: "GET",
        path: "/v1/hosted-code-artifacts/:contentHash",
        scope: "environment",
        output: "detail",
        args: {
          "content-hash": {
            ...requiredText("Artifact content hash (sha256:<hex>)"),
            field: "contentHash",
            target: "path",
          },
        },
      }),
    },
  },
};
