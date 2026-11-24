import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect, Fiber } from "effect";
import {
  CliProcess,
  CliProcessLive,
  type CliResult,
  makeTemporaryCliConfig,
} from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import { numberField, record, stringField } from "../harness/live-agent.ts";
import {
  credentialedE2eConfig,
  credentialedE2eEnabled,
  e2eApiUrl,
  type CredentialedE2eConfig,
} from "../harness/live-config.ts";
import { bearerAuthorization, type PlatformCredential } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;

const enabled = credentialedE2eEnabled();

function parseCli(result: CliResult, label: string): JsonRecord {
  expect(result.exitCode, `${label} stderr: ${result.stderr}`).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  return record(JSON.parse(result.stdout) as unknown, label);
}

function commonCliArgs(config: CredentialedE2eConfig): string[] {
  return ["--live", "--org", config.organizationId, "--json", "--no-color"];
}

function cleanupResult(label: string, result: CliResult): Effect.Effect<void> {
  if (result.exitCode === 0 || result.exitCode === 5) return Effect.void;
  return Effect.die(new Error(`${label} cleanup failed: ${result.stderr || result.stdout}`));
}

function authorizationHeaders(
  credential: PlatformCredential | string,
  scope: Readonly<Record<string, string>> = {},
) {
  return bearerAuthorization(credential, { ...scope });
}

