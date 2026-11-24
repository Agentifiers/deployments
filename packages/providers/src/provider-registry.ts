/**
 * Code-owned provider definition registry.
 *
 * Definitions describe first-class platform providers (route, auth field schema,
 * hosts, scopes, tools, lifecycle). They never carry secret values and are not
 * projected at process startup — callers opt in via
 * `syncCodeProviderDefinitionRegistry`.
 *
 * Initial read/connect providers are configured here with conservative tool
 * allowlists. Routed catalog definitions are appended below so this is the
 * actual provider registry consumed by callers.
 */

import { createHash } from "node:crypto";

import {
  createProviderDefinitionRegistry,
  type ProviderDefinition,
  type ProviderDefinitionInput,
  type ProviderDefinitionRegistry,
} from "./provider-definitions.ts";
import { ROUTED_PROVIDER_CATALOG_DEFINITION_INPUTS } from "./catalog/catalog.ts";
import { noneAuth } from "./catalog/shared.ts";

const oauthAuth = Object.freeze({ kind: "oauth", fields: Object.freeze([]) });

/**
 * Conservative set of first-class providers. Keys are snake_case; platform OAuth
 * catalog/custom slugs stay kebab-case. Never invent secret defaults.
 */
const PLATFORM_BASE_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] = Object.freeze([
  // ---------------------------------------------------------------------------
  // Platform baseline
  // ---------------------------------------------------------------------------
  Object.freeze({
    key: "microsoft_teams",
    displayName: "Microsoft Teams",
    category: "communication",
    route: "platform_oauth",
    oauthProviderKey: "microsoft",
    auth: oauthAuth,
    apiHosts: Object.freeze(["graph.microsoft.com"]),
    // offline_access yields the refresh token; User.Read backs the /me connection identity.
    authorizationScopes: Object.freeze([
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
      "offline_access",
      "Team.ReadBasic.All",
      "User.Read",
      "User.ReadBasic.All",
    ]),
    defaultScopes: Object.freeze([
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
      "Team.ReadBasic.All",
      "User.ReadBasic.All",
    ]),
    supportsMultipleAccounts: true,
    verification: Object.freeze({
      required: true,
      method: "oauth_scopes",
      description: "Confirm granted Microsoft Graph delegated scopes cover Teams messaging tools.",
    }),
    tools: Object.freeze([
      "microsoft_teams.channels.list",
      "microsoft_teams.messages.list",
      "microsoft_teams.messages.replies",
      "microsoft_teams.post_message",
      "microsoft_teams.teams.list",
      "microsoft_teams.users.lookup",
    ]),
    status: "configured",
  } satisfies ProviderDefinitionInput),
  Object.freeze({
    key: "extension_callback",
    displayName: "Extension Callback",
    category: "automation",
    route: "platform_webhook",
    auth: noneAuth,
    apiHosts: Object.freeze([]),
    defaultScopes: Object.freeze([
      "callback:classification:propose",
      "callback:context:read",
      "callback:draft:propose",
      "callback:intake:propose",
      "callback:knowledge:read",
      "callback:action:execute",
      "callback:action:privileged",
      "callback:task:propose",
      "callback:workflow:coordinate",
    ]),
    supportsMultipleAccounts: true,
    verification: Object.freeze({
      required: false,
      method: "none",
      description:
        "Callback authentication is stored per extension and callback evidence is verified at dispatch.",
    }),
    tools: Object.freeze([]),
    status: "configured",
  } satisfies ProviderDefinitionInput),

  // ---------------------------------------------------------------------------
  // Initial read/connect provider set
  // ---------------------------------------------------------------------------
  Object.freeze({
    key: "google_search_console",
    displayName: "Google Search Console",
    category: "marketing",
    route: "platform_oauth",
    oauthProviderKey: "google",
    aliases: Object.freeze(["search_console", "gsc"]),
    auth: oauthAuth,
    apiHosts: Object.freeze(["searchconsole.googleapis.com"]),
    authorizationScopes: Object.freeze([
      "openid",
      "email",
      "https://www.googleapis.com/auth/webmasters.readonly",
    ]),
    defaultScopes: Object.freeze(["https://www.googleapis.com/auth/webmasters.readonly"]),
    supportsMultipleAccounts: true,
    verification: Object.freeze({
      required: true,
      method: "oauth_scopes",
      description: "Confirm Search Console read scopes and list verified sites.",
    }),
    tools: Object.freeze([
      "google_search_console.performance.query",
      "google_search_console.sites.list",
    ]),
    status: "configured",
  } satisfies ProviderDefinitionInput),
  Object.freeze({
    key: "wordpress",
    displayName: "WordPress",
    category: "marketing",
    route: "platform_api_credential",
    auth: Object.freeze({
      kind: "basic",
      requestFieldKeys: Object.freeze(["baseUrl"]),
      transport: Object.freeze({
        passwordFieldKey: "appPassword",
        type: "basic",
        usernameFieldKey: "username",
      }),
      fields: Object.freeze([
        Object.freeze({
          key: "baseUrl",
          displayName: "Site base URL",
          sensitive: false,
          required: true,
          displayFormat: "none",
          description: "HTTPS origin of the WordPress site (no path/query).",
        }),
        Object.freeze({
          key: "username",
          displayName: "Username",
          sensitive: false,
          required: true,
          displayFormat: "none",
        }),
        Object.freeze({
          key: "appPassword",
          displayName: "Application password",
          sensitive: true,
          required: true,
          displayFormat: "masked",
          description: "WordPress application password. Never store defaults in code.",
        }),
      ]),
    }),
    originPolicy: Object.freeze({
      fieldKey: "baseUrl",
      requireHttps: true,
    }),
    apiHosts: Object.freeze([]),
    defaultScopes: Object.freeze([]),
    supportsMultipleAccounts: true,
    verification: Object.freeze({
      required: true,
      method: "api_probe",
      description:
        "Probe the immutable HTTPS origin with application-password auth; reject private addresses.",
      probe: Object.freeze({
        method: "GET",
        path: "/wp-json/wp/v2/users/me?context=edit",
      }),
    }),
    tools: Object.freeze(["wordpress.pages.list", "wordpress.posts.list"]),
    status: "configured",
  } satisfies ProviderDefinitionInput),
]);

