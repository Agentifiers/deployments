import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  httpClientLayer,
  type E2eHttpClientService,
} from "../harness/http-client.ts";
import {
  acquireRuntimeCredential,
  cleanupHttpRequest,
  record,
  stringField,
} from "../harness/live-agent.ts";
import { json, records, version } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { bearerAuthorization, tenantHeaders } from "../harness/platform-credential.ts";

const enabled = credentialedE2eEnabled();

function cleanupVersioned(
  http: E2eHttpClientService,
  input: {
    readonly auth: Readonly<Record<string, string>>;
    readonly id: string;
    readonly key: string;
    readonly label: string;
    readonly path: string;
  },
) {
  return http
    .request({ headers: input.auth, method: "GET", path: `${input.path}/${input.id}` })
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.void;
        const current = json(response, 200, `${input.label} cleanup read`);
        return cleanupHttpRequest(
          input.label,
          http.request({
            body: { expectedVersion: version(current, input.label) },
            headers: { ...input.auth, "idempotency-key": input.key },
            method: "DELETE",
            path: `${input.path}/${input.id}`,
          }),
        );
      }),
      Effect.orDie,
    );
}

it.effect.skipIf(!enabled)(
  "proves workflow draft-to-release and managed-skill source-to-installation lifecycles",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-control-${randomUUID()}`;
      const normalizedKey = `e2e-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const auth = tenantHeaders(config.platformCredential, config);
      const runtimeCredential = yield* acquireRuntimeCredential(cli, config, runKey, [
        "workflows:execute",
        "workflows:read",
      ]);
      const runtimeAuth = tenantHeaders(runtimeCredential.runtimeApiKey, config);
      if (!config.privilegedPlatformCredential) {
        throw new Error("Managed-skill E2E requires the confidential identity client credential.");
      }
      const catalogAuth = bearerAuthorization(config.privilegedPlatformCredential);

      const workflowDocument = {
        description: `Deployed workflow proof ${runKey}`,
        entryStepId: "notify",
        name: `E2E workflow ${runKey}`,
        schemaVersion: 1,
        slug: normalizedKey,
        steps: [
          {
            channel: "e2e",
            id: "notify",
            message: `Workflow marker ${runKey}`,
            next: "done",
            target: "operator",
            type: "notification",
          },
          { id: "done", outcome: { marker: runKey }, type: "end" },
        ],
      };
      const workflow = yield* Effect.acquireRelease(
        http
          .request({
            body: { definition: workflowDocument },
            headers: { ...auth, "idempotency-key": `${runKey}:workflow` },
            method: "POST",
            path: "/v1/workflow-definitions",
          })
          .pipe(Effect.map((response) => json(response, 201, "workflow create"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "workflow"),
            key: `${runKey}:workflow:archive`,
            label: "workflow",
            path: "/v1/workflow-definitions",
          }),
      );
      const workflowId = stringField(workflow, "id", "workflow");
      expect(workflow).toMatchObject({ status: "active", version: 0 });

      const updatedWorkflow = json(
        yield* http.request({
          body: {
            definition: {
              ...workflowDocument,
              description: `Updated deployed workflow proof ${runKey}`,
            },
            expectedVersion: version(workflow, "workflow"),
          },
          headers: { ...auth, "idempotency-key": `${runKey}:workflow:update` },
          method: "PATCH",
          path: `/v1/workflow-definitions/${workflowId}`,
        }),
        200,
        "workflow update",
      );
      expect(updatedWorkflow).toMatchObject({ id: workflowId, version: 1 });
      expect(record(updatedWorkflow.draft, "updated workflow draft").description).toContain(
        "Updated",
      );

      const workflowRelease = yield* Effect.acquireRelease(
        http
          .request({
            body: { expectedDefinitionVersion: version(updatedWorkflow, "updated workflow") },
            headers: { ...auth, "idempotency-key": `${runKey}:workflow:publish` },
            method: "POST",
            path: `/v1/workflow-definitions/${workflowId}/releases`,
          })
          .pipe(Effect.map((response) => json(response, 201, "workflow publish"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "workflow release"),
            key: `${runKey}:workflow:release:archive`,
            label: "workflow release",
            path: "/v1/workflow-releases",
          }),
      );
      const workflowReleaseId = stringField(workflowRelease, "id", "workflow release");
      expect(workflowRelease).toMatchObject({
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        releaseNumber: 1,
        status: "active",
        workflowDefinitionId: workflowId,
      });
      expect(
        records(
          json(
            yield* http.request({
              headers: auth,
              method: "GET",
              path: `/v1/workflow-definitions/${workflowId}/releases`,
            }),
            200,
            "workflow release list",
          ).items,
          "workflow release list.items",
        ).map((release) => release.id),
      ).toContain(workflowReleaseId);
      expect(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/workflow-releases/${workflowReleaseId}`,
          }),
          200,
          "workflow release get",
        ).id,
      ).toBe(workflowReleaseId);

      const execution = json(
        yield* http.request({
          body: { input: { marker: runKey } },
          headers: { ...runtimeAuth, "idempotency-key": `${runKey}:workflow:execute` },
          method: "POST",
          path: `/v1/workflow-releases/${workflowReleaseId}/executions`,
        }),
        202,
        "workflow execution start",
      );
      const workflowExecutionId = stringField(execution, "id", "workflow execution");
      expect(execution).toMatchObject({
        status: "queued",
        workflowReleaseId,
      });
      const completedExecution = yield* eventually(
        { label: `workflow execution ${workflowExecutionId}`, timeoutMs: 60_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/workflow-executions/${workflowExecutionId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "workflow execution");
              if (current.status === "failed") {
                throw new Error(`Workflow execution failed: ${response.body}`);
              }
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      expect(record(completedExecution.output, "workflow execution output").marker).toBe(runKey);
      const workflowSteps = records(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/workflow-executions/${workflowExecutionId}/steps`,
          }),
          200,
          "workflow step attempts",
        ).items,
        "workflow step attempts.items",
      );
      expect(workflowSteps.map((step) => step.stepId)).toEqual(["notify", "done"]);

      const skillSource = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              key: normalizedKey,
              metadata: { marker: runKey },
              name: `E2E managed skill ${runKey}`,
              pinnedCommit: "a".repeat(40),
              repositoryUrl: "https://github.com/example/e2e-managed-skill",
            },
            headers: { ...catalogAuth, "idempotency-key": `${runKey}:skill-source` },
            method: "POST",
            path: "/v1/managed-skill-sources",
          })
          .pipe(Effect.map((response) => json(response, 201, "skill source create"))),
        (created) =>
          cleanupVersioned(http, {
            auth: catalogAuth,
            id: stringField(created, "id", "skill source"),
            key: `${runKey}:skill-source:archive`,
            label: "skill source",
            path: "/v1/managed-skill-sources",
          }),
      );
      const sourceId = stringField(skillSource, "id", "skill source");
      const updatedSource = json(
        yield* http.request({
          body: {
            expectedVersion: version(skillSource, "skill source"),
            metadata: { marker: runKey, stage: "updated" },
            name: `E2E managed skill updated ${runKey}`,
          },
          headers: { ...catalogAuth, "idempotency-key": `${runKey}:skill-source:update` },
          method: "PATCH",
          path: `/v1/managed-skill-sources/${sourceId}`,
        }),
        200,
        "skill source update",
      );
      expect(updatedSource).toMatchObject({ id: sourceId, version: 1 });

      const skillRelease = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              expectedSourceVersion: version(updatedSource, "updated skill source"),
              manifest: { marker: runKey },
              releaseVersion: "1.0.0",
              skills: [
                {
                  content: `# Base skill\n\nMarker: ${runKey}`,
                  description: "Base deployed E2E skill.",
                  key: "base",
                },
                {
                  content: `# Composite skill\n\nMarker: ${runKey}`,
                  dependencies: ["base"],
                  description: "Composite deployed E2E skill.",
                  key: "composite",
                },
              ],
            },
            headers: { ...catalogAuth, "idempotency-key": `${runKey}:skill:publish` },
            method: "POST",
            path: `/v1/managed-skill-sources/${sourceId}/releases`,
          })
          .pipe(Effect.map((response) => json(response, 201, "skill release publish"))),
        (created) =>
          cleanupVersioned(http, {
            auth: catalogAuth,
            id: stringField(created, "id", "skill release"),
            key: `${runKey}:skill-release:archive`,
            label: "skill release",
            path: "/v1/managed-skill-releases",
          }),
      );
      const skillReleaseId = stringField(skillRelease, "id", "skill release");
      expect(skillRelease).toMatchObject({
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        releaseVersion: "1.0.0",
        skillCount: 2,
        sourceId,
        status: "active",
      });

      const skills = records(
        json(
          yield* http.request({
            headers: catalogAuth,
            method: "GET",
            path: `/v1/managed-skill-releases/${skillReleaseId}/skills`,
          }),
          200,
          "managed skill list",
        ).items,
        "managed skill list.items",
      );
      const baseSkill = skills.find((skill) => skill.key === "base")!;
      const compositeSkill = skills.find((skill) => skill.key === "composite")!;
      const baseSkillId = stringField(baseSkill, "id", "base skill");
      const compositeSkillId = stringField(compositeSkill, "id", "composite skill");
      expect(compositeSkill.dependencies).toEqual([baseSkillId]);
      expect(
        json(
          yield* http.request({
            headers: catalogAuth,
            method: "GET",
            path: `/v1/managed-skills/${compositeSkillId}`,
          }),
          200,
          "managed skill get",
        ).content,
      ).toContain(runKey);

      const installation = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              managedSkillId: compositeSkillId,
              managedSkillReleaseId: skillReleaseId,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:skill:install` },
            method: "POST",
            path: "/v1/managed-skill-installations",
          })
          .pipe(Effect.map((response) => json(response, 201, "skill install"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "skill installation"),
            key: `${runKey}:skill:remove`,
            label: "skill installation",
            path: "/v1/managed-skill-installations",
          }),
      );
      const installationId = stringField(installation, "id", "skill installation");
      expect(installation).toMatchObject({
        environmentId: config.environmentId,
        managedSkillId: compositeSkillId,
        managedSkillReleaseId: skillReleaseId,
        status: "active",
      });
      // The long-lived E2E organization keeps earlier runs' installations, so the new one can be
      // past the first page.
      const listedIds: unknown[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
        const page = json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/managed-skill-installations?${query.toString()}`,
          }),
          200,
          "skill installation list",
        );
        listedIds.push(
          ...records(page.items, "skill installation list.items").map((entry) => entry.id),
        );
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      } while (cursor && !listedIds.includes(installationId));
      expect(listedIds).toContain(installationId);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  300_000,
);
