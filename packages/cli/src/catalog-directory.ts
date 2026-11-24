import type { CommandCatalog } from "./types.ts";
import { action, create, id, mutate, requiredText, sensitive } from "./catalog-helpers.ts";

const DIRECTORY_PATH = "/v1/directory";
const DIRECTORY_TOKENS_PATH = `${DIRECTORY_PATH}/tokens`;

export const directoryCommandCatalog: CommandCatalog = {
  directory: {
    summary: "SCIM directory sync, which provisions organization members from an identity provider",
    actions: {
      show: action({
        summary:
          "Show directory sync, its tokens, and the SCIM base URL to give the identity provider",
        method: "GET",
        path: DIRECTORY_PATH,
        scope: "organization",
        output: "detail",
      }),
      set: action({
        summary: "Turn on directory sync or change the role it grants provisioned members",
        method: "PUT",
        path: DIRECTORY_PATH,
        scope: "organization",
        output: "detail",
        idempotent: true,
        args: {
          "default-role": {
            ...requiredText("Role for provisioned members: member or viewer"),
            field: "defaultRole",
          },
        },
      }),
    },
  },
  "directory-token": {
    summary: "Bearer tokens the identity provider presents to the SCIM API",
    namespace: { name: "directory", command: "token" },
    actions: {
      create: sensitive(
        create(
          DIRECTORY_TOKENS_PATH,
          "organization",
          {},
          "Create a SCIM bearer token; it is shown only in this response, so pass --reveal",
        ),
        ["secret"],
      ),
      revoke: mutate(
        "DELETE",
        DIRECTORY_TOKENS_PATH,
        "organization",
        "Revoke a SCIM bearer token",
        {
          id,
        },
      ),
    },
  },
};
