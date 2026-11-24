import { optionalToolString } from "../core.ts";
import {
  integerProperty,
  objectSchema,
  staticProviderUrl,
  stringProperty,
} from "../tool-definition-builders.ts";
import { bearerHeaders, businessRead } from "./common.ts";

const HOSTS = ["api.dub.co"] as const;

function dubLinksUrl(input: Record<string, unknown>): string {
  const url = new URL(staticProviderUrl("api.dub.co", ["links"]));
  const startingAfter = optionalToolString(input, "startingAfter");
  const endingBefore = optionalToolString(input, "endingBefore");
  if (startingAfter && endingBefore) {
    throw new Error("Dub link pagination accepts startingAfter or endingBefore, not both");
  }
  for (const key of ["domain", "search", "tagIds", "folderId", "tenantId", "sort"] as const) {
    const value = optionalToolString(input, key);
    if (value) url.searchParams.set(key, value);
  }
  if (startingAfter) url.searchParams.set("startingAfter", startingAfter);
  if (endingBefore) url.searchParams.set("endingBefore", endingBefore);
  const pageSize = input.pageSize;
  if (typeof pageSize === "number" && Number.isFinite(pageSize)) {
    url.searchParams.set("pageSize", String(Math.min(Math.max(Math.trunc(pageSize), 1), 100)));
  }
  return url.toString();
}

function dubAnalyticsUrl(input: Record<string, unknown>): string {
  const url = new URL(staticProviderUrl("api.dub.co", ["analytics"]));
  for (const key of [
    "linkId",
    "domain",
    "key",
    "externalId",
    "tenantId",
    "programId",
    "event",
    "interval",
    "groupBy",
    "start",
    "end",
    "timezone",
  ] as const) {
    const value = optionalToolString(input, key);
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export const dubCoNativeHttpToolDefinitions = [
  businessRead({
    auditSelectorKeys: ["domain", "folderId", "tenantId"],
    buildHeaders: bearerHeaders,
    buildUrl: dubLinksUrl,
    description: "List Dub.co links for the connected attribution workspace.",
    expectedHost: "api.dub.co",
    hosts: HOSTS,
    inputSchema: objectSchema({
      domain: stringProperty("Optional Dub.co domain filter."),
      endingBefore: stringProperty("Optional backward pagination cursor."),
      folderId: stringProperty("Optional folder filter."),
      pageSize: integerProperty(1, 100),
      search: stringProperty("Optional Dub.co link search."),
      sort: stringProperty("Optional Dub.co sort expression."),
      startingAfter: stringProperty("Optional forward pagination cursor."),
      tagIds: stringProperty("Optional comma-separated tag IDs."),
      tenantId: stringProperty("Optional tenant filter."),
    }),
    provider: "dub_co",
    resourceTypes: ["workspace"],
    sampleInput: { pageSize: 25 },
    toolName: "dub_co.links.list",
    verificationPath: "/links?pageSize=1",
  }),
  businessRead({
    auditSelectorKeys: ["linkId", "domain", "tenantId", "programId"],
    buildHeaders: bearerHeaders,
    buildUrl: dubAnalyticsUrl,
    description: "Read Dub.co attribution analytics for an authorized workspace or link.",
    expectedHost: "api.dub.co",
    hosts: HOSTS,
    inputSchema: objectSchema({
      domain: stringProperty("Optional Dub.co domain filter."),
      end: stringProperty("Optional inclusive analytics end date."),
      event: stringProperty("Optional Dub.co event filter."),
      externalId: stringProperty("Optional external customer selector."),
      groupBy: stringProperty("Optional analytics grouping dimension."),
      interval: stringProperty("Optional analytics interval."),
      key: stringProperty("Optional short-link key filter."),
      linkId: stringProperty("Optional Dub.co link selector."),
      programId: stringProperty("Optional partner program selector."),
      start: stringProperty("Optional analytics start date."),
      tenantId: stringProperty("Optional tenant selector."),
      timezone: stringProperty("Optional IANA timezone."),
    }),
    provider: "dub_co",
    resourceTypes: ["workspace"],
    sampleInput: { linkId: "link_1" },
    toolName: "dub_co.analytics.read",
  }),
] as const;