it.effect.skipIf(!enabled)(
  "proves the CLI and API tenancy-to-run lifecycle with replay-safe cleanup",
  () =>
    Effect.gen(function* () {
      const config = yield* credentialedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const configDirectory = yield* makeTemporaryCliConfig;
      const organizationCredential = config.platformCredential;
      const runKey = `e2e-${randomUUID()}`;
      const common = commonCliArgs(config);
      const cliEnvironment = {
        get DEPLOYMENTS_API_KEY() {
          return organizationCredential.token;
        },
        DEPLOYMENTS_API_URL: config.apiUrl,
        DEPLOYMENTS_CONFIG_DIR: configDirectory,
        DEPLOYMENTS_LIVE: "1",
      };

      const identity = yield* http.request({
        headers: authorizationHeaders(organizationCredential, {
          "x-deployments-organization": config.organizationId,
        }),
        method: "GET",
        path: "/v1/whoami",
      });
      expect(identity.status).toBe(200);
      expect(record(identity.json, "identity").organizationIds).toContain(config.organizationId);

      const projectIdempotencyKey = `${runKey}:project`;
      const project = yield* Effect.acquireRelease(
        cli
          .run({
            args: [
              "project",
              "create",
              "--name",
              `E2E ${runKey}`,
              "--slug",
              runKey,
              "--idempotency-key",
              projectIdempotencyKey,
              ...common,
            ],
            env: cliEnvironment,
          })
          .pipe(Effect.map((result) => parseCli(result, "project create"))),
        (created) => {
          const projectId = stringField(created, "id", "project");
          return cli
            .run({
              args: [
                "project",
                "archive",
                projectId,
                "--project",
                projectId,
                "--idempotency-key",
                `${runKey}:project:archive`,
                "--yes",
                ...common,
              ],
              env: cliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => cleanupResult("project", result)),
              Effect.orDie,
            );
        },
      );
      const projectId = stringField(project, "id", "project");

      const projectReplay = parseCli(
        yield* cli.run({
          args: [
            "project",
            "create",
            "--name",
            `E2E ${runKey}`,
            "--slug",
            runKey,
            "--idempotency-key",
            projectIdempotencyKey,
            ...common,
          ],
          env: cliEnvironment,
        }),
        "project replay",
      );
      expect(projectReplay.id).toBe(projectId);

      const conflictingProject = yield* cli.run({
        args: [
          "project",
          "create",
          "--name",
          `Conflicting ${runKey}`,
          "--slug",
          `${runKey}-conflict`,
          "--idempotency-key",
          projectIdempotencyKey,
          ...common,
        ],
        env: cliEnvironment,
      });
      expect(conflictingProject.exitCode).toBe(6);

      const projectRead = yield* http.request({
        headers: authorizationHeaders(organizationCredential, {
          "x-deployments-project": projectId,
        }),
        method: "GET",
        path: `/v1/projects/${projectId}`,
      });
      expect(projectRead.status).toBe(200);
      expect(record(projectRead.json, "project read").id).toBe(projectId);

      const environment = yield* Effect.acquireRelease(
        cli
          .run({
            args: [
              "env",
              "create",
              "--name",
              `E2E ${runKey}`,
              "--slug",
              runKey,
              "--type",
              "development",
              "--project",
              projectId,
              "--idempotency-key",
              `${runKey}:environment`,
              ...common,
            ],
            env: cliEnvironment,
          })
          .pipe(Effect.map((result) => parseCli(result, "environment create"))),
        (created) => {
          const environmentId = stringField(created, "id", "environment");
          return cli
            .run({
              args: [
                "env",
                "archive",
                environmentId,
                "--project",
                projectId,
                "--env",
                environmentId,
                "--idempotency-key",
                `${runKey}:environment:archive`,
                "--yes",
                ...common,
              ],
              env: cliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => cleanupResult("environment", result)),
              Effect.orDie,
            );
        },
      );
      const environmentId = stringField(environment, "id", "environment");
      const tenantArgs = ["--project", projectId, "--env", environmentId, ...common];

      const serviceAccount = yield* Effect.acquireRelease(
        cli
          .run({
            args: [
              "service-account",
              "create",
              "--name",
              `E2E ${runKey}`,
              "--scopes",
              "agents:read,agents:write,runs:read,runs:write",
              "--idempotency-key",
              `${runKey}:service-account`,
              ...tenantArgs,
            ],
            env: cliEnvironment,
          })
          .pipe(Effect.map((result) => parseCli(result, "service account create"))),
        (created) =>
          cli
            .run({
              args: [
                "service-account",
                "revoke",
                stringField(created, "id", "service account"),
                "--idempotency-key",
                `${runKey}:service-account:revoke`,
                "--yes",
                ...tenantArgs,
              ],
              env: cliEnvironment,
            })
            .pipe(
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
            env: cliEnvironment,
          })
          .pipe(Effect.map((result) => parseCli(result, "API key create"))),
        (created) =>
          cli
            .run({
              args: [
                "api-key",
                "revoke",
                stringField(created, "id", "API key"),
                "--idempotency-key",
                `${runKey}:api-key:revoke`,
                "--yes",
                ...tenantArgs,
              ],
              env: cliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => cleanupResult("API key", result)),
              Effect.orDie,
            ),
      );
      const runtimeApiKey = stringField(apiCredential, "secret", "API key");
      const tenantCliEnvironment = { ...cliEnvironment, DEPLOYMENTS_API_KEY: runtimeApiKey };

      const runtimeIdentity = yield* http.request({
        headers: authorizationHeaders(runtimeApiKey),
        method: "GET",
        path: "/v1/whoami",
      });
      expect(runtimeIdentity.status).toBe(200);
      expect(record(runtimeIdentity.json, "runtime identity")).toMatchObject({
        authentication: "api-credential",
        environmentId,
        projectId,
      });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: {
          key: `e2e.${runKey}`,
          name: `E2E ${runKey}`,
          version: "1.0.0",
        },
        spec: {
          capabilities: { tools: [] },
          instructions: "Reply with a concise confirmation that the end-to-end test completed.",
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      };
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
        (created) => {
          const definitionId = stringField(created, "id", "agent definition");
          return cli
            .run({
              args: ["agent", "show", definitionId, ...tenantArgs],
              env: tenantCliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => {
                if (result.exitCode === 5) return Effect.void;
                const current = parseCli(result, "agent cleanup read");
                return cli
                  .run({
                    args: [
                      "agent",
                      "archive",
                      definitionId,
                      "--expected-version",
                      String(numberField(current, "version", "agent definition")),
                      "--idempotency-key",
                      `${runKey}:agent:archive`,
                      "--yes",
                      ...tenantArgs,
                    ],
                    env: tenantCliEnvironment,
                  })
                  .pipe(Effect.flatMap((cleanup) => cleanupResult("agent definition", cleanup)));
              }),
              Effect.orDie,
            );
        },
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
        (created) => {
          const releaseId = stringField(created, "id", "agent release");
          return cli
            .run({
              args: ["release", "show", releaseId, ...tenantArgs],
              env: tenantCliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => {
                if (result.exitCode === 5) return Effect.void;
                const current = parseCli(result, "release cleanup read");
                return cli
                  .run({
                    args: [
                      "release",
                      "archive",
                      releaseId,
                      "--expected-version",
                      String(numberField(current, "version", "agent release")),
                      "--idempotency-key",
                      `${runKey}:release:archive`,
                      "--yes",
                      ...tenantArgs,
                    ],
                    env: tenantCliEnvironment,
                  })
                  .pipe(Effect.flatMap((cleanup) => cleanupResult("agent release", cleanup)));
              }),
              Effect.orDie,
            );
        },
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
              "--idempotency-key",
              `${runKey}:deployment`,
              ...tenantArgs,
            ],
            env: tenantCliEnvironment,
          })
          .pipe(Effect.map((result) => parseCli(result, "agent deployment"))),
        (created) => {
          const deploymentId = stringField(created, "id", "agent deployment");
          return cli
            .run({
              args: ["deployment", "show", deploymentId, ...tenantArgs],
              env: tenantCliEnvironment,
            })
            .pipe(
              Effect.flatMap((result) => {
                if (result.exitCode === 5) return Effect.void;
                const current = parseCli(result, "deployment cleanup read");
                return cli
                  .run({
                    args: [
                      "deployment",
                      "stop",
                      deploymentId,
                      "--expected-version",
                      String(numberField(current, "version", "agent deployment")),
                      "--idempotency-key",
                      `${runKey}:deployment:stop`,
                      "--yes",
                      ...tenantArgs,
                    ],
                    env: tenantCliEnvironment,
                  })
                  .pipe(Effect.flatMap((cleanup) => cleanupResult("agent deployment", cleanup)));
              }),
              Effect.orDie,
            );
        },
      );
      const deploymentId = stringField(deployment, "id", "agent deployment");
      const runIdempotencyKey = `${runKey}:run`;
      const runtimeCommon = ["--env", environmentId, "--live", "--json", "--no-color"];
      const runtimeEnvironment = { ...cliEnvironment, DEPLOYMENTS_API_KEY: runtimeApiKey };
      const submitted = parseCli(
        yield* cli.run({
          args: [
            "run",
            "create",
            "--agent",
            deploymentId,
            "--message",
            `Confirm end-to-end run ${runKey}.`,
            "--idempotency-key",
            runIdempotencyKey,
            ...runtimeCommon,
          ],
          env: runtimeEnvironment,
          timeoutMs: 60_000,
        }),
        "run create",
      );
      const submittedRun = record(submitted.run, "submitted.run");
      const submittedThread = record(submitted.thread, "submitted.thread");
      const runId = stringField(submittedRun, "id", "submitted.run");
      const threadId = stringField(submittedThread, "id", "submitted.thread");
      expect(submitted.created).toBe(true);

      const replayed = parseCli(
        yield* cli.run({
          args: [
            "run",
            "create",
            "--agent",
            deploymentId,
            "--message",
            `Confirm end-to-end run ${runKey}.`,
            "--idempotency-key",
            runIdempotencyKey,
            ...runtimeCommon,
          ],
          env: runtimeEnvironment,
          timeoutMs: 60_000,
        }),
        "run replay",
      );
      expect(record(replayed.run, "replayed.run").id).toBe(runId);
      expect(replayed.created).toBe(false);

      const timelineFiber = yield* cli
        .run({
          args: ["run", "tail", runId, "--thread", threadId, "--follow", ...runtimeCommon],
          env: runtimeEnvironment,
          timeoutMs: 180_000,
        })
        .pipe(Effect.forkScoped({ startImmediately: true }));

      const terminalRun = yield* eventually(
        { label: `run ${runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: authorizationHeaders(runtimeApiKey),
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              expect(response.status).toBe(200);
              const current = record(response.json, "run");
              return ["canceled", "completed", "failed"].includes(String(current.status))
                ? current
                : undefined;
            }),
          ),
      );
      expect(terminalRun.status).toBe("completed");

      const messages = yield* http.request({
        headers: authorizationHeaders(runtimeApiKey),
        method: "GET",
        path: `/v1/threads/${threadId}/messages`,
      });
      expect(messages.status).toBe(200);
      expect(record(messages.json, "messages").messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      );

      const shown = parseCli(
        yield* cli.run({
          args: ["run", "show", runId, "--thread", threadId, ...runtimeCommon],
          env: runtimeEnvironment,
        }),
        "run show",
      );
      expect(shown).toMatchObject({ id: runId, status: "completed" });

      const timeline = yield* Fiber.join(timelineFiber);
      expect(timeline.exitCode, timeline.stderr).toBe(0);
      expect(timeline.stderr).toBe("");
      expect(
        timeline.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ eventType: "run.completed", runId })]),
      );
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  300_000,
);
