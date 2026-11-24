import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { releaseEntrySource } from "@agentifiers/deployments-sdk/release-entry";
import { clientPackageFingerprint } from "./client-package-fingerprint.ts";
import {
  clientPackageLegalFiles,
  clientPackageMetadata,
  writeClientPackageLegalFiles,
} from "./client-package-metadata.ts";
import { readThirdPartyComponent } from "./client-package-notice.ts";

const root = resolve(import.meta.dir, "..");
const sdkDirectory = resolve(root, "packages/sdk");
const distDirectory = resolve(sdkDirectory, "dist");
const generatedDirectory = resolve(distDirectory, "generated-src");
const packageDirectory = resolve(distDirectory, "package");
const codegenDirectory = resolve(root, "tools/sdk-codegen");

async function run(command: readonly string[]) {
  const child = Bun.spawn([...command], { cwd: root, stderr: "inherit", stdout: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

function generatedOperationNames(source: string): ReadonlySet<string> {
  return new Set(
    Array.from(source.matchAll(/^export const ([A-Za-z0-9_]+) =/gmu), (match) => match[1]!),
  );
}

function replaceExactly(source: string, search: string, replacement: string, file: string): string {
  const occurrences = source.split(search).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected one generated transport hook in ${file}; found ${occurrences}.`);
  }
  return source.replace(search, replacement);
}

function normalizeSchemaForCodegen(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchemaForCodegen);
  if (typeof value !== "object" || value === null) return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeSchemaForCodegen(nested)]),
  );
  if (typeof normalized.type === "string" && Array.isArray(normalized.allOf)) {
    delete normalized.allOf;
  }
  return normalized;
}

await rm(distDirectory, { force: true, recursive: true });
await run([process.execPath, "run", "openapi:write"]);
const openApiPath = resolve(root, "packages/api-contract/dist/openapi.json");
const openApi = await readFile(openApiPath);
const codegenOpenApi = Buffer.from(
  `${JSON.stringify(normalizeSchemaForCodegen(JSON.parse(openApi.toString("utf8"))), null, 2)}\n`,
  "utf8",
);
await mkdir(distDirectory, { recursive: true });
await writeFile(resolve(distDirectory, "codegen-openapi.json"), codegenOpenApi);
await run([
  process.execPath,
  "install",
  "--cwd",
  codegenDirectory,
  "--frozen-lockfile",
  "--save-text-lockfile",
]);
await run([process.execPath, "run", "--cwd", codegenDirectory, "generate"]);

const sdkSourcePath = resolve(generatedDirectory, "sdk.gen.ts");
const sdkSource = await readFile(sdkSourcePath, "utf8");
const generatedNames = generatedOperationNames(sdkSource);
const contractNames = new Set<string>(PUBLIC_API_ROUTES.map((route) => route.name));
const missing = Array.from(contractNames).filter((name) => !generatedNames.has(name));
const unexpected = Array.from(generatedNames).filter((name) => !contractNames.has(name));
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    `Generated SDK operation drift: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
  );
}

const transportSecuritySource = `function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\\[|\\]$/gu, "").toLowerCase();
  if (normalized === "::1" || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\\d{1,3}$/u.test(octet));
}

function validatePlatformUrl(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Platform API URLs must use HTTP or HTTPS.");
  }
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new TypeError("Platform API requests require HTTPS unless the API host is loopback.");
  }
  if (url.username || url.password) {
    throw new TypeError("Platform API URLs must not contain credentials.");
  }
}

export function validatePlatformBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(\`Invalid platform API URL: \${baseUrl}\`);
  }
  validatePlatformUrl(url);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Platform API URLs must be an origin without a path, query, or fragment.");
  }
  return url;
}

export function securePlatformRequest(request: Request, expectedBaseUrl?: string): Request {
  const requestUrl = new URL(request.url);
  validatePlatformUrl(requestUrl);
  const carriesCredentials =
    request.headers.has("authorization") ||
    request.headers.has("cookie") ||
    request.headers.has("proxy-authorization");
  if (!expectedBaseUrl && carriesCredentials) {
    throw new TypeError("Credential-bearing platform requests require a configured API origin.");
  }
  if (expectedBaseUrl && requestUrl.origin !== validatePlatformBaseUrl(expectedBaseUrl).origin) {
    throw new TypeError("Platform requests must remain on the client's configured API origin.");
  }
  return request.redirect === "error" ? request : new Request(request, { redirect: "error" });
}
`;
const secureClientSource = `import { createClient as createGeneratedClient } from "./client/index.js";
import type { Client, Config } from "./client/index.js";
import { validatePlatformBaseUrl } from "./transport-security.js";

export function createClient(config: Config = {}): Client {
  if (config.baseUrl !== undefined) validatePlatformBaseUrl(config.baseUrl);
  const client = createGeneratedClient({ ...config, redirect: "error" });
  const setGeneratedConfig = client.setConfig;
  client.setConfig = (nextConfig) => {
    if (nextConfig.baseUrl !== undefined) validatePlatformBaseUrl(nextConfig.baseUrl);
    return setGeneratedConfig({ ...nextConfig, redirect: "error" });
  };
  return client;
}
`;
await writeFile(
  resolve(generatedDirectory, "transport-security.ts"),
  transportSecuritySource,
  "utf8",
);
await writeFile(resolve(generatedDirectory, "secure-client.ts"), secureClientSource, "utf8");
await copyFile(
  resolve(sdkDirectory, "src/gateway-throttle.ts"),
  resolve(generatedDirectory, "gateway-throttle.ts"),
);

const defaultClientPath = resolve(generatedDirectory, "client.gen.ts");
let defaultClientSource = await readFile(defaultClientPath, "utf8");
defaultClientSource = replaceExactly(
  defaultClientSource,
  "import { type Client, type ClientOptions, type Config, createClient, createConfig } from './client/index.js';",
  "import { type Client, type ClientOptions, type Config, createConfig } from './client/index.js';\nimport { createClient } from './secure-client.js';",
  defaultClientPath,
);
await writeFile(defaultClientPath, defaultClientSource, "utf8");

const fetchClientPath = resolve(generatedDirectory, "client/client.gen.ts");
let fetchClientSource = await readFile(fetchClientPath, "utf8");
fetchClientSource = replaceExactly(
  fetchClientSource,
  "import { createSseClient } from '../core/serverSentEvents.gen.js';",
  "import { createSseClient } from '../core/serverSentEvents.gen.js';\nimport { resendGatewayThrottles } from '../gateway-throttle.js';\nimport { securePlatformRequest } from '../transport-security.js';",
  fetchClientPath,
);
fetchClientSource = replaceExactly(
  fetchClientSource,
  "      response = await _fetch(request);",
  "      request = securePlatformRequest(request, _config.baseUrl);\n      const platformRequest = request;\n      response = await resendGatewayThrottles(\n        () => _fetch(platformRequest.clone()),\n        platformRequest.signal,\n      );",
  fetchClientPath,
);
fetchClientSource = replaceExactly(
  fetchClientSource,
  "        }\n        return request;\n      },",
  "        }\n        return securePlatformRequest(request, _config.baseUrl);\n      },",
  fetchClientPath,
);
await writeFile(fetchClientPath, fetchClientSource, "utf8");

const generatedTypesPath = resolve(generatedDirectory, "types.gen.ts");
const generatedTypesSource = await readFile(generatedTypesPath, "utf8");
if (/Array<unknown>|unknown(?:\s*&\s*unknown)+/u.test(generatedTypesSource)) {
  throw new Error("Generated SDK declarations collapsed constrained primitives to unknown.");
}
for (const expectedType of [
  /export type AcceptOrganizationInvitationRequest = \{\s+token: string;/u,
  /requiredScopes: Array<string>;/u,
  /tools: Array<\{/u,
]) {
  if (!expectedType.test(generatedTypesSource)) {
    throw new Error(`Generated SDK declarations failed representative type check ${expectedType}.`);
  }
}

const contractSha256 = createHash("sha256").update(openApi).digest("hex");
const codegenSha256 = createHash("sha256").update(codegenOpenApi).digest("hex");
const sdkPackage = JSON.parse(await readFile(resolve(sdkDirectory, "package.json"), "utf8")) as {
  version: string;
};
const releaseEntry = releaseEntrySource({
  apiVersion: "1.0.0",
  codegenSha256,
  operationCount: contractNames.size,
  sha256: contractSha256,
});
await writeFile(resolve(generatedDirectory, "release-entry.ts"), releaseEntry, "utf8");

const tsc = resolve(codegenDirectory, "node_modules/.bin/tsc");
await run([tsc, "-p", resolve(sdkDirectory, "release-tsconfig.json")]);

await mkdir(packageDirectory, { recursive: true });
await copyFile(resolve(sdkDirectory, "README.md"), resolve(packageDirectory, "README.md"));
await writeClientPackageLegalFiles({
  sourceDirectory: sdkDirectory,
  packageDirectory,
  components: [
    await readThirdPartyComponent(resolve(codegenDirectory, "node_modules/@hey-api/openapi-ts")),
  ],
});
await writeFile(
  resolve(packageDirectory, "contract.json"),
  `${JSON.stringify(
    {
      apiVersion: "1.0.0",
      codegenSha256,
      operationCount: contractNames.size,
      sha256: contractSha256,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const packageManifest = {
  name: "@agentifiers/deployments-sdk",
  version: sdkPackage.version,
  description: "Generated TypeScript client for the Deployments.ai public API.",
  type: "module",
  sideEffects: false,
  exports: {
    ".": { types: "./release-entry.d.ts", import: "./release-entry.js" },
    "./contract": "./contract.json",
  },
  files: [
    "*.d.ts",
    "*.d.ts.map",
    "*.js",
    "*.js.map",
    "client",
    "core",
    "contract.json",
    ...clientPackageLegalFiles,
  ],
  engines: { node: ">=26" },
  ...clientPackageMetadata("packages/sdk"),
};
const artifactSha256 = await clientPackageFingerprint(packageDirectory, packageManifest);
await writeFile(
  resolve(packageDirectory, "package.json"),
  `${JSON.stringify(
    {
      ...packageManifest,
      deploymentsArtifactSha256: artifactSha256,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Built @agentifiers/deployments-sdk@${sdkPackage.version} with ${contractNames.size} generated operations (${contractSha256.slice(0, 12)}).`,
);
