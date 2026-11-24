import {
  DIRECTORY_API_ROUTES,
  DirectoryResponse,
  PutDirectoryRequest,
} from "@deployments-ai/api-contract";
import type { Directory, DirectorySettings } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createOrganizationAdminApi,
  requiredId,
  type OrganizationAdminApiOptions,
} from "./organization-admin-api.ts";

const strict = { onExcessProperty: "error" } as const;

export interface CreateDirectoryApiOptions extends OrganizationAdminApiOptions {
  readonly directory: Pick<Directory, "getSettings" | "issueToken" | "putSettings" | "revokeToken">;
}

/** Serves `/v1/directory*`, where organization administrators configure SCIM provisioning. */
export function createDirectoryApi(options: CreateDirectoryApiOptions) {
  const { directory } = options;
  return createOrganizationAdminApi(
    {
      label: "Directory sync",
      operate: async (routeName, invocation) => {
        const { administrator } = invocation;
        const view = (settings: DirectorySettings): typeof DirectoryResponse.Encoded => ({
          ...settings,
          scimBaseUrl: `${invocation.origin}/scim/v2`,
        });
        switch (routeName) {
          case "getDirectory":
            return view(await directory.getSettings(administrator.organizationId));
          case "putDirectory": {
            const body = Schema.decodeUnknownSync(PutDirectoryRequest, strict)(invocation.body);
            return view(await directory.putSettings(administrator, body));
          }
          case "createDirectoryToken": {
            const issued = await directory.issueToken(administrator);
            return {
              directory: view(issued.settings),
              token: { ...issued.token, secret: issued.secret },
            };
          }
          case "revokeDirectoryToken":
            return view(await directory.revokeToken(administrator, requiredId(invocation)));
          default: {
            const unhandled: never = routeName;
            throw new TypeError(`Unhandled directory route: ${String(unhandled)}`);
          }
        }
      },
      routes: DIRECTORY_API_ROUTES,
    },
    options,
  );
}
