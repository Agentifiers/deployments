import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const tofuDirectory = path.join(root, "infrastructure/environments/local");
const composeFile = path.join(root, "infrastructure/local/compose.yml");
const defaultEndpoint = "http://127.0.0.1:4566";
const eventDispatcherEntry = path.join(root, "functions/event-dispatcher/dist/index.mjs");
const eventDispatcherZip = path.join(root, "dist/functions/event-dispatcher-local.zip");
const memoryRuntimeDirectory = path.join(root, "functions/memory-runtime");
const memoryRuntimeZip = path.join(root, "dist/functions/memory-runtime-local.zip");
const platformApiDirectory = path.join(root, "functions/api");
const platformApiEntry = path.join(platformApiDirectory, "dist/lambda-main.js");
const platformApiZip = path.join(root, "dist/functions/platform-api-local.zip");

function configured(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function localAwsEndpoint(environment: NodeJS.ProcessEnv = process.env) {
  const endpoint =
    configured(environment.LOCAL_AWS_ENDPOINT) ?? configured(environment.FLOCI_ENDPOINT);
  if (endpoint) return endpoint;

  const port =
    configured(environment.LOCAL_AWS_PORT) ?? configured(environment.DEPLOYMENTS_AI_FLOCI_PORT);
  return port ? `http://127.0.0.1:${port}` : defaultEndpoint;
}

export function localAwsPort(environment: NodeJS.ProcessEnv = process.env) {
  const explicit =
    configured(environment.LOCAL_AWS_PORT) ?? configured(environment.DEPLOYMENTS_AI_FLOCI_PORT);
  if (explicit) {
    const port = Number.parseInt(explicit, 10);
    if (String(port) !== explicit || port < 1 || port > 65535) {
      throw new Error("LOCAL_AWS_PORT must be an integer from 1 through 65535.");
    }
    return port;
  }

  const endpoint = new URL(localAwsEndpoint(environment));
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("LOCAL_AWS_ENDPOINT must use HTTP or HTTPS.");
  }
  return endpoint.port
    ? Number.parseInt(endpoint.port, 10)
    : endpoint.protocol === "https:"
      ? 443
      : 80;
}

export function localMemoryJwtIssuer(environment: NodeJS.ProcessEnv = process.env) {
  const value = configured(environment.LOCAL_MEMORY_JWT_ISSUER);
  if (!value) {
    throw new Error("LOCAL_MEMORY_JWT_ISSUER is required for the local memory API.");
  }
  const issuer = new URL(value);
  if (issuer.protocol !== "https:") {
    throw new Error("LOCAL_MEMORY_JWT_ISSUER must use HTTPS.");
  }
  return value;
}

export function tofuChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (
      key === "AWS_ACCESS_KEY_ID" ||
      key === "AWS_SECRET_ACCESS_KEY" ||
      key === "AWS_SESSION_TOKEN" ||
      key === "AWS_SECURITY_TOKEN" ||
      key === "AWS_PROFILE" ||
      key === "AWS_REGION" ||
      key === "AWS_DEFAULT_REGION" ||
      key === "AWS_ENDPOINT_URL" ||
      key.startsWith("AWS_ENDPOINT_URL_")
    ) {
      delete result[key];
    }
  }

  const endpoint = localAwsEndpoint(environment);
  const memoryJwtIssuer = configured(environment.LOCAL_MEMORY_JWT_ISSUER);
  return {
    ...result,
    AWS_ACCESS_KEY_ID: "local",
    AWS_DEFAULT_REGION: configured(environment.LOCAL_AWS_REGION) ?? "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: configured(environment.LOCAL_AWS_REGION) ?? "us-east-1",
    AWS_SECRET_ACCESS_KEY: "local",
    TF_VAR_aws_endpoint_url: endpoint,
    TF_VAR_aws_region: configured(environment.LOCAL_AWS_REGION) ?? "us-east-1",
    ...(memoryJwtIssuer ? { TF_VAR_memory_jwt_issuer: localMemoryJwtIssuer(environment) } : {}),
  };
}

export function runtimeEnvironmentFromTofuOutput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local OpenTofu runtime_environment output is unavailable.");
  }

  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([, entry]) => typeof entry !== "string")) {
    throw new Error("Local OpenTofu runtime_environment output is invalid.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function buildLocalAwsProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeEnvironment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
  ]) {
    delete result[key];
  }
  return { ...result, ...runtimeEnvironment };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const child = spawn(command, [...args], {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (code !== 0) throw new Error(`${command} exited with status ${code}.`);
}

async function capture(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `${command} exited with status ${code}.`);
  return stdout;
}

function composeArguments(environment: NodeJS.ProcessEnv, ...args: string[]) {
  return [
    "compose",
    "-p",
    `deployments-ai-platform-local-${localAwsPort(environment)}`,
    "-f",
    composeFile,
    ...args,
  ];
}

function composeEnvironment(environment: NodeJS.ProcessEnv) {
  return { ...environment, LOCAL_AWS_PORT: String(localAwsPort(environment)) };
}

async function waitForLocalAws(environment: NodeJS.ProcessEnv) {
  const endpoint = localAwsEndpoint(environment);
  const timeoutMs = Number.parseInt(environment.LOCAL_AWS_STARTUP_TIMEOUT_MS ?? "60000", 10);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.status < 500) return;
    } catch {
      // The emulator has not opened its listener yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`Local AWS did not become reachable at ${endpoint} within ${timeoutMs}ms.`);
}

