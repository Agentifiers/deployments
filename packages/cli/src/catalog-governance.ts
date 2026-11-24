import { GOVERNANCE_OPERATION_KINDS } from "@deployments-ai/api-contract/governance";
import type { CommandCatalog } from "./types.ts";
import { action, json, number, positional, repeatable, text } from "./catalog-helpers.ts";
import { CliError, ExitCode } from "./errors.ts";

const organizationId = {
  ...positional("Organization ID"),
  field: "id",
} as const;

const operationId = {
  ...positional("Governance operation ID"),
  field: "operationId",
} as const;

const retentionArgs = {
  "organization-id": organizationId,
  artifacts: number("Artifact retention in days"),
  audit: number("Audit retention in days"),
  events: number("Event retention in days"),
  messages: number("Message retention in days"),
  runs: number("Run retention in days"),
  threads: number("Thread retention in days"),
} as const;

/** `--origin` builds entries without notes; `--entries` takes the whole list as JSON. */
function egressAllowlistBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { entries, origins } = body;
  if ((entries === undefined) === (origins === undefined)) {
    throw new CliError("Provide either --origin (repeatable) or --entries.", ExitCode.usage);
  }
  return {
    entries: Array.isArray(origins) ? origins.map((origin) => ({ origin })) : entries,
  };
}

export const governanceCommandCatalog: CommandCatalog = {
  "egress-allowlist": {
    summary: "Origins tools may reach without approval inside a data boundary",
    actions: {
      get: action({
        summary: "Show an organization's egress allowlist",
        method: "GET",
        path: "/v1/organizations/:id/egress-allowlist",
        scope: "organization",
        output: "detail",
        args: { "organization-id": organizationId },
      }),
      set: action({
        summary: "Replace an organization's egress allowlist",
        method: "PUT",
        path: "/v1/organizations/:id/egress-allowlist",
        scope: "organization",
        output: "detail",
        args: {
          "organization-id": organizationId,
          origin: {
            ...repeatable("An https origin such as https://api.example.com"),
            bodyField: "origins",
          },
          entries: json('The whole list as JSON: [{"origin":"https://...","note":"..."}]'),
        },
        idempotent: true,
        shapeBody: egressAllowlistBody,
      }),
    },
  },
  governance: {
    summary: "Retention, tenant data, and immutable audit exports",
    actions: {
      "retention-show": action({
        summary: "Show an organization retention policy",
        method: "GET",
        path: "/v1/organizations/:id/retention-policy",
        scope: "organization",
        output: "detail",
        args: { "organization-id": organizationId },
      }),
      "retention-update": action({
        summary: "Update an organization retention policy",
        method: "PATCH",
        path: "/v1/organizations/:id/retention-policy",
        scope: "organization",
        output: "detail",
        args: retentionArgs,
        idempotent: true,
      }),
      "tenant-export": action({
        summary: "Create a tenant data export",
        method: "POST",
        path: "/v1/organizations/:id/data-exports",
        scope: "organization",
        output: "action",
        args: { "organization-id": organizationId },
        idempotent: true,
      }),
      "tenant-export-status": action({
        summary: "Show a tenant data export operation",
        method: "GET",
        path: "/v1/organizations/:id/data-exports/:operationId",
        scope: "organization",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "operation-id": operationId,
        },
      }),
      erase: action({
        summary: "Erase tenant data",
        method: "POST",
        path: "/v1/organizations/:id/erasures",
        scope: "organization",
        output: "action",
        args: {
          "organization-id": organizationId,
        },
        fixedBody: { confirmation: "ERASE" },
        idempotent: true,
        destructive: true,
      }),
      "erasure-status": action({
        summary: "Show a tenant erasure operation",
        method: "GET",
        path: "/v1/organizations/:id/erasures/:operationId",
        scope: "organization",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "operation-id": operationId,
        },
      }),
      "audit-export": action({
        summary: "Create an immutable audit export",
        method: "POST",
        path: "/v1/organizations/:id/audit-exports",
        scope: "organization",
        output: "action",
        args: { "organization-id": organizationId },
        idempotent: true,
      }),
      "audit-export-status": action({
        summary: "Show an immutable audit export operation",
        method: "GET",
        path: "/v1/organizations/:id/audit-exports/:operationId",
        scope: "organization",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "operation-id": operationId,
        },
      }),
      operations: action({
        summary: "List governance operation history, newest first",
        method: "GET",
        path: "/v1/organizations/:id/governance-operations",
        scope: "organization",
        output: "list",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          "organization-id": organizationId,
          kind: text(
            `Operation kind: ${new Intl.ListFormat("en", { type: "disjunction" }).format(GOVERNANCE_OPERATION_KINDS)}`,
            "query",
          ),
          status: text(
            "Operation status: pending, running, completed, failed, or canceled",
            "query",
          ),
        },
      }),
    },
  },
};
