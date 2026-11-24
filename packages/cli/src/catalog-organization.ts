import { OPERATIONAL_RECORD_PAGE_LIMIT } from "@deployments-ai/api-contract";
import { TENANCY_PATHS } from "@deployments-ai/api-contract/routes";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  csv,
  description,
  flag,
  id,
  json,
  lifecycleAction,
  list,
  mutate,
  name,
  reason,
  requiredCsv,
  requiredText,
  sensitive,
  show,
  text,
  requiredNumber,
} from "./catalog-helpers.ts";
import { CliError, ExitCode } from "./errors.ts";

const tenancyPagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;
const administrationPagination = {
  limitField: "limit",
  maxLimit: 100,
  target: "query",
} as const;
const expectedVersion = {
  ...requiredNumber("Expected resource version"),
  bodyField: "expectedVersion",
};

function connectionGrantBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { allWorkspaces, ...fields } = body;
  if (allWorkspaces !== true) {
    if (fields.workspaceId === undefined) {
      throw new CliError("Provide --workspace or --all-workspaces.", ExitCode.usage);
    }
    return fields;
  }
  if (fields.workspaceId !== undefined) {
    throw new CliError("Choose either --workspace or --all-workspaces.", ExitCode.usage);
  }
  return { ...fields, workspaceId: null };
}

