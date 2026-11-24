import {
  appendNativeQueryFields,
  optionalToolPositiveInteger,
  optionalToolString,
  requireToolString,
} from "../core.ts";
import {
  integerProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { businessRead } from "./common.ts";

const HOSTS = ["api.postscript.io"] as const;

function subscribersUrl(input: Record<string, unknown>) {
  const url = new URL(staticProviderUrl("api.postscript.io", ["api", "v2", "subscribers"]));
  const page = optionalToolPositiveInteger(input, "page");
  if (page !== undefined) url.searchParams.set("page", String(page));
  const updatedAtOrAfter = optionalToolString(input, "updatedAtOrAfter");
  if (updatedAtOrAfter) url.searchParams.set("updated_at__gte", updatedAtOrAfter);
  appendNativeQueryFields(url, input, ["sort"]);
  return url.toString();
}

function subscriberId(input: Record<string, unknown>) {
  const value = requireToolString(input, "subscriberId");
  if (value === "." || value === ".." || /[/?#]/u.test(value)) {
    throw new Error("Postscript subscriberId must be one path segment");
  }
  return value;
}

export const postscriptNativeHttpToolDefinitions = [
  businessRead({
    auditSelectorKeys: ["page", "updatedAtOrAfter"],
    buildUrl: (input) => subscribersUrl(input),
    description:
      "List subscribers for the Postscript shop, optionally filtered by update time and page.",
    expectedHost: "api.postscript.io",
    hosts: HOSTS,
    inputSchema: objectSchema({
      page: integerProperty(1),
      sort: stringProperty("Postscript sort expression, such as updated_at__desc."),
      updatedAtOrAfter: stringProperty("ISO 8601 lower bound for subscriber updates."),
    }),
    provider: "postscript",
    resourceTypes: ["contact"],
    sampleInput: { page: 1, sort: "updated_at__desc" },
    toolName: "postscript.subscribers.list",
    verificationPath: "/api/v2/subscribers?page=1",
  }),
  businessRead({
    auditSelectorKeys: ["subscriberId"],
    buildUrl: (input) =>
      staticProviderUrl("api.postscript.io", ["api", "v2", "subscribers", subscriberId(input)]),
    description: "Read one subscriber from the connected Postscript shop.",
    expectedHost: "api.postscript.io",
    hosts: HOSTS,
    inputSchema: objectSchema(
      { subscriberId: stringProperty("Postscript subscriber identifier.") },
      ["subscriberId"],
    ),
    provider: "postscript",
    resourceTypes: ["contact"],
    sampleInput: { subscriberId: "subscriber_1" },
    toolName: "postscript.subscriber.read",
  }),
] as const;
