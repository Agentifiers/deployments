import { listResponse } from "./scim-response.ts";
import { SCIM_MAX_COUNT, SCIM_USER_SCHEMA, type ScimDiscovery } from "./scim-request.ts";

function attribute(name: string, type: "boolean" | "complex" | "string", traits: object = {}) {
  return {
    name,
    type,
    multiValued: false,
    required: false,
    caseExact: false,
    mutability: "readWrite",
    returned: "default",
    uniqueness: "none",
    ...traits,
  };
}

function userSchema(baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: SCIM_USER_SCHEMA,
    name: "User",
    description: "A member of the organization, provisioned by its directory.",
    attributes: [
      attribute("userName", "string", { required: true, uniqueness: "server" }),
      attribute("name", "complex", { subAttributes: [attribute("formatted", "string")] }),
      attribute("displayName", "string"),
      attribute("emails", "complex", {
        multiValued: true,
        mutability: "immutable",
        subAttributes: [
          attribute("value", "string", { mutability: "immutable" }),
          attribute("type", "string", { canonicalValues: ["work"] }),
          attribute("primary", "boolean"),
        ],
      }),
      attribute("active", "boolean"),
    ],
    meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
  };
}

function userResourceType(baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    description: "Organization members",
    schema: SCIM_USER_SCHEMA,
    meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
  };
}

/** What this service supports, so identity providers do not try groups, bulk, sorting or ETags. */
function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Directory token",
        description: "A dpl_scim_ bearer token issued for the organization's directory.",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${baseUrl}/ServiceProviderConfig`,
    },
  };
}

export function discoveryDocument(document: ScimDiscovery, baseUrl: string) {
  switch (document) {
    case "resource-types":
      return listResponse([userResourceType(baseUrl)], { startIndex: 1, totalResults: 1 });
    case "schemas":
      return listResponse([userSchema(baseUrl)], { startIndex: 1, totalResults: 1 });
    case "service-provider-config":
      return serviceProviderConfig(baseUrl);
    case "user-resource-type":
      return userResourceType(baseUrl);
    case "user-schema":
      return userSchema(baseUrl);
    default: {
      const unhandled: never = document;
      return unhandled;
    }
  }
}
