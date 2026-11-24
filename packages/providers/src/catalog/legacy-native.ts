import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import {
  basicAuth,
  oauthScopesVerification,
  platformApiCredentialDefinition,
  platformOAuthDefinition,
} from "./shared.ts";

type OAuthDescriptor = {
  readonly aliases?: readonly string[];
  readonly apiHosts: readonly string[];
  readonly category: string;
  readonly displayName: string;
  readonly key: string;
  readonly oauthProviderKey: string;
  readonly scopes: readonly string[];
  readonly tools: readonly string[];
};

function oauthProvider(descriptor: OAuthDescriptor): ProviderDefinitionInput {
  return platformOAuthDefinition({
    ...(descriptor.aliases ? { aliases: descriptor.aliases } : {}),
    apiHosts: descriptor.apiHosts,
    authorizationScopes: descriptor.scopes,
    category: descriptor.category,
    defaultScopes: descriptor.scopes,
    displayName: descriptor.displayName,
    key: descriptor.key,
    oauthProviderKey: descriptor.oauthProviderKey,
    status: "planned",
    supportsMultipleAccounts: true,
    tools: descriptor.tools,
    verification: oauthScopesVerification(
      `Confirm ${descriptor.displayName} OAuth scopes cover the registered tools.`,
    ),
  });
}

const OAUTH_PROVIDERS: readonly OAuthDescriptor[] = [
  {
    key: "bitbucket",
    displayName: "Bitbucket",
    category: "engineering",
    oauthProviderKey: "bitbucket",
    apiHosts: ["api.bitbucket.org"],
    scopes: ["repository", "pullrequest", "issue", "pipeline", "pullrequest:write", "issue:write"],
    tools: [
      "bitbucket.repository.read",
      "bitbucket.pull_requests.list",
      "bitbucket.pull_requests.create",
      "bitbucket.issues.list",
      "bitbucket.issues.create",
      "bitbucket.pipelines.list",
    ],
  },
  {
    key: "netsuite",
    displayName: "NetSuite",
    category: "business",
    oauthProviderKey: "netsuite",
    apiHosts: ["suitetalk.api.netsuite.com"],
    scopes: [],
    tools: [
      "netsuite.suiteql.query",
      "netsuite.records.list",
      "netsuite.records.get",
      "netsuite.records.create",
      "netsuite.records.update",
    ],
  },
  {
    key: "microsoft_outlook",
    displayName: "Microsoft Outlook",
    category: "communication",
    oauthProviderKey: "microsoft",
    apiHosts: ["graph.microsoft.com"],
    scopes: ["Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.Read", "Calendars.ReadWrite"],
    tools: [
      "microsoft_outlook.messages.search",
      "microsoft_outlook.messages.get",
      "microsoft_outlook.drafts.create",
      "microsoft_outlook.messages.send",
      "microsoft_outlook.messages.reply",
      "microsoft_outlook.events.list",
      "microsoft_outlook.events.create",
    ],
  },
  {
    key: "microsoft_sharepoint",
    displayName: "Microsoft SharePoint",
    category: "data",
    oauthProviderKey: "microsoft",
    apiHosts: ["graph.microsoft.com"],
    scopes: ["Sites.Read.All", "Sites.ReadWrite.All"],
    tools: [
      "microsoft_sharepoint.sites.search",
      "microsoft_sharepoint.drives.list",
      "microsoft_sharepoint.files.list",
      "microsoft_sharepoint.files.upload",
    ],
  },
  {
    key: "onedrive",
    displayName: "OneDrive",
    category: "data",
    oauthProviderKey: "microsoft",
    apiHosts: ["graph.microsoft.com"],
    scopes: ["Files.Read.All", "Files.ReadWrite.All"],
    tools: [
      "onedrive.files.list",
      "onedrive.files.search",
      "onedrive.files.get",
      "onedrive.files.upload",
      "onedrive.permissions.create",
    ],
  },
  {
    key: "microsoft_dynamics_365",
    displayName: "Microsoft Dynamics 365",
    category: "revenue",
    oauthProviderKey: "microsoft",
    apiHosts: ["dynamics.com", "microsoft.com"],
    scopes: ["user_impersonation"],
    tools: [
      "microsoft_dynamics.records.search",
      "microsoft_dynamics.records.get",
      "microsoft_dynamics.records.create",
      "microsoft_dynamics.records.update",
    ],
  },
  {
    key: "quickbooks",
    displayName: "QuickBooks",
    category: "finance",
    oauthProviderKey: "intuit",
    apiHosts: ["quickbooks.api.intuit.com", "sandbox-quickbooks.api.intuit.com"],
    scopes: ["read", "write"],
    tools: ["quickbooks.reports.read", "quickbooks.customers.search", "quickbooks.invoice.create"],
  },
  {
    key: "zendesk",
    displayName: "Zendesk",
    category: "support",
    oauthProviderKey: "zendesk",
    apiHosts: ["zendesk.com"],
    scopes: ["read", "write"],
    tools: [
      "zendesk.tickets.search",
      "zendesk.tickets.get",
      "zendesk.tickets.create",
      "zendesk.tickets.update",
      "zendesk.ticket_reply.create",
    ],
  },
];

const STATIC_PROVIDERS: readonly ProviderDefinitionInput[] = [
  platformApiCredentialDefinition({
    key: "snowflake",
    displayName: "Snowflake",
    category: "data",
    apiHosts: ["snowflakecomputing.com"],
    auth: (() => {
      const base = basicAuth();
      return Object.freeze({
        ...base,
        fields: Object.freeze([
          ...(base.fields ?? []),
          Object.freeze({
            key: "accountUrl",
            displayName: "Account URL",
            sensitive: false,
            required: true,
            displayFormat: "none" as const,
          }),
        ]),
        requestFieldKeys: Object.freeze(["accountUrl"]),
      });
    })(),
    originPolicy: Object.freeze({ fieldKey: "accountUrl", hostMatch: "suffix" }),
    status: "configured",
    supportsMultipleAccounts: true,
    tools: ["snowflake.catalog.list", "snowflake.query.execute", "snowflake.statements.get"],
    verification: {
      required: true,
      method: "api_probe",
      description:
        "Run a read-only account query to confirm the Snowflake account URL and credential.",
      probe: {
        body: JSON.stringify({
          statement: "SELECT CURRENT_ACCOUNT() AS account_name",
          timeout: 20,
        }),
        expectedStatusCodes: [200, 202],
        headers: { "content-type": "application/json" },
        method: "POST",
        path: "/api/v2/statements",
      },
    },
  }),
];

export const LEGACY_NATIVE_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([...OAUTH_PROVIDERS.map(oauthProvider), ...STATIC_PROVIDERS]);