/**
 * Complete code-owned provider input set. Catalog definitions are additive to
 * the platform baseline; `createProviderDefinitionRegistry` remains the
 * duplicate-key guard for both sources.
 */
export const CODE_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] = Object.freeze([
  ...PLATFORM_BASE_PROVIDER_DEFINITION_INPUTS,
  ...ROUTED_PROVIDER_CATALOG_DEFINITION_INPUTS,
]);

let cachedRegistry: ProviderDefinitionRegistry | undefined;

/**
 * Frozen, memoized registry of code-owned provider definitions.
 * Safe to call repeatedly; no I/O or process-level side effects.
 */
export function codeProviderDefinitionRegistry(): ProviderDefinitionRegistry {
  cachedRegistry ??= createProviderDefinitionRegistry(CODE_PROVIDER_DEFINITION_INPUTS);
  return cachedRegistry;
}

export function providerDefinitionCodeVersion(definition: ProviderDefinition): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`;
}

export function providerUsesNoCredential(definition: ProviderDefinition | undefined): boolean {
  return (
    definition?.auth.kind === "none" &&
    definition.verification.required === false &&
    definition.verification.method === "none"
  );
}

export function codeProviderDefinitionVersions(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      codeProviderDefinitionRegistry()
        .list()
        .map((definition) => [definition.key, providerDefinitionCodeVersion(definition)] as const),
    ),
  );
}

/**
 * Minimal store surface used to project the code registry into operational
 * storage. Compatible with `createProviderFoundationStore()`.
 */
export type CodeProviderDefinitionRegistryStore = {
  readonly syncProviderDefinitionRegistry: (input: {
    readonly registry: ProviderDefinitionRegistry;
    readonly codeVersion: string;
    readonly definitionCodeVersions?: Readonly<Record<string, string>>;
    readonly markAbsentAs?: "planned" | "unsupported";
    readonly preserveExistingCodeVersionKeys?: readonly string[];
    readonly registryGeneration?: number;
  }) => Promise<unknown>;
};

export type SyncCodeProviderDefinitionRegistryOptions = {
  readonly codeVersion: string;
  readonly definitionCodeVersions?: Readonly<Record<string, string>>;
  readonly markAbsentAs?: "planned" | "unsupported";
  readonly preserveExistingCodeVersionKeys?: readonly string[];
  readonly registryGeneration?: number;
};

/**
 * Project the code-owned provider registry through a foundation store.
 * Caller supplies `codeVersion`; this helper never runs at startup on its own.
 */
export async function syncCodeProviderDefinitionRegistry(
  store: CodeProviderDefinitionRegistryStore,
  options: SyncCodeProviderDefinitionRegistryOptions,
): Promise<unknown> {
  if (!store || typeof store.syncProviderDefinitionRegistry !== "function") {
    throw new Error("A provider foundation store with syncProviderDefinitionRegistry is required.");
  }
  if (typeof options?.codeVersion !== "string") {
    throw new Error("codeVersion is required.");
  }
  const codeVersion = options.codeVersion.trim();
  if (!codeVersion) {
    throw new Error("codeVersion is required.");
  }

  return store.syncProviderDefinitionRegistry({
    registry: codeProviderDefinitionRegistry(),
    codeVersion,
    ...(options.definitionCodeVersions
      ? { definitionCodeVersions: options.definitionCodeVersions }
      : {}),
    ...(options.markAbsentAs ? { markAbsentAs: options.markAbsentAs } : {}),
    ...(options.preserveExistingCodeVersionKeys
      ? { preserveExistingCodeVersionKeys: options.preserveExistingCodeVersionKeys }
      : {}),
    ...(options.registryGeneration !== undefined
      ? { registryGeneration: options.registryGeneration }
      : {}),
  });
}
