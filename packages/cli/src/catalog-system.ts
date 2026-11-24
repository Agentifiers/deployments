import {
  OPERATOR_ACCESS_DEFAULT_MINUTES,
  OPERATOR_ACCESS_MAXIMUM_MINUTES,
  DATA_BOUNDARY_PROFILES,
  STANDING_HOLD_REASONS,
  SYSTEM_ALARM_STATES,
  SYSTEM_PRINCIPAL_STATUSES,
} from "@deployments-ai/api-contract/system";
import type { CommandCatalog } from "./types.ts";
import { action, json, list, number, positional, requiredText, text } from "./catalog-helpers.ts";

const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;
const organizationStandingPath = "/v1/system/organizations/:organizationId/standing";
const organizationHoldPath = "/v1/system/organizations/:organizationId/holds/:holdKey";
const organizationEntitlementsPath = "/v1/system/organizations/:organizationId/entitlements";
const organizationDataBoundaryPath = "/v1/system/organizations/:organizationId/data-boundary";
const organizationAccessPath = "/v1/system/organizations/:organizationId/operator-access";
const organizationId = positional("Organization ID");
const holdKey = positional("Hold key: lowercase letters, digits, and hyphens");
const principalPath = "/v1/system/principals/:principalId";
const principalId = positional("Principal ID of the person");