async function tofu(environment: NodeJS.ProcessEnv, args: readonly string[]) {
  await run("tofu", [`-chdir=${tofuDirectory}`, ...args], {
    env: tofuChildEnvironment(environment),
  });
}

async function readRuntimeEnvironment(environment: NodeJS.ProcessEnv) {
  const stdout = await capture(
    "tofu",
    [`-chdir=${tofuDirectory}`, "output", "-json", "runtime_environment"],
    tofuChildEnvironment(environment),
  );
  return runtimeEnvironmentFromTofuOutput(JSON.parse(stdout) as unknown);
}

async function prepareLocalLambdaArtifacts(environment: NodeJS.ProcessEnv) {
  await run("bun", ["run", "--filter", "@deployments-ai/api", "build"], {
    env: environment,
  });
  await run("bun", ["run", "--filter", "@deployments-ai/event-dispatcher", "build"], {
    env: environment,
  });
  await run("bun", ["run", "--filter", "@deployments-ai/memory-runtime", "build"], {
    env: environment,
  });
  await mkdir(path.dirname(eventDispatcherZip), { recursive: true });
  await Promise.all([
    rm(eventDispatcherZip, { force: true }),
    rm(memoryRuntimeZip, { force: true }),
    rm(platformApiZip, { force: true }),
  ]);
  await run("zip", ["-j", "-q", eventDispatcherZip, eventDispatcherEntry], {
    env: environment,
  });
  await run(
    "zip",
    [
      "-j",
      "-q",
      memoryRuntimeZip,
      path.join(memoryRuntimeDirectory, "package.json"),
      path.join(memoryRuntimeDirectory, "dist/api.js"),
      path.join(memoryRuntimeDirectory, "dist/cleanup-worker.js"),
      path.join(memoryRuntimeDirectory, "dist/flush-worker.js"),
      path.join(memoryRuntimeDirectory, "dist/index-worker.js"),
      path.join(memoryRuntimeDirectory, "dist/operation-reconciler.js"),
      path.join(memoryRuntimeDirectory, "dist/operation-worker.js"),
      path.join(memoryRuntimeDirectory, "dist/reconcile.js"),
      path.join(memoryRuntimeDirectory, "dist/shadow-worker.js"),
      path.join(memoryRuntimeDirectory, "dist/usage-worker.js"),
    ],
    { env: environment },
  );
  await run(
    "zip",
    ["-j", "-q", platformApiZip, path.join(platformApiDirectory, "package.json"), platformApiEntry],
    { env: environment },
  );
}

async function up(environment: NodeJS.ProcessEnv) {
  localMemoryJwtIssuer(environment);
  await run("docker", composeArguments(environment, "up", "-d"), {
    env: composeEnvironment(environment),
  });
  await waitForLocalAws(environment);
  await prepareLocalLambdaArtifacts(environment);
  await tofu(environment, ["init", "-input=false"]);
  await tofu(environment, ["apply", "-auto-approve", "-input=false"]);
  console.error(`[local-aws] ready at ${localAwsEndpoint(environment)}`);
}

async function down(environment: NodeJS.ProcessEnv) {
  await run("docker", composeArguments(environment, "down"), {
    env: composeEnvironment(environment),
  });
}

function usage() {
  return `Usage: bun scripts/local-aws.ts <command>

Commands:
  artifact           Build the local Lambda artifacts
  up                 Start Floci and apply the local OpenTofu root
  down               Stop Floci without deleting OpenTofu state
  destroy            Destroy local OpenTofu resources while Floci is running
  reset              Destroy local resources and stop Floci
  env                Print shell exports from OpenTofu outputs
  run -- <command>   Run a command with the local AWS environment
  tofu -- ...        Run OpenTofu against the local root`;
}

async function main() {
  const environment = process.env;
  const action = process.argv[2];
  const forwarded = process.argv.slice(3).filter((arg, index) => index !== 0 || arg !== "--");

  if (action === "artifact") return prepareLocalLambdaArtifacts(environment);
  if (action === "up") return up(environment);
  if (action === "down") return down(environment);
  if (action === "destroy") {
    return tofu(environment, ["destroy", "-auto-approve", "-input=false"]);
  }
  if (action === "reset") {
    await tofu(environment, ["destroy", "-auto-approve", "-input=false"]);
    return down(environment);
  }
  if (action === "env") {
    const runtimeEnvironment = await readRuntimeEnvironment(environment);
    for (const [key, value] of Object.entries(runtimeEnvironment).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      console.log(`export ${key}=${shellQuote(value)}`);
    }
    return;
  }
  if (action === "run") {
    const [command, ...args] = forwarded;
    if (!command) throw new Error("local-aws run requires a command after --.");
    const runtimeEnvironment = await readRuntimeEnvironment(environment);
    return run(command, args, {
      env: buildLocalAwsProcessEnvironment(environment, runtimeEnvironment),
    });
  }
  if (action === "tofu") {
    if (forwarded.length === 0) throw new Error("local-aws tofu requires arguments after --.");
    return tofu(environment, forwarded);
  }

  console.error(usage());
  if (action) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
