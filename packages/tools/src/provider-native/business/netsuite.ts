import {
  appendNativeQueryFields,
  jsonProviderNativeBody,
  requirePositiveLimit,
  requireProviderBaseUrl,
  requireToolString,
  sqlCodeWithoutCommentsAndLiterals,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { requiredObject } from "../tool-input-guards.ts";

function netsuiteBase(input: Record<string, unknown>): URL {
  return requireProviderBaseUrl(input, "accountUrl", "netsuite");
}

function netsuiteRecordCollection(input: Record<string, unknown>): URL {
  return new URL(
    `/services/rest/record/v1/${encodeURIComponent(requireToolString(input, "recordType"))}`,
    netsuiteBase(input),
  );
}

export const netsuiteNativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] = [
  {
    toolName: "netsuite.suiteql.query",
    description: "Run a governed read-only SuiteQL query against NetSuite.",
    effect: "read",
    provider: "netsuite",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "POST",
    filePrefix: "netsuite-suiteql-query",
    buildUrl: (input) => new URL("/services/rest/query/v1/suiteql", netsuiteBase(input)).toString(),
    buildBody(input) {
      const query = requireToolString(input, "query");
      const normalized = sqlCodeWithoutCommentsAndLiterals(query).trim();
      if (
        !/^(SELECT|WITH)\b/iu.test(normalized) ||
        /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b/iu.test(normalized)
      ) {
        throw new Error("Tool input query must be read-only SuiteQL");
      }
      return jsonProviderNativeBody({ q: query });
    },
    buildHeaders: () => ({ prefer: "transient" }),
  },
  {
    toolName: "netsuite.records.list",
    description: "List NetSuite records for an approved record type.",
    effect: "read",
    provider: "netsuite",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "netsuite-records-list",
    buildUrl(input) {
      const url = netsuiteRecordCollection(input);
      url.searchParams.set("limit", String(requirePositiveLimit(input, "limit", 100, 1000)));
      appendNativeQueryFields(url, input, ["offset", "q", "expandSubResources", "fields"]);
      return url.toString();
    },
  },
  {
    toolName: "netsuite.records.get",
    description: "Read one NetSuite record by id.",
    effect: "read",
    provider: "netsuite",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    method: "GET",
    filePrefix: "netsuite-record",
    buildUrl(input) {
      const collection = netsuiteRecordCollection(input);
      return new URL(
        `${collection.pathname}/${encodeURIComponent(requireToolString(input, "recordId"))}`,
        collection,
      ).toString();
    },
  },
  {
    toolName: "netsuite.records.create",
    description: "Create a NetSuite record after approval.",
    effect: "write",
    provider: "netsuite",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    method: "POST",
    filePrefix: "netsuite-record-create",
    buildUrl: (input) => netsuiteRecordCollection(input).toString(),
    buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "body")),
  },
  {
    toolName: "netsuite.records.update",
    description: "Update a NetSuite record after approval.",
    effect: "write",
    provider: "netsuite",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    method: "PATCH",
    filePrefix: "netsuite-record-update",
    buildUrl(input) {
      const collection = netsuiteRecordCollection(input);
      return new URL(
        `${collection.pathname}/${encodeURIComponent(requireToolString(input, "recordId"))}`,
        collection,
      ).toString();
    },
    buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "body")),
  },
];
