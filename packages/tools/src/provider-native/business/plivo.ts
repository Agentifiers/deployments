import { requireToolString } from "../core.ts";
import {
  integerProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { businessRead, businessWrite, plivoJsonBody } from "./common.ts";

const HOSTS = ["api.plivo.com"] as const;
const E164_PATTERN = "^\\+[1-9]\\d{6,14}$";

function plivoUrl(input: Record<string, unknown>, path: readonly string[]): string {
  const authId = requireToolString(input, "authId");
  const url = staticProviderUrl("api.plivo.com", ["v1", "Account", authId, ...path]);
  return path.at(-1) === "" ? `${url.replace(/\/+$/u, "")}/` : url;
}

function plivoCollectionUrl(input: Record<string, unknown>, path: readonly string[]): string {
  const url = new URL(plivoUrl(input, path));
  const limit = input.limit;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit), 1), 20)));
  }
  const offset = input.offset;
  if (typeof offset === "number" && Number.isFinite(offset)) {
    url.searchParams.set("offset", String(Math.max(Math.trunc(offset), 0)));
  }
  return url.toString();
}

export const plivoNativeHttpToolDefinitions = [
  businessRead({
    auditSelectorKeys: ["authId"],
    buildUrl: (input) => plivoUrl(input, [""]),
    description: "Read the connected Plivo account identity and status.",
    expectedHost: "api.plivo.com",
    hosts: HOSTS,
    inputSchema: objectSchema({ authId: stringProperty("Plivo Auth ID.") }, ["authId"]),
    provider: "plivo",
    resourceTypes: ["account"],
    sampleInput: { authId: "MA00000000000000000000000000000000" },
    toolName: "plivo.account.read",
    verificationPath: "/v1/Account/{authId}/",
  }),
  businessRead({
    auditSelectorKeys: ["authId"],
    buildUrl: (input) => plivoCollectionUrl(input, ["Message", ""]),
    description: "List Plivo messages for an authorized account.",
    expectedHost: "api.plivo.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        authId: stringProperty("Plivo Auth ID."),
        limit: integerProperty(1, 20),
        offset: integerProperty(0),
      },
      ["authId"],
    ),
    provider: "plivo",
    resourceTypes: ["account"],
    sampleInput: { authId: "MA00000000000000000000000000000000", limit: 25 },
    toolName: "plivo.messages.list",
  }),
  businessRead({
    auditSelectorKeys: ["authId"],
    buildUrl: (input) => plivoCollectionUrl(input, ["Number", ""]),
    description: "List Plivo numbers for an authorized account.",
    expectedHost: "api.plivo.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        authId: stringProperty("Plivo Auth ID."),
        limit: integerProperty(1, 20),
        offset: integerProperty(0),
      },
      ["authId"],
    ),
    provider: "plivo",
    resourceTypes: ["account"],
    sampleInput: { authId: "MA00000000000000000000000000000000", limit: 25 },
    toolName: "plivo.numbers.list",
  }),
  businessWrite({
    auditSelectorKeys: ["authId", "src", "dst"],
    buildBody: plivoJsonBody,
    buildUrl: (input) => plivoUrl(input, ["Message", ""]),
    description: "Send an approved Plivo SMS message to an explicitly supplied recipient.",
    // Plivo calls the delivery callback `url` the input names.
    egress: "public",
    expectedHost: "api.plivo.com",
    hosts: HOSTS,
    inputSchema: objectSchema(
      {
        authId: stringProperty("Plivo Auth ID."),
        dst: { minLength: 1, pattern: E164_PATTERN, type: "string" },
        method: stringProperty("Optional callback HTTP method."),
        src: { minLength: 1, pattern: E164_PATTERN, type: "string" },
        text: stringProperty("SMS body."),
        url: stringProperty("Optional delivery callback URL."),
      },
      ["authId", "dst", "src", "text"],
    ),
    method: "POST",
    provider: "plivo",
    resourceTypes: ["account"],
    sampleInput: {
      authId: "MA00000000000000000000000000000000",
      dst: "+15550000002",
      src: "+15550000001",
      text: "Approved message",
    },
    toolName: "plivo.messages.send",
  }),
] as const;
