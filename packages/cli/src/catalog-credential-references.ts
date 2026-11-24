import { CREDENTIAL_REFERENCE_OWNER_TYPES } from "@deployments-ai/api-contract/credential-references";
import type { CommandCatalog } from "./types.ts";
import { action, text } from "./catalog-helpers.ts";

export const credentialReferenceCommandCatalog: CommandCatalog = {
  "credential-reference": {
    summary: "Metadata-only inventory of stored secrets and their owners",
    actions: {
      list: action({
        summary: "List credential-vault references held by environment owners",
        method: "GET",
        path: "/v1/credential-references",
        scope: "environment",
        output: "list",
        args: {
          "owner-type": {
            ...text(`Owner type (${CREDENTIAL_REFERENCE_OWNER_TYPES.join(", ")})`, "query"),
            field: "ownerType",
          },
        },
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
      }),
    },
  },
};
