import { ExitCode } from "@agentifiers/deployments-cli/exit-codes";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { CliProcessService, CliResult } from "./cli-process.ts";
import type { HttpResult } from "./http-client.ts";
import { eventually } from "./eventually.ts";
import type { ScopedE2eConfig } from "./live-config.ts";

type JsonRecord = Record<string, unknown>;

const LIVE_AGENT_SERVICE_ACCOUNT_SCOPES = [
  "agents:read",
  "agents:write",
  "approvals:read",
  "approvals:write",
  "artifacts:read",
  "artifacts:write",
  "runs:read",
  "runs:write",
  "schedules:read",
  "schedules:write",
  "webhooks:read",
  "webhooks:write",
] as const;

export function redactionSafeRandomId(uuid = randomUUID()): string {
  return uuid.replaceAll(/[0-9a-f]/gu, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  );
}

export function liveAgentServiceAccountScopes(additional: readonly string[] = []) {
  return [...new Set([...LIVE_AGENT_SERVICE_ACCOUNT_SCOPES, ...additional])].join(",");
}

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} was not a JSON object.`);
  }
  return value as JsonRecord;
}

export function parseCli(result: CliResult, label: string): JsonRecord {
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== "") {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return record(JSON.parse(result.stdout) as unknown, label);
}

export function stringField(value: JsonRecord, field: string, label: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate) {
    throw new TypeError(`${label}.${field} was not a non-empty string.`);
  }
  return candidate;
}

export function numberField(value: JsonRecord, field: string, label: string): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate)) {
    throw new TypeError(`${label}.${field} was not a safe integer.`);
  }
  return candidate as number;
}

export function cleanupHttpResult(label: string, response: HttpResult): Effect.Effect<void> {
  if ([200, 204, 404].includes(response.status)) return Effect.void;
  return Effect.die(
    new Error(`${label} cleanup returned HTTP ${String(response.status)}: ${response.body}`),
  );
}

export function retryUnavailableHttpRequest<E, R>(
  label: string,
  request: Effect.Effect<HttpResult, E, R>,
): Effect.Effect<HttpResult, E | Error, R> {
  return eventually(
    { label, timeoutMs: 15_000 },
    request.pipe(Effect.map((response) => (response.status === 503 ? undefined : response))),
  );
}

function cliServiceUnavailable(result: CliResult) {
  return result.exitCode === ExitCode.unavailable;
}

export function retryUnavailableCliRequest<E, R>(
  label: string,
  request: Effect.Effect<CliResult, E, R>,
): Effect.Effect<CliResult, E | Error, R> {
  return eventually(
    { label, timeoutMs: 15_000 },
    request.pipe(Effect.map((result) => (cliServiceUnavailable(result) ? undefined : result))),
  );
}

export function cleanupHttpRequest<E, R>(
  label: string,
  request: Effect.Effect<HttpResult, E, R>,
): Effect.Effect<void, E | Error, R> {
  return retryUnavailableHttpRequest(`${label} cleanup`, request).pipe(
    Effect.flatMap((response) => cleanupHttpResult(label, response)),
  );
}

function cleanupMemoryArchiveResult(label: string, response: HttpResult): Effect.Effect<void> {
  if ([200, 404].includes(response.status)) return Effect.void;
  const code =
    response.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? (response.json as JsonRecord).code
      : undefined;
  if (response.status === 409 && ["invalid_lifecycle", "memory_deleted"].includes(String(code))) {
    return Effect.void;
  }
  return Effect.die(
    new Error(
      `${label} archive cleanup returned HTTP ${String(response.status)}: ${response.body}`,
    ),
  );
}

export function cleanupMemoryHttpRequests<
  ArchiveError,
  ArchiveRequirements,
  DeleteError,
  DeleteRequirements,
>(
  label: string,
  archiveRequest: Effect.Effect<HttpResult, ArchiveError, ArchiveRequirements>,
  deleteRequest: Effect.Effect<HttpResult, DeleteError, DeleteRequirements>,
): Effect.Effect<
  void,
  ArchiveError | DeleteError | Error,
  ArchiveRequirements | DeleteRequirements
> {
  return retryUnavailableHttpRequest(`${label} archive cleanup`, archiveRequest).pipe(
    Effect.flatMap((response) => cleanupMemoryArchiveResult(label, response)),
    Effect.andThen(cleanupHttpRequest(label, deleteRequest)),
  );
}

function cleanupResult(label: string, result: CliResult): Effect.Effect<void> {
  if (result.exitCode === ExitCode.success || result.exitCode === ExitCode.notFound) {
    return Effect.void;
  }
  return Effect.die(new Error(`${label} cleanup failed: ${result.stderr || result.stdout}`));
}

function cleanupVersioned(
  cli: CliProcessService,
  options: {
    readonly action: "archive" | "stop";
    readonly command: "agent" | "deployment" | "release";
    readonly id: string;
    readonly idempotencyKey: string;
    readonly label: string;
    readonly tenantArgs: readonly string[];
    readonly tenantCliEnvironment: Readonly<Record<string, string>>;
  },
) {
  return retryUnavailableCliRequest(
    `${options.label} cleanup read`,
    cli.run({
      args: [options.command, "show", options.id, ...options.tenantArgs],
      env: options.tenantCliEnvironment,
    }),
  ).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === ExitCode.notFound) return Effect.void;
      const current = parseCli(result, `${options.label} cleanup read`);
      return retryUnavailableCliRequest(
        `${options.label} cleanup`,
        cli.run({
          args: [
            options.command,
            options.action,
            options.id,
            "--expected-version",
            String(numberField(current, "version", options.label)),
            "--idempotency-key",
            options.idempotencyKey,
            "--yes",
            ...options.tenantArgs,
          ],
          env: options.tenantCliEnvironment,
        }),
      ).pipe(Effect.flatMap((cleanup) => cleanupResult(options.label, cleanup)));
    }),
    Effect.orDie,
  );
}

export function acquireLiveAgent(
  cli: CliProcessService,
  config: ScopedE2eConfig,
  runKey: string,
  manifest: Readonly<Record<string, unknown>>,
  options: {
    readonly runtimeConfig?: Readonly<Record<string, unknown>>;
    readonly serviceAccountScopes?: readonly string[];
  } = {},
) {
  return Effect.gen(function* () {
    const credential = yield* acquireRuntimeCredential(
      cli,
      config,
      runKey,
      options.serviceAccountScopes,
    );
    const { runtimeApiKey, serviceAccountId, tenantArgs, tenantCliEnvironment } = credential;

    const definition = yield* Effect.acquireRelease(
      cli
        .run({
          args: [
            "agent",
            "create",
            "--manifest",
            JSON.stringify(manifest),
            "--idempotency-key",
            `${runKey}:agent`,
            ...tenantArgs,
          ],
          env: tenantCliEnvironment,
        })
        .pipe(Effect.map((result) => parseCli(result, "agent create"))),
      (created) =>
        cleanupVersioned(cli, {
          action: "archive",
          command: "agent",
          id: stringField(created, "id", "agent definition"),
          idempotencyKey: `${runKey}:agent:archive`,
          label: "agent definition",
          tenantArgs,
          tenantCliEnvironment,
        }),
    );
    const definitionId = stringField(definition, "id", "agent definition");

    const release = yield* Effect.acquireRelease(
      cli
        .run({
          args: [
            "agent",
            "release",
            definitionId,
            "--expected-version",
            String(numberField(definition, "version", "agent definition")),
            "--idempotency-key",
            `${runKey}:release`,
            ...tenantArgs,
          ],
          env: tenantCliEnvironment,
        })
        .pipe(Effect.map((result) => parseCli(result, "agent release"))),
      (created) =>
        cleanupVersioned(cli, {
          action: "archive",
          command: "release",
          id: stringField(created, "id", "agent release"),
          idempotencyKey: `${runKey}:release:archive`,
          label: "agent release",
          tenantArgs,
          tenantCliEnvironment,
        }),
    );
    const releaseId = stringField(release, "id", "agent release");

    const deployment = yield* Effect.acquireRelease(
      cli
        .run({
          args: [
            "agent",
            "deploy",
            "--release",
            releaseId,
            "--desired-state",
            "running",
            ...(options.runtimeConfig
              ? ["--runtime-config", JSON.stringify(options.runtimeConfig)]
              : []),
            "--idempotency-key",
            `${runKey}:deployment`,
            ...tenantArgs,
          ],
          env: tenantCliEnvironment,
        })
        .pipe(Effect.map((result) => parseCli(result, "agent deployment"))),
      (created) =>
        cleanupVersioned(cli, {
          action: "stop",
          command: "deployment",
          id: stringField(created, "id", "agent deployment"),
          idempotencyKey: `${runKey}:deployment:stop`,
          label: "agent deployment",
          tenantArgs,
          tenantCliEnvironment,
        }),
    );

    return {
      definitionId,
      deploymentId: stringField(deployment, "id", "agent deployment"),
      releaseId,
      runtimeApiKey,
      serviceAccountId,
      tenantArgs,
      tenantCliEnvironment,
    };
  });
}

export function acquireRuntimeCredential(
  cli: CliProcessService,
  config: ScopedE2eConfig,
  runKey: string,
  serviceAccountScopes: readonly string[] = [],
) {
  const tenantArgs = [
    "--project",
    config.projectId,
    "--env",
    config.environmentId,
    "--org",
    config.organizationId,
    "--live",
    "--json",
    "--no-color",
  ];
  // Read at each CLI spawn (cli-process spreads `env`), so cleanup after a long test uses a live token.
  const tenantCliEnvironment = {
    get DEPLOYMENTS_API_KEY() {
      return config.platformCredential.token;
    },
    DEPLOYMENTS_API_URL: config.apiUrl,
    DEPLOYMENTS_LIVE: "1",
  };

  return Effect.gen(function* () {
    const serviceAccount = yield* Effect.acquireRelease(
      cli
        .run({
          args: [
            "service-account",
            "create",
            "--name",
            `E2E ${runKey}`,
            "--scopes",
            liveAgentServiceAccountScopes(serviceAccountScopes),
            "--idempotency-key",
            `${runKey}:service-account`,
            ...tenantArgs,
          ],
          env: tenantCliEnvironment,
        })
        .pipe(Effect.map((result) => parseCli(result, "service account create"))),
      (created) =>
        retryUnavailableCliRequest(
          "service account cleanup",
          cli.run({
            args: [
              "service-account",
              "revoke",
              stringField(created, "id", "service account"),
              "--idempotency-key",
              `${runKey}:service-account:revoke`,
              "--yes",
              ...tenantArgs,
            ],
            env: tenantCliEnvironment,
          }),
        ).pipe(
          Effect.flatMap((result) => cleanupResult("service account", result)),
          Effect.orDie,
        ),
    );
    const serviceAccountId = stringField(serviceAccount, "id", "service account");
    const apiCredential = yield* Effect.acquireRelease(
      cli
        .run({
          args: [
            "api-key",
            "create",
            "--name",
            `E2E ${runKey}`,
            "--service-account",
            serviceAccountId,
            "--reveal",
            "--idempotency-key",
            `${runKey}:api-key`,
            ...tenantArgs,
          ],
          env: tenantCliEnvironment,
        })
        .pipe(Effect.map((result) => parseCli(result, "API key create"))),
      (created) =>
        retryUnavailableCliRequest(
          "API key cleanup",
          cli.run({
            args: [
              "api-key",
              "revoke",
              stringField(created, "id", "API key"),
              "--idempotency-key",
              `${runKey}:api-key:revoke`,
              "--yes",
              ...tenantArgs,
            ],
            env: tenantCliEnvironment,
          }),
        ).pipe(
          Effect.flatMap((result) => cleanupResult("API key", result)),
          Effect.orDie,
        ),
    );
    const runtimeApiKey = stringField(apiCredential, "secret", "API key");
    return {
      runtimeApiKey,
      serviceAccountId,
      tenantArgs,
      tenantCliEnvironment,
    };
  });
}
