import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import { acquireRuntimeCredential, stringField } from "../harness/live-agent.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import {
  acquireAgentDefinition,
  acquireDeployment,
  completeTurn,
  createThreadInPartition,
  mutateDeployment,
  readThread,
  releaseManifest,
} from "./agent-release-lifecycle-support.ts";

const enabled = credentialedE2eEnabled();
const CANARY_WEIGHT = 50;

it.effect.skipIf(!enabled)(
  "keeps canary threads sticky through promote, abort, and an explicit release rebase",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-canary-${randomUUID()}`;
      const tenant = { auth: tenantHeaders(config.platformCredential, config), http, runKey };
      const { runtimeApiKey } = yield* acquireRuntimeCredential(cli, config, runKey);
      const runtime = { auth: tenantHeaders(runtimeApiKey, config), http, runKey };

      const expectTurn = (
        label: string,
        threadId: string,
        expected: { readonly agentReleaseId: string; readonly releaseSelection: string },
        options: { readonly rebaseRelease?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          const { run, turn } = yield* completeTurn(runtime, deploymentId, label, {
            ...options,
            threadId,
          });
          expect(turn.threadId).toBe(threadId);
          expect(turn.run, `${label} submitted run`).toMatchObject(expected);
          expect(run, `${label} completed run`).toMatchObject(expected);
          expect(yield* readThread(runtime, threadId), `${label} thread`).toMatchObject({
            pinnedAgentReleaseId: expected.agentReleaseId,
          });
        });

      const agent = yield* acquireAgentDefinition(
        tenant,
        releaseManifest(runKey, "Reply with one short plain-text sentence from the primary."),
      );
      const primaryId = stringField(yield* agent.publish("primary"), "id", "primary release");
      const deployment = yield* acquireDeployment(tenant, primaryId);
      const deploymentId = stringField(deployment, "id", "agent deployment");
      const candidateId = stringField(
        yield* agent.publish(
          "candidate",
          releaseManifest(runKey, "Reply with one short plain-text sentence from the candidate."),
        ),
        "id",
        "candidate release",
      );

      const canary = yield* mutateDeployment(tenant, deploymentId, {
        body: { candidateAgentReleaseId: candidateId, weight: CANARY_WEIGHT },
        label: "canary-start",
        method: "POST",
        suffix: "/canary",
      });
      expect(canary).toMatchObject({
        agentReleaseId: primaryId,
        candidateAgentReleaseId: candidateId,
        candidateStartedAt: expect.any(String),
        candidateWeight: CANARY_WEIGHT,
      });

      const candidateThread = yield* createThreadInPartition(runtime, deploymentId, {
        label: "candidate",
        partition: "candidate",
        weight: CANARY_WEIGHT,
      });
      const primaryThread = yield* createThreadInPartition(runtime, deploymentId, {
        label: "primary",
        partition: "primary",
        weight: CANARY_WEIGHT,
      });
      const onCandidate = { agentReleaseId: candidateId, releaseSelection: "candidate" };
      yield* expectTurn("candidate-1", candidateThread, onCandidate);
      yield* expectTurn("primary-1", primaryThread, {
        agentReleaseId: primaryId,
        releaseSelection: "primary",
      });
      yield* expectTurn("candidate-2", candidateThread, onCandidate);

      const promoted = yield* mutateDeployment(tenant, deploymentId, {
        body: {},
        label: "canary-promote",
        method: "POST",
        suffix: "/canary/promote",
      });
      expect(promoted.agentReleaseId).toBe(candidateId);
      expect(promoted.candidateAgentReleaseId).toBeUndefined();
      expect(promoted.candidateWeight).toBeUndefined();
      const onPromoted = { agentReleaseId: candidateId, releaseSelection: "primary" };
      yield* expectTurn("candidate-after-promote", candidateThread, onPromoted);
      // The former primary is no longer selectable, so its sticky thread falls through.
      yield* expectTurn("primary-after-promote", primaryThread, onPromoted);

      const thirdId = stringField(
        yield* agent.publish(
          "third",
          releaseManifest(runKey, "Reply with one short plain-text sentence from the third."),
        ),
        "id",
        "third release",
      );
      const secondCanary = yield* mutateDeployment(tenant, deploymentId, {
        body: { candidateAgentReleaseId: thirdId, weight: CANARY_WEIGHT },
        label: "canary-start-2",
        method: "POST",
        suffix: "/canary",
      });
      expect(secondCanary).toMatchObject({
        agentReleaseId: candidateId,
        candidateAgentReleaseId: thirdId,
      });
      const abortedThread = yield* createThreadInPartition(runtime, deploymentId, {
        label: "aborted",
        partition: "candidate",
        weight: CANARY_WEIGHT,
      });
      const onThird = { agentReleaseId: thirdId, releaseSelection: "candidate" };
      yield* expectTurn("aborted-1", abortedThread, onThird);
      // The thread is sticky to the promoted release; rebasing reselects its candidate bucket.
      yield* expectTurn("candidate-rebase", candidateThread, onThird, { rebaseRelease: true });

      const aborted = yield* mutateDeployment(tenant, deploymentId, {
        body: {},
        label: "canary-abort",
        method: "POST",
        suffix: "/canary/abort",
      });
      expect(aborted.agentReleaseId).toBe(candidateId);
      expect(aborted.candidateAgentReleaseId).toBeUndefined();
      yield* expectTurn("aborted-after-abort", abortedThread, onPromoted);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