export const systemCommandCatalog: CommandCatalog = {
  system: {
    summary: "Install operator status for platform administrators",
    actions: {
      installation: action({
        summary: "Show the deployed release, account, endpoints, and observability data locations",
        method: "GET",
        path: "/v1/system/installation",
        scope: "none",
        output: "detail",
      }),
      deployments: {
        ...list(
          "/v1/system/deployments",
          "none",
          "List recorded deployments, newest first",
          pagination,
        ),
        columns: ["id", "deployedAt", "sourceCommit", "deployedBy"],
      },
      components: action({
        summary: "Show ECS service and Lambda function health for the install",
        method: "GET",
        path: "/v1/system/components",
        scope: "none",
        output: "detail",
      }),
      alarms: {
        ...list("/v1/system/alarms", "none", "List the install's CloudWatch alarms", pagination),
        args: {
          state: {
            definition: {
              type: "enum",
              description: "Only alarms currently in this state",
              options: [...SYSTEM_ALARM_STATES],
            },
            target: "query",
          },
        },
        columns: ["name", "state", "updatedAt", "reason"],
      },
      "model-providers": {
        ...list("/v1/system/model-providers", "none", "Show model provider key metadata"),
        pagination: false,
        columns: ["provider", "configured", "credentialStore", "lastModifiedAt", "version"],
      },
      organizations: {
        ...list(
          "/v1/system/organizations",
          "none",
          "List every organization in the install",
          pagination,
        ),
        columns: ["id", "name", "slug", "status", "activeMemberCount"],
      },
      standing: action({
        summary: "Show an organization's holds, grants, data boundary, and effective entitlements",
        method: "GET",
        path: organizationStandingPath,
        scope: "none",
        output: "detail",
        args: { "organization-id": organizationId },
      }),
      "standing-history": {
        ...list(
          `${organizationStandingPath}/history`,
          "none",
          "List an organization's hold and grant changes, newest first",
          pagination,
        ),
        args: { "organization-id": organizationId },
        columns: ["version", "occurredAt", "state", "actor"],
      },
      spend: action({
        summary: "Show an organization's spend in a month, split by who paid",
        method: "GET",
        path: "/v1/system/organizations/:organizationId/spend",
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          month: text("UTC month as YYYY-MM; defaults to the current month", "query"),
        },
      }),
      hold: action({
        summary: "Place an operator hold on an organization",
        method: "PUT",
        path: organizationHoldPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "hold-key": holdKey,
          reason: {
            definition: {
              type: "enum",
              description: "Why the organization is held",
              options: [...STANDING_HOLD_REASONS],
              required: true,
            },
            target: "body",
          },
          "customer-message": requiredText("Shown to the organization's members"),
          "operator-note": text("Seen only by operators and services"),
        },
        destructive: true,
      }),
      release: action({
        summary: "Release an operator hold on an organization",
        method: "DELETE",
        path: organizationHoldPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "hold-key": holdKey,
          "release-note": text("Why the hold is released; recorded in the history"),
        },
      }),
      "set-entitlements": action({
        summary: "Replace the operator's entitlement grant; omitted fields fall to other sources",
        method: "PUT",
        path: organizationEntitlementsPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "tenant-limits": json('Tenant limits, such as {"concurrentRuns":32}'),
          "model-spend-ceiling": {
            ...json('"unlimited" or {"monthlyUsdMicros":100000000}'),
            bodyField: "operatorFundedModelSpendCeiling",
          },
        },
      }),
      "clear-entitlements": action({
        summary: "Remove the operator's entitlement grant",
        method: "DELETE",
        path: organizationEntitlementsPath,
        scope: "none",
        output: "detail",
        args: { "organization-id": organizationId },
        destructive: true,
      }),
      "set-data-boundary": action({
        summary: "Limit where an organization's data can go; only operators can set it",
        method: "PUT",
        path: organizationDataBoundaryPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          profile: {
            definition: {
              type: "enum",
              description: "phi keeps tools off the public internet and models on Bedrock",
              options: [...DATA_BOUNDARY_PROFILES],
              required: true,
            },
            target: "body",
          },
          "operator-note": requiredText(
            "Why, such as the agreement reference; never shown to members",
          ),
        },
      }),
      "clear-data-boundary": action({
        summary: "Remove an organization's data boundary",
        method: "DELETE",
        path: organizationDataBoundaryPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          "operator-note": requiredText("Why the boundary ends; recorded in the history"),
        },
        destructive: true,
      }),
      "set-principal-status": action({
        summary: "Disable a person, which ends their sessions, or re-enable them",
        method: "PUT",
        path: "/v1/system/principals/:principalId/status",
        scope: "none",
        output: "detail",
        args: {
          "principal-id": positional("Principal ID of the person"),
          status: {
            definition: {
              type: "enum",
              description: "disabled or active",
              options: [...SYSTEM_PRINCIPAL_STATUSES],
              required: true,
            },
            target: "body",
          },
          reason: requiredText("Why the status changes; recorded in the person's security events"),
        },
        destructive: true,
      }),
      "access-open": action({
        summary: "Open or renew your operator access to an organization's data",
        method: "PUT",
        path: organizationAccessPath,
        scope: "none",
        output: "detail",
        args: {
          "organization-id": organizationId,
          reason: requiredText("Why you need the data; shown in the organization's audit log"),
          ticket: text("Support ticket or case reference"),
          "duration-minutes": number(
            `Minutes until access expires; defaults to ${OPERATOR_ACCESS_DEFAULT_MINUTES}, at most ${OPERATOR_ACCESS_MAXIMUM_MINUTES}`,
          ),
        },
      }),
      "access-close": action({
        summary: "Close your operator access to an organization",
        method: "DELETE",
        path: organizationAccessPath,
        scope: "none",
        output: "detail",
        args: { "organization-id": organizationId },
      }),
      "access-show": action({
        summary: "Show your operator access to an organization",
        method: "GET",
        path: organizationAccessPath,
        scope: "none",
        output: "detail",
        args: { "organization-id": organizationId },
      }),
      "access-list": {
        ...list(
          "/v1/system/operator-access",
          "none",
          "List open operator access across the install",
          pagination,
        ),
        args: { "organization-id": text("Only access to this organization", "query") },
        columns: ["organizationId", "principalId", "expiresAt", "reason", "ticket"],
      },
    },
  },
  "system-people": {
    summary: "Find a person and act on their sign-in, for platform administrators",
    namespace: { name: "system", command: "people" },
    actions: {
      find: action({
        summary: "Find the person or pending sign-up holding an email; matches the whole address",
        method: "GET",
        path: "/v1/system/principals",
        scope: "none",
        output: "detail",
        args: { email: requiredText("The whole email address", "query") },
      }),
      show: action({
        summary: "Show a person's organizations, multi-factor state, and session counts",
        method: "GET",
        path: principalPath,
        scope: "none",
        output: "detail",
        args: { "principal-id": principalId },
      }),
      events: {
        ...list(
          `${principalPath}/security-events`,
          "none",
          "List a person's security events, newest first; secret fields are withheld",
          pagination,
        ),
        args: { "principal-id": principalId },
        columns: ["occurredAt", "eventType", "actor", "details"],
      },
      "revoke-sessions": action({
        summary: "End every session, refresh token, and device grant without disabling the person",
        method: "POST",
        path: `${principalPath}/sessions/revoke`,
        scope: "none",
        output: "detail",
        args: {
          "principal-id": principalId,
          reason: requiredText("Why the sessions end; recorded in the person's security events"),
        },
        destructive: true,
      }),
      "resend-verification": action({
        summary: "Resend a pending sign-up's verification email, under the self-service limits",
        method: "POST",
        path: `${principalPath}/verification-email`,
        scope: "none",
        output: "detail",
        args: {
          "principal-id": principalId,
          email: text("The email the sign-up waits on, from `system people find`"),
          reason: requiredText("Why the email is resent; recorded in the person's security events"),
        },
      }),
    },
  },
};
