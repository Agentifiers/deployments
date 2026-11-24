import { describe, expect, test } from "bun:test";

import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";

import { platformToolAdapterDefinitions, type ToolAdapterDefinition } from "./index.ts";

type ArchiveReason =
  | "explicitly_archived"
  | "not_in_provider_allowlist"
  | "provider_missing"
  | `provider_status_${string}`
  | "scope_mismatch";

function archiveReason(definition: ToolAdapterDefinition): ArchiveReason {
  if (!definition.provider) return "explicitly_archived";
  const provider = codeProviderDefinitionRegistry().resolve(definition.provider);
  if (!provider) return "provider_missing";
  if (provider.status !== "configured" && provider.status !== "verified") {
    return `provider_status_${provider.status}`;
  }
  if (!provider.tools.includes(definition.toolName)) return "not_in_provider_allowlist";
  const registeredScopes = new Set([...provider.authorizationScopes, ...provider.defaultScopes]);
  const requiredScopes = [
    ...(definition.authorizationScopes ?? []),
    ...(definition.requiredScopes ?? []),
  ];
  return requiredScopes.some((scope) => !registeredScopes.has(scope))
    ? "scope_mismatch"
    : "explicitly_archived";
}

function archivedByProvider(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const definition of platformToolAdapterDefinitions) {
    if (definition.status !== "archived") continue;
    (grouped[definition.provider ?? "(none)"] ??= []).push(
      `${definition.toolName}: ${archiveReason(definition)}`,
    );
  }
  return Object.fromEntries(
    Object.keys(grouped)
      .sort()
      .map((provider) => [provider, [...(grouped[provider] ?? [])].sort()]),
  );
}

const ACTIVATED_PROVIDER_WRITES = [
  "demio.event.registration.create",
  "firehose.rules.create",
  "mailchimp.campaigns.create",
  "mailchimp.campaigns.send",
  "microsoft_teams.post_message",
  "plivo.messages.send",
  "postmark.email.send",
  "sendgrid.email.send",
  "shopify.fulfillments.create",
  "shopify.inventory.adjust",
  "strapi.documents.create",
  "twilio.messages.send",
] as const;

describe("archived tool catalog", () => {
  test("pins every archived tool by provider with its archive reason", () => {
    expect(
      platformToolAdapterDefinitions.filter((definition) => definition.status === "archived"),
    ).toHaveLength(45);
    expect(archivedByProvider()).toEqual({
      "(none)": [
        "provider.api.read: explicitly_archived",
        "provider.api.write: explicitly_archived",
      ],
      audiencetap: [
        "audiencetap.audiences.list: provider_status_unsupported",
        "audiencetap.campaigns.list: provider_status_unsupported",
      ],
      bitbucket: [
        "bitbucket.issues.create: provider_status_planned",
        "bitbucket.issues.list: provider_status_planned",
        "bitbucket.pipelines.list: provider_status_planned",
        "bitbucket.pull_requests.create: provider_status_planned",
        "bitbucket.pull_requests.list: provider_status_planned",
        "bitbucket.repository.read: provider_status_planned",
      ],
      linkedin_ads: [
        "linkedin_ads.accounts.list: provider_status_unsupported",
        "linkedin_ads.campaigns.create: provider_status_unsupported",
      ],
      microsoft_dynamics_365: [
        "microsoft_dynamics.records.create: provider_status_planned",
        "microsoft_dynamics.records.get: provider_status_planned",
        "microsoft_dynamics.records.search: provider_status_planned",
        "microsoft_dynamics.records.update: provider_status_planned",
      ],
      microsoft_outlook: [
        "microsoft_outlook.drafts.create: provider_status_planned",
        "microsoft_outlook.events.create: provider_status_planned",
        "microsoft_outlook.events.list: provider_status_planned",
        "microsoft_outlook.messages.get: provider_status_planned",
        "microsoft_outlook.messages.reply: provider_status_planned",
        "microsoft_outlook.messages.search: provider_status_planned",
        "microsoft_outlook.messages.send: provider_status_planned",
      ],
      microsoft_sharepoint: [
        "microsoft_sharepoint.drives.list: provider_status_planned",
        "microsoft_sharepoint.files.list: provider_status_planned",
        "microsoft_sharepoint.files.upload: provider_status_planned",
        "microsoft_sharepoint.sites.search: provider_status_planned",
      ],
      netsuite: [
        "netsuite.records.create: provider_status_planned",
        "netsuite.records.get: provider_status_planned",
        "netsuite.records.list: provider_status_planned",
        "netsuite.records.update: provider_status_planned",
        "netsuite.suiteql.query: provider_status_planned",
      ],
      onedrive: [
        "onedrive.files.get: provider_status_planned",
        "onedrive.files.list: provider_status_planned",
        "onedrive.files.search: provider_status_planned",
        "onedrive.files.upload: provider_status_planned",
        "onedrive.permissions.create: provider_status_planned",
      ],
      quickbooks: [
        "quickbooks.customers.search: provider_status_planned",
        "quickbooks.invoice.create: provider_status_planned",
        "quickbooks.reports.read: provider_status_planned",
      ],
      zendesk: [
        "zendesk.ticket_reply.create: provider_status_planned",
        "zendesk.tickets.create: provider_status_planned",
        "zendesk.tickets.get: provider_status_planned",
        "zendesk.tickets.search: provider_status_planned",
        "zendesk.tickets.update: provider_status_planned",
      ],
    });
  });

  test("archived tools always default to deny", () => {
    for (const definition of platformToolAdapterDefinitions) {
      if (definition.status === "archived") expect(definition.defaultPolicyAction).toBe("deny");
    }
  });

  test("activated provider writes stay approval-gated outbound mutations", () => {
    expect(
      platformToolAdapterDefinitions
        .filter(
          (definition) =>
            definition.provider !== undefined &&
            definition.effect === "write" &&
            definition.status === "active",
        )
        .map((definition) => definition.toolName)
        .sort(),
    ).toEqual([...ACTIVATED_PROVIDER_WRITES]);
    for (const toolName of ACTIVATED_PROVIDER_WRITES) {
      expect(
        platformToolAdapterDefinitions.find((definition) => definition.toolName === toolName),
      ).toMatchObject({
        defaultPolicyAction: "require_approval",
        effect: "write",
        providerOutboundMutation: true,
        status: "active",
      });
    }
  });
});
