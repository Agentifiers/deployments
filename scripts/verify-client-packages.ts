import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clientPackageFingerprint } from "./client-package-fingerprint.ts";

const root = resolve(import.meta.dir, "..");
const sdkPackageDirectory = resolve(root, "packages/sdk/dist/package");
const cliPackageDirectory = resolve(root, "packages/cli/dist/package");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "deployments-client-packages-"));
const sdkTarball = resolve(temporaryDirectory, "deployments-ai-sdk.tgz");
const cliTarball = resolve(temporaryDirectory, "deployments-ai-cli.tgz");

async function run(command: readonly string[], cwd = root) {
  const child = Bun.spawn([...command], { cwd, stderr: "inherit", stdout: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
}

async function output(command: readonly string[], cwd = root): Promise<string> {
  const child = Bun.spawn([...command], { cwd, stderr: "inherit", stdout: "pipe" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  return stdout;
}

async function assertNoWorkspaceReferences(directory: string) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:d\.ts|js|json)$/u.test(entry.name)) continue;
    const path = resolve(entry.parentPath, entry.name);
    const contents = await readFile(path, "utf8");
    const leaksWorkspaceSpecifier =
      (entry.name.endsWith(".json") || entry.name.endsWith(".d.ts")) &&
      contents.includes("workspace:");
    if (leaksWorkspaceSpecifier || contents.includes('from "@deployments-ai/')) {
      throw new Error(`Published package leaks a workspace dependency through ${path}`);
    }
  }
}

await assertNoWorkspaceReferences(sdkPackageDirectory);
await assertNoWorkspaceReferences(cliPackageDirectory);
for (const directory of [sdkPackageDirectory, cliPackageDirectory]) {
  const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (
    manifest.deploymentsArtifactSha256 !== (await clientPackageFingerprint(directory, manifest))
  ) {
    throw new Error(`Staged package fingerprint does not match ${directory}.`);
  }
  const license = await readFile(resolve(directory, "LICENSE"), "utf8");
  const notice = await readFile(resolve(directory, "NOTICE"), "utf8");
  if (
    manifest.license !== "MIT" ||
    !license.startsWith("MIT License\n") ||
    !notice.includes("licensed under the MIT License") ||
    !notice.includes("third-party software")
  ) {
    throw new Error(`Staged package ${directory} must ship its MIT LICENSE and NOTICE.`);
  }
}
if ((await readdir(cliPackageDirectory)).some((entry) => entry.endsWith(".map"))) {
  throw new Error("Published CLI package must not contain source maps.");
}
await run([resolve(root, "node_modules/.bin/publint"), "run", sdkPackageDirectory, "--strict"]);
await run([resolve(root, "node_modules/.bin/publint"), "run", cliPackageDirectory, "--strict"]);
await run([process.execPath, "pm", "pack", "--filename", sdkTarball], sdkPackageDirectory);
await run([process.execPath, "pm", "pack", "--filename", cliTarball], cliPackageDirectory);
await run([resolve(root, "node_modules/.bin/attw"), sdkTarball, "--profile", "esm-only"]);

