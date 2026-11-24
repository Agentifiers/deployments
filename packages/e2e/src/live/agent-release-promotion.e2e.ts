import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireRuntimeCredential,
  cleanupHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { bearerAuthorization, tenantHeaders } from "../harness/platform-credential.ts";
import {
  acquireAgentDefinition,
  acquireDeployment,
  cleanupVersionedResource,
  completeTurn,
  expectJson,
  releaseManifest,
} from "./agent-release-lifecycle-support.ts";

const enabled = credentialedE2eEnabled();

it.effect.skipIf(!enabled)(
  "promotes a release into another environment of the project and runs it there",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-promotion-${randomUUID()}`;
      const source = { auth: tenantHeaders(config.platformCredential, config), http, runKey };

      const agent = yield* acquireAgentDefinition(
        source,
        releaseManifest(runKey, "Reply with one short plain-text sentence confirming promotion."),
      );
      const sourceRelease = yield* agent.publish("source");
      const sourceReleaseId = stringField(sourceRelease, "id", "source release");

      const environment = expectJson(
        yield* http.request({
          // The slug derived from this name would exceed 63 characters; the run key is a unique valid slug.
          body: { name: `E2E promotion ${runKey}`, slug: runKey, type: "development" },
          headers: bearerAuthorization(config.platformCredential, {
            "idempotency-key": `${runKey}:environment`,
            "x-deployments-organization": config.organizationId,
            "x-deployments-project": config.projectId,
          }),
          method: "POST",
          path: "/v1/environments",
        }),
        201,
        "target environment create",
      );
      const targetScope = {
        environmentId: stringField(environment, "id", "target environment"),
        organizationId: config.organizationId,
        projectId: config.projectId,
      };
      const target = {
        auth: tenantHeaders(config.platformCredential, targetScope),
        http,
        runKey: `${runKey}:target`,
      };
      yield* Effect.addFinalizer(() =>
        cleanupHttpRequest(
          "target environment",
          http.request({
            headers: { ...target.auth, "idempotency-key": `${runKey}:environment:archive` },
            method: "DELETE",
            path: `/v1/environments/${targetScope.environmentId}`,
          }),
        ).pipe(Effect.orDie),
      );

      const promote = (key: string) =>
        http.request({
          body: { targetEnvironmentId: targetScope.environmentId },
          headers: { ...source.auth, "idempotency-key": `${runKey}:${key}` },
          method: "POST",
          path: `/v1/agent-releases/${sourceReleaseId}/promote`,
        });
      const promoted = expectJson(yield* promote("promote"), 201, "release promotion");
      const promotedId = stringField(promoted, "id", "promoted release");
      const promotedDefinitionId = stringField(promoted, "agentDefinitionId", "promoted release");
      yield* Effect.addFinalizer(() =>
        cleanupVersionedResource(target, {
          key: `${runKey}:target:agent:archive`,
          label: "promoted agent definition",
          path: `/v1/agent-definitions/${promotedDefinitionId}`,
        }),
      );
      yield* Effect.addFinalizer(() =>
        cleanupVersionedResource(target, {
          key: `${runKey}:target:release:archive`,
          label: "promoted agent release",
          path: `/v1/agent-releases/${promotedId}`,
        }),
      );
      expect(promotedId).not.toBe(sourceReleaseId);
      expect(promotedDefinitionId).not.toBe(agent.definitionId);
      expect(promoted).toMatchObject({
        contentHash: sourceRelease.contentHash,
        environmentId: targetScope.environmentId,
        organizationId: config.organizationId,
        projectId: config.projectId,
        status: "active",
      });

      const repeated = expectJson(yield* promote("promote-repeat"), 200, "repeated promotion");
      expect(repeated).toMatchObject({
        agentDefinitionId: promotedDefinitionId,
        contentHash: sourceRelease.contentHash,
        id: promotedId,
      });

      const { runtimeApiKey } = yield* acquireRuntimeCredential(
        cli,
        { ...config, environmentId: targetScope.environmentId },
        `${runKey}-target`,
      );
      const deployment = yield* acquireDeployment(target, promotedId);
      const deploymentId = stringField(deployment, "id", "target deployment");
      expect(deployment).toMatchObject({
        agentReleaseId: promotedId,
        environmentId: targetScope.environmentId,
      });

      const { run } = yield* completeTurn(
        { auth: tenantHeaders(runtimeApiKey, targetScope), http, runKey: target.runKey },
        deploymentId,
        "promoted-turn",
      );
      expect(run).toMatchObject({
        agentDeploymentId: deploymentId,
        agentReleaseId: promotedId,
        environmentId: targetScope.environmentId,
        status: "completed",
      });
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