export const organizationCommandCatalog: CommandCatalog = {
  account: {
    summary: "Current platform account",
    actions: {
      show: action({
        summary: "Show the current account",
        method: "GET",
        path: "/v1/account",
        scope: "none",
        output: "detail",
      }),
    },
  },
  org: {
    summary: "Organizations and tenancy",
    actions: {
      list: list(TENANCY_PATHS.organizations, "none", "List organizations", tenancyPagination),
      show: show(TENANCY_PATHS.organizations, "organization", "Show an organization"),
      create: create(
        TENANCY_PATHS.organizations,
        "none",
        { name, slug: text("URL-safe organization slug") },
        "Create an organization",
      ),
      update: mutate(
        "PATCH",
        TENANCY_PATHS.organizations,
        "organization",
        "Update an organization",
        {
          id,
          name: text("New organization name"),
          slug: text("New organization slug"),
        },
      ),
      limits: action({
        summary:
          "Show the request rate, concurrent run, and sandbox limits the organization runs under",
        method: "GET",
        path: `${TENANCY_PATHS.organizations}/:id/limits`,
        scope: "organization",
        output: "detail",
        args: { id },
      }),
      standing: action({
        summary:
          "Show whether the organization is suspended, why, and the limits and model spend ceiling it runs under",
        method: "GET",
        path: `${TENANCY_PATHS.organizations}/:id/standing`,
        scope: "organization",
        output: "detail",
        args: { id },
      }),
      spend: action({
        summary:
          "Show a month's spend split into operator-funded and organization-funded, with the operator-funded ceiling",
        method: "GET",
        path: `${TENANCY_PATHS.organizations}/:id/spend`,
        scope: "organization",
        output: "detail",
        args: { id, month: text("UTC month as YYYY-MM; defaults to the current month", "query") },
      }),
      "project-spend": action({
        summary:
          "Show a month's spend for each project, split into operator-funded and organization-funded",
        method: "GET",
        path: `${TENANCY_PATHS.organizations}/:id/spend/projects`,
        scope: "organization",
        output: "detail",
        args: { id, month: text("UTC month as YYYY-MM; defaults to the current month", "query") },
      }),
    },
  },
  member: {
    summary: "Organization members and roles",
    actions: {
      list: list("/v1/members", "organization", "List organization members", tenancyPagination),
      add: create(
        "/v1/members",
        "organization",
        {
          "principal-id": {
            ...requiredText("Human principal ID"),
            bodyField: "principalId",
          },
          role: requiredText("Organization role"),
        },
        "Add an organization member",
      ),
      update: mutate("PATCH", "/v1/members", "organization", "Update a member role", {
        id,
        role: requiredText("Organization role"),
      }),
      remove: mutate("DELETE", "/v1/members", "organization", "Remove an organization member"),
    },
  },
  invitation: {
    summary: "Organization invitations",
    actions: {
      list: list("/v1/invitations", "organization", "List pending invitations", tenancyPagination),
      create: sensitive(
        create(
          "/v1/invitations",
          "organization",
          {
            email: requiredText("Invitee email"),
            role: requiredText("Organization role"),
            "expires-at": {
              ...text("Invitation expiration timestamp"),
              bodyField: "expiresAt",
            },
          },
          "Create an invitation",
        ),
        ["token"],
      ),
      revoke: mutate("DELETE", "/v1/invitations", "organization", "Revoke an invitation"),
      accept: action({
        summary: "Accept an invitation",
        method: "POST",
        path: "/v1/invitations/:id/accept",
        scope: "none",
        output: "action",
        args: {
          id,
          token: text("Invitation token (prefer env or file source)"),
          "token-env": text("Environment variable containing the invitation token", "control"),
          "token-file": text("File containing the invitation token", "control"),
        },
        secretInputs: [
          {
            directArgument: "token",
            environmentArgument: "token-env",
            fileArgument: "token-file",
            bodyField: "token",
            required: true,
          },
        ],
      }),
    },
  },
  project: {
    summary: "Projects",
    actions: {
      create: create(
        TENANCY_PATHS.projects,
        "organization",
        { name, slug: text("URL-safe project slug") },
        "Create a project",
      ),
      list: list(TENANCY_PATHS.projects, "organization", "List projects", tenancyPagination),
      show: show(TENANCY_PATHS.projects, "project", "Show a project"),
      update: mutate("PATCH", TENANCY_PATHS.projects, "project", "Update a project", {
        id,
        name: text("New project name"),
        slug: text("New project slug"),
      }),
      archive: mutate("DELETE", TENANCY_PATHS.projects, "project", "Archive a project"),
    },
  },
  env: {
    summary: "Project environments",
    actions: {
      create: create(
        TENANCY_PATHS.environments,
        "project",
        {
          name,
          slug: text("URL-safe environment slug"),
          type: requiredText("development, staging, production, or custom"),
        },
        "Create an environment",
      ),
      list: list(TENANCY_PATHS.environments, "project", "List environments", tenancyPagination),
      show: show(TENANCY_PATHS.environments, "environment", "Show an environment"),
      update: mutate("PATCH", TENANCY_PATHS.environments, "environment", "Update an environment", {
        id,
        name: text("New environment name"),
        slug: text("New environment slug"),
      }),
      archive: mutate(
        "DELETE",
        TENANCY_PATHS.environments,
        "environment",
        "Archive an environment",
      ),
    },
  },
  workspace: {
    summary: "Environment workspaces",
    actions: {
      create: create(
        TENANCY_PATHS.workspaces,
        "environment",
        { name, description, slug: text("URL-safe workspace slug") },
        "Create a workspace",
      ),
      list: list(TENANCY_PATHS.workspaces, "environment", "List workspaces", tenancyPagination),
      show: show(TENANCY_PATHS.workspaces, "environment", "Show a workspace"),
      update: mutate("PATCH", TENANCY_PATHS.workspaces, "environment", "Update a workspace", {
        id,
        name: text("New workspace name"),
        description: text("New workspace description"),
        slug: text("New workspace slug"),
      }),
      archive: mutate("DELETE", TENANCY_PATHS.workspaces, "environment", "Archive a workspace"),
      spend: action({
        summary:
          "Show a workspace's spend for a month, split into operator-funded and organization-funded",
        method: "GET",
        path: `${TENANCY_PATHS.workspaces}/:id/spend`,
        scope: "environment",
        output: "detail",
        args: { id, month: text("UTC month as YYYY-MM; defaults to the current month", "query") },
      }),
    },
  },
  "service-account": {
    summary: "Machine identities",
    actions: {
      create: create(
        TENANCY_PATHS.serviceAccounts,
        "environment",
        { name, description, scopes: requiredCsv("Capability scopes") },
        "Create a service account",
      ),
      list: list(
        TENANCY_PATHS.serviceAccounts,
        "environment",
        "List service accounts",
        tenancyPagination,
      ),
      show: show(TENANCY_PATHS.serviceAccounts, "environment", "Show a service account"),
      revoke: mutate(
        "DELETE",
        TENANCY_PATHS.serviceAccounts,
        "environment",
        "Revoke a service account",
      ),
    },
  },
  "api-key": {
    summary: "Environment-scoped API credentials",
    actions: {
      create: sensitive(
        create(
          TENANCY_PATHS.apiCredentials,
          "environment",
          {
            name,
            "service-account": {
              ...requiredText("Owning service account ID"),
              bodyField: "serviceAccountId",
            },
            scopes: csv("Capability scopes"),
            expires: { ...text("Expiration timestamp"), bodyField: "expiresAt" },
          },
          "Create an API key",
        ),
      ),
      list: list(TENANCY_PATHS.apiCredentials, "environment", "List API keys", tenancyPagination),
      usage: action({
        summary: "List API-key request activity",
        method: "GET",
        path: "/v1/api-key-usage",
        scope: "environment",
        output: "list",
        pagination: {
          limitField: "limit",
          maxLimit: OPERATIONAL_RECORD_PAGE_LIMIT,
          target: "query",
        },
        args: {
          "api-credential": {
            ...text("API credential ID", "query"),
            field: "apiCredentialId",
          },
          since: text("Start timestamp", "query"),
          until: text("End timestamp", "query"),
        },
      }),
      rotate: sensitive(
        lifecycleAction(
          TENANCY_PATHS.apiCredentials,
          "rotate",
          "environment",
          "Rotate an API key",
          { id, reason },
          true,
        ),
      ),
      revoke: mutate("DELETE", TENANCY_PATHS.apiCredentials, "environment", "Revoke an API key"),
    },
  },
  provider: {
    summary: "Provider catalog",
    actions: {
      list: list("/v1/providers", "none", "List supported providers", administrationPagination),
      show: show("/v1/providers", "none", "Show provider capabilities"),
    },
  },
  "oauth-app": {
    summary: "Subscriber-owned OAuth applications",
    actions: {
      register: action({
        ...create(
          "/v1/oauth-apps",
          "environment",
          {
            name: { ...name, bodyField: "displayName" },
            provider: { ...requiredText("Provider key"), bodyField: "providerKey" },
            "client-id": { ...requiredText("OAuth client ID"), bodyField: "clientId" },
            "client-secret": text("OAuth client secret (prefer env or file source)"),
            "client-secret-env": text(
              "Environment variable containing the client secret",
              "control",
            ),
            "client-secret-file": text("File containing the client secret", "control"),
            credential: text(
              "Provider-specific OAuth credential JSON (prefer env or file source)",
              "control",
            ),
            "credential-env": text(
              "Environment variable containing provider-specific OAuth credential JSON",
              "control",
            ),
            "credential-file": text(
              "File containing provider-specific OAuth credential JSON",
              "control",
            ),
            registration: {
              ...json(
                'Vendor MCP pre-registration, e.g. {"method":"pre_registered","tokenEndpointAuthMethod":"none"}',
              ),
              bodyField: "registration",
            },
            scopes: { ...requiredCsv("Provider scopes"), bodyField: "requestedScopes" },
            "redirect-uri": {
              ...requiredCsv("Configured callback URLs"),
              bodyField: "redirectUris",
            },
          },
          "Register an OAuth application",
        ),
        secretInputs: [
          {
            directArgument: "client-secret",
            environmentArgument: "client-secret-env",
            fileArgument: "client-secret-file",
            bodyField: "clientSecret",
            required: false,
          },
          {
            directArgument: "credential",
            environmentArgument: "credential-env",
            fileArgument: "credential-file",
            bodyField: "credential",
            format: "json",
            required: false,
          },
        ],
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "key", "plaintext"],
      }),
      list: list(
        "/v1/oauth-apps",
        "environment",
        "List OAuth applications",
        administrationPagination,
      ),
      show: show("/v1/oauth-apps", "environment", "Show an OAuth application"),
      rotate: action({
        ...lifecycleAction(
          "/v1/oauth-apps",
          "rotate",
          "environment",
          "Rotate an OAuth client secret",
          {
            id,
            "expected-version": expectedVersion,
            "client-secret": text("New OAuth client secret (prefer env or file source)"),
            "client-secret-env": text(
              "Environment variable containing the new client secret",
              "control",
            ),
            "client-secret-file": text("File containing the new client secret", "control"),
            credential: text(
              "Replacement provider-specific OAuth credential JSON (prefer env or file source)",
              "control",
            ),
            "credential-env": text(
              "Environment variable containing replacement OAuth credential JSON",
              "control",
            ),
            "credential-file": text("File containing replacement OAuth credential JSON", "control"),
          },
          true,
        ),
        secretInputs: [
          {
            directArgument: "client-secret",
            environmentArgument: "client-secret-env",
            fileArgument: "client-secret-file",
            bodyField: "clientSecret",
            required: true,
          },
          {
            directArgument: "credential",
            environmentArgument: "credential-env",
            fileArgument: "credential-file",
            bodyField: "credential",
            format: "json",
            required: false,
          },
        ],
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "key", "plaintext"],
      }),
      archive: mutate("DELETE", "/v1/oauth-apps", "environment", "Archive an OAuth application"),
    },
  },
  credential: {
    summary: "Static provider credentials",
    actions: {
      create: action({
        ...create(
          "/v1/credentials",
          "environment",
          {
            name: { ...name, bodyField: "displayName" },
            provider: { ...requiredText("Provider key"), bodyField: "providerKey" },
            credential: text("Credential bundle (prefer env or file source)"),
            "credential-env": text("Environment variable containing the credential", "control"),
            "credential-file": text("File containing the credential", "control"),
            metadata: json("Non-secret provider metadata"),
            resource: {
              ...text("Vendor MCP tenant endpoint for a templated server URL"),
              bodyField: "requestedResource",
            },
          },
          "Register a static provider credential",
        ),
        secretInputs: [
          {
            directArgument: "credential",
            environmentArgument: "credential-env",
            fileArgument: "credential-file",
            bodyField: "credential",
            format: "json-or-text",
            required: true,
            optionalWhen: {
              argument: "provider",
              equals: "extension_callback",
            },
          },
        ],
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "key", "plaintext"],
      }),
      list: list(
        "/v1/credentials",
        "environment",
        "List provider credentials",
        administrationPagination,
      ),
      rotate: action({
        ...lifecycleAction(
          "/v1/credentials",
          "rotate",
          "environment",
          "Rotate a provider credential",
          {
            id,
            "expected-version": expectedVersion,
            credential: text("Replacement credential (prefer env or file source)"),
            "credential-env": text(
              "Environment variable containing the replacement credential",
              "control",
            ),
            "credential-file": text("File containing the replacement credential", "control"),
          },
          true,
        ),
        secretInputs: [
          {
            directArgument: "credential",
            environmentArgument: "credential-env",
            fileArgument: "credential-file",
            bodyField: "credential",
            format: "json-or-text",
            required: true,
          },
        ],
        sensitiveOutput: true,
        sensitiveOutputFields: ["value", "key", "plaintext"],
      }),
      revoke: mutate("DELETE", "/v1/credentials", "environment", "Revoke a provider credential"),
    },
  },
  connection: {
    summary: "Provider connections and verification",
    actions: {
      authorize: create(
        "/v1/connections",
        "environment",
        {
          provider: { ...requiredText("Provider key"), bodyField: "providerKey" },
          "oauth-app": {
            ...text("OAuth application registration ID"),
            bodyField: "providerApplicationId",
          },
          resource: {
            ...text("Provider account or external resource to authorize"),
            bodyField: "requestedResource",
          },
          "return-url": {
            ...text(
              "https URL on an allowlisted return origin (PLATFORM_OAUTH_RETURN_ORIGINS); the callback redirects there with connection_id and provider, or error",
            ),
            bodyField: "returnTo",
          },
        },
        "Start provider authorization",
      ),
      list: list(
        "/v1/connections",
        "environment",
        "List provider connections",
        administrationPagination,
      ),
      show: show("/v1/connections", "environment", "Show a provider connection"),
      verify: lifecycleAction(
        "/v1/connections",
        "verify",
        "environment",
        "Verify a provider connection",
        { id },
      ),
      revoke: mutate("DELETE", "/v1/connections", "environment", "Revoke a provider connection"),
      "tools-sync": action({
        summary: "Sync vendor MCP tools for a provider connection",
        method: "POST",
        path: "/v1/connections/:connectionId/tools/sync",
        scope: "environment",
        output: "action",
        args: { id: { ...id, field: "connectionId" } },
        idempotent: true,
      }),
    },
  },
  grant: {
    summary: "Agent connection grants",
    actions: {
      create: {
        ...create(
          "/v1/connection-grants",
          "environment",
          {
            "all-workspaces": flag("Grant the connection to every workspace in the environment"),
            connection: { ...requiredText("Provider connection ID"), bodyField: "connectionId" },
            constraints: {
              ...json("External resource constraints"),
              bodyField: "externalResourceConstraints",
            },
            purpose: requiredText("Authorization purpose"),
            scopes: requiredCsv("Granted connection scopes"),
            workspace: { ...text("Workspace ID"), bodyField: "workspaceId" },
          },
          "Grant a connection to an agent",
        ),
        shapeBody: connectionGrantBody,
      },
      list: list(
        "/v1/connection-grants",
        "environment",
        "List connection grants",
        administrationPagination,
      ),
      show: show("/v1/connection-grants", "environment", "Show a connection grant"),
      revoke: mutate("DELETE", "/v1/connection-grants", "environment", "Revoke a connection grant"),
    },
  },
  verification: {
    summary: "Connection verification results",
    actions: {
      show: show("/v1/connection-verifications", "environment", "Show a connection verification"),
    },
  },
  capability: {
    summary: "Verified connection capabilities",
    actions: {
      list: action({
        summary: "List connection capabilities",
        method: "GET",
        path: "/v1/connections/:id/capabilities",
        scope: "environment",
        output: "list",
        listField: "items",
        args: { id },
        pagination: administrationPagination,
      }),
    },
  },
};
