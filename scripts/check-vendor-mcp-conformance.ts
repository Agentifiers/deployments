/**
 * Live conformance check for vendor-hosted MCP pins.
 *
 * Runs the production authorization discovery (`discoverMcpAuthorization` with the exact
 * `vendorMcpDiscoveryInput`) against every configured `vendor_mcp` OAuth provider and
 * reports drift from the code-owned pins. Network-dependent; not part of `bun test`.
 *
 * Usage: bun run vendor-mcp:conformance [providerKey ...]
 */
import { discoverMcpAuthorization } from "@deployments-ai/mcp-client";
import {
  codeProviderDefinitionRegistry,
  vendorMcpAuthorizationDrift,
  vendorMcpCanonicalUrl,
  vendorMcpDiscoveryInput,
  vendorMcpServer,
  vendorMcpSubstitute,
  type ProviderDefinition,
} from "@deployments-ai/providers";

/** Public tenants used to exercise templated servers (vendor demo or support instances). */
const CONFORMANCE_TENANTS: Readonly<Record<string, string>> = {
  bamboohr: "demo",
  servicenow: "hi",
};

const CONCURRENCY = 12;

interface ConformanceResult {
  readonly drift: readonly string[];
  readonly key: string;
  readonly skipped?: string;
}

async function check(definition: ProviderDefinition): Promise<ConformanceResult> {
  const server = vendorMcpServer(definition);
  if (server.authorization.kind !== "oauth") {
    return { drift: [], key: definition.key, skipped: "api_key authorization" };
  }
  let canonicalUrl: string;
  if (server.tenant) {
    const tenant = CONFORMANCE_TENANTS[definition.key];
    if (!tenant) return { drift: [], key: definition.key, skipped: "no conformance tenant" };
    canonicalUrl = vendorMcpCanonicalUrl(definition, vendorMcpSubstitute(server.url, tenant));
  } else {
    canonicalUrl = vendorMcpCanonicalUrl(definition);
  }
  try {
    const discovered = await discoverMcpAuthorization({
      ...vendorMcpDiscoveryInput(definition, canonicalUrl),
      timeoutMs: 15_000,
    });
    return {
      drift: vendorMcpAuthorizationDrift(definition, canonicalUrl, discovered),
      key: definition.key,
    };
  } catch (error) {
    return {
      drift: [`discovery failed: ${error instanceof Error ? error.message : String(error)}`],
      key: definition.key,
    };
  }
}

const requested = new Set(process.argv.slice(2));
const definitions = codeProviderDefinitionRegistry()
  .list()
  .filter(
    (definition) =>
      definition.route === "vendor_mcp" &&
      (definition.status === "configured" || definition.status === "verified") &&
      (requested.size === 0 || requested.has(definition.key)),
  );

const results: ConformanceResult[] = [];
for (let index = 0; index < definitions.length; index += CONCURRENCY) {
  results.push(...(await Promise.all(definitions.slice(index, index + CONCURRENCY).map(check))));
}

let failures = 0;
for (const result of results.toSorted((left, right) => left.key.localeCompare(right.key))) {
  if (result.skipped) {
    console.log(`skip  ${result.key}: ${result.skipped}`);
  } else if (result.drift.length === 0) {
    console.log(`ok    ${result.key}`);
  } else {
    failures += 1;
    console.log(`drift ${result.key}`);
    for (const entry of result.drift) console.log(`      - ${entry}`);
  }
}
console.log(`${results.length} vendor MCP providers checked, ${failures} drifted.`);
if (failures > 0) process.exitCode = 1;
