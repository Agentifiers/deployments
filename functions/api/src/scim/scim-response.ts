import type { DirectoryUser } from "@deployments-ai/db";
import type { ScimError } from "./scim-error.ts";
import { SCIM_USER_SCHEMA } from "./scim-request.ts";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export function scimResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: { ...headers, "content-type": SCIM_CONTENT_TYPE },
    status,
  });
}

export function scimErrorResponse(error: ScimError) {
  return scimResponse(
    error.status,
    {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(error.status),
      ...(error.scimType === undefined ? {} : { scimType: error.scimType }),
      detail: error.detail,
    },
    error.headers,
  );
}

export function listResponse(
  resources: readonly unknown[],
  page: { readonly startIndex: number; readonly totalResults: number },
) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: page.totalResults,
    startIndex: page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function renderUser(user: DirectoryUser, baseUrl: string) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId === undefined ? {} : { externalId: user.externalId }),
    userName: user.userName,
    ...(user.displayName === undefined
      ? {}
      : { displayName: user.displayName, name: { formatted: user.displayName } }),
    ...(user.email === undefined
      ? {}
      : { emails: [{ value: user.email, primary: true, type: "work" }] }),
    active: user.active,
    meta: {
      resourceType: "User",
      created: user.created,
      lastModified: user.lastModified,
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}
