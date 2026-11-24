import {
  appendNativeQueryFields,
  jsonProviderNativeBody,
  requirePositiveLimit,
  requireProviderBaseUrl,
  requireToolString,
  type ProviderNativeHttpToolDefinition,
} from "../core.ts";
import { requiredObject } from "../tool-input-guards.ts";

const DYNAMICS_READ_SCOPES = ["user_impersonation"] as const;
const DYNAMICS_WRITE_SCOPES = ["user_impersonation"] as const;

function dynamicsBase(input: Record<string, unknown>): URL {
  return requireProviderBaseUrl(input, "instanceUrl", "microsoft-dynamics-365");
}

function dynamicsCollectionUrl(input: Record<string, unknown>): URL {
  return new URL(
    `/api/data/v9.2/${encodeURIComponent(requireToolString(input, "entitySet"))}`,
    dynamicsBase(input),
  );
}

function dynamicsHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "odata-maxversion": "4.0",
    "odata-version": "4.0",
  };
}

export const microsoftDynamics365NativeHttpToolDefinitions: readonly ProviderNativeHttpToolDefinition[] =
  [
    {
      toolName: "microsoft_dynamics.records.search",
      description: "Search Microsoft Dynamics 365 records in an approved entity set.",
      effect: "read",
      provider: "microsoft-dynamics-365",
      requiredScopes: DYNAMICS_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "dynamics-records-search",
      buildUrl(input) {
        const url = dynamicsCollectionUrl(input);
        url.searchParams.set("$top", String(requirePositiveLimit(input, "limit", 25, 100)));
        appendNativeQueryFields(url, input, [
          "$filter",
          "$select",
          "$expand",
          "$orderby",
          "$skiptoken",
        ]);
        return url.toString();
      },
      buildHeaders: dynamicsHeaders,
    },
    {
      toolName: "microsoft_dynamics.records.get",
      description: "Read one Microsoft Dynamics 365 record by id.",
      effect: "read",
      provider: "microsoft-dynamics-365",
      requiredScopes: DYNAMICS_READ_SCOPES,
      defaultPolicyAction: "allow",
      method: "GET",
      filePrefix: "dynamics-record",
      buildUrl(input) {
        const base = dynamicsCollectionUrl(input);
        const url = new URL(
          `${base.pathname}(${encodeURIComponent(requireToolString(input, "recordId"))})`,
          base,
        );
        appendNativeQueryFields(url, input, ["$select", "$expand"]);
        return url.toString();
      },
      buildHeaders: dynamicsHeaders,
    },
    {
      toolName: "microsoft_dynamics.records.create",
      description: "Create a Microsoft Dynamics 365 record after approval.",
      effect: "write",
      provider: "microsoft-dynamics-365",
      requiredScopes: DYNAMICS_WRITE_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "POST",
      filePrefix: "dynamics-record-create",
      buildUrl: (input) => dynamicsCollectionUrl(input).toString(),
      buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "body")),
      buildHeaders: dynamicsHeaders,
    },
    {
      toolName: "microsoft_dynamics.records.update",
      description: "Update a Microsoft Dynamics 365 record after approval.",
      effect: "write",
      provider: "microsoft-dynamics-365",
      requiredScopes: DYNAMICS_WRITE_SCOPES,
      defaultPolicyAction: "require_approval",
      method: "PATCH",
      filePrefix: "dynamics-record-update",
      buildUrl(input) {
        const base = dynamicsCollectionUrl(input);
        return new URL(
          `${base.pathname}(${encodeURIComponent(requireToolString(input, "recordId"))})`,
          base,
        ).toString();
      },
      buildBody: (input) => jsonProviderNativeBody(requiredObject(input, "body")),
      buildHeaders: dynamicsHeaders,
    },
  ];