await writeFile(
  resolve(temporaryDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "deployments-client-package-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@agentifiers/deployments-cli": `file:${cliTarball}`,
        "@agentifiers/deployments-sdk": `file:${sdkTarball}`,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await run([process.execPath, "install"], temporaryDirectory);
await writeFile(
  resolve(temporaryDirectory, "smoke.ts"),
  `import { client, contractMetadata, createClient, createConfig, getHealth } from "@agentifiers/deployments-sdk";

if (typeof getHealth !== "function") throw new Error("Generated health operation is missing");
client.setConfig({ baseUrl: "http://127.0.0.1:9" });

let insecureBaseRejected = false;
try {
  createClient(createConfig({ baseUrl: "http://api.example.com" }));
} catch {
  insecureBaseRejected = true;
}
if (!insecureBaseRejected) throw new Error("Generated client accepted a non-loopback HTTP base URL");

let requestSeen = false;
const safeClient = createClient(createConfig({
  baseUrl: "http://127.0.0.1:9",
  fetch: async (request) => {
    requestSeen = true;
    if (request.redirect !== "error") throw new Error("Generated client allowed redirects");
    return Response.json({ status: "ok" });
  },
}));
await getHealth({ client: safeClient, redirect: "follow", throwOnError: true });
if (!requestSeen) throw new Error("Generated health operation did not use the configured fetch");

let authenticatedSseSeen = false;
const authenticatedSseClient = createClient(createConfig({
  baseUrl: "http://127.0.0.1:9",
  fetch: async (request) => {
    authenticatedSseSeen = request.headers.has("authorization") && request.redirect === "error";
    return new Response('data: {"status":"ok"}\\n\\n', {
      headers: { "content-type": "text/event-stream" },
    });
  },
}));
const authenticatedSse = await authenticatedSseClient.sse.get({
  headers: { authorization: "Bearer pinned" },
  url: "/v1/events",
});
const authenticatedEvent = await authenticatedSse.stream.next();
if (!authenticatedSseSeen || authenticatedEvent.done) {
  throw new Error("Generated client rejected an authenticated SSE request");
}

let insecureOverrideRejected = false;
try {
  await getHealth({ client: safeClient, baseUrl: "https://attacker.example", throwOnError: true });
} catch {
  insecureOverrideRejected = true;
}
if (!insecureOverrideRejected) throw new Error("Generated operation accepted an insecure URL override");

let unpinnedCredentialRejected = false;
let unpinnedFetchSeen = false;
try {
  const unpinnedClient = createClient(createConfig({
    headers: { authorization: "Bearer must-not-leak" },
    fetch: async () => {
      unpinnedFetchSeen = true;
      return Response.json({ status: "ok" });
    },
  }));
  await getHealth({
    client: unpinnedClient,
    baseUrl: "https://attacker.example",
    throwOnError: true,
  });
} catch {
  unpinnedCredentialRejected = true;
}
if (!unpinnedCredentialRejected) throw new Error("Generated client sent an unpinned credential");
if (unpinnedFetchSeen) throw new Error("Unpinned credential reached fetch");

const throttledBodies: string[] = [];
const throttledClient = createClient(createConfig({
  baseUrl: "http://127.0.0.1:9",
  fetch: async (request) => {
    throttledBodies.push(await request.text());
    return throttledBodies.length === 1
      ? Response.json({ message: "Too Many Requests" }, { status: 429 })
      : Response.json({ id: "prj_1" });
  },
}));
const resent = await throttledClient.post({
  url: "/v1/projects",
  body: { name: "smoke" },
  throwOnError: true,
});
if (
  JSON.stringify(resent.data) !== '{"id":"prj_1"}' ||
  throttledBodies.join(" | ") !== '{"name":"smoke"} | {"name":"smoke"}'
) {
  throw new Error("Generated client did not resend a gateway-throttled POST with its body");
}

let platformThrottleSends = 0;
const platformThrottleClient = createClient(createConfig({
  baseUrl: "http://127.0.0.1:9",
  fetch: async () => {
    platformThrottleSends += 1;
    return Response.json(
      { status: 429, title: "Rate limited", code: "organization_rate_limited" },
      { status: 429, headers: { "content-type": "application/problem+json" } },
    );
  },
}));
const platformThrottle = await platformThrottleClient.get({ url: "/v1/projects" });
if (platformThrottle.response?.status !== 429 || platformThrottleSends !== 1) {
  throw new Error("Generated client resent the platform's own 429");
}

console.log(contractMetadata.sha256);
`,
  "utf8",
);
await run([process.execPath, "smoke.ts"], temporaryDirectory);
await run([resolve(temporaryDirectory, "node_modules/.bin/deployments"), "--version"]);
JSON.parse(
  await output([resolve(temporaryDirectory, "node_modules/.bin/deployments"), "catalog", "--json"]),
);

console.log(`Verified packed SDK and CLI in ${temporaryDirectory}.`);
