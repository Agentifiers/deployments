import { expect, it } from "@effect/vitest";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import { acquireLiveAgent, stringField } from "../harness/live-agent.ts";
import { agentEmailE2eConfig, credentialedE2eEnabled, e2eApiUrl } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import {
  acquireAgentBinding,
  acquireChangedRetentionPolicy,
  acquireDefaultPlacement,
  acquireInbox,
  acquireSuppression,
  agentEmailManifest,
  expectHostedDomain,
  updateAndListInboxes,
  type AgentEmailLifecycleClient,
} from "./agent-email-lifecycle-support.ts";
import {
  awaitEmailTriggeredRun,
  expectInboundContent,
  expectMeteredUsage,
  proveDraftApprovalAndRejection,
  replyAndAwaitDelivery,
  reprocessInbound,
  sendInboundProof,
} from "./agent-email-message-flow-support.ts";

const enabled = credentialedE2eEnabled();

it.effect.skipIf(!enabled)(
  "proves hosted Agent Email ingress, agent dispatch, provider reply, content, policy, and usage",
  () =>
    Effect.gen(function* () {
      const config = yield* agentEmailE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const ses = yield* Effect.acquireRelease(
        Effect.sync(() => new SESv2Client({ region: config.awsRegion })),
        (client) => Effect.sync(() => client.destroy()),
      );
      const runKey = `e2e-email-${randomUUID()}`;
      const marker = `agent-email-proof-${randomUUID()}`;
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const agent = yield* acquireLiveAgent(
        cli,
        config,
        runKey,
        agentEmailManifest(runKey, marker),
        { serviceAccountScopes: ["agent-email:admin", "agent-email:read", "agent-email:write"] },
      );
      const auth = tenantHeaders(agent.runtimeApiKey, config);
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const client: AgentEmailLifecycleClient = { auth, http, marker, runKey };

      const senderInbox = yield* acquireInbox(client, "sender");
      const targetInbox = yield* acquireInbox(client, "target");
      const senderInboxId = stringField(senderInbox, "id", "sender inbox");
      const targetInboxId = stringField(targetInbox, "id", "target inbox");
      const senderAddress = stringField(senderInbox, "address", "sender inbox");
      const targetAddress = stringField(targetInbox, "address", "target inbox");
      expect(senderAddress.endsWith(`@${config.agentEmailDomain}`)).toBe(true);
      expect(targetAddress.endsWith(`@${config.agentEmailDomain}`)).toBe(true);

      yield* updateAndListInboxes(client, { senderInboxId, targetInboxId });
      yield* expectHostedDomain(client, config.agentEmailDomain);
      yield* acquireDefaultPlacement(client, config.awsRegion);
      yield* acquireAgentBinding(client, { agentDeploymentId: agent.deploymentId, targetInboxId });

      const inbound = yield* sendInboundProof(client, ses, {
        senderAddress,
        targetAddress,
        targetInboxId,
      });
      yield* expectInboundContent(client, { ...inbound, targetInboxId });

      const runId = yield* awaitEmailTriggeredRun(client, {
        agentDeploymentId: agent.deploymentId,
        runtimeAuth,
        startedAt,
      });

      yield* replyAndAwaitDelivery(client, {
        emailThreadId: inbound.emailThreadId,
        inboundId: inbound.inboundId,
        senderInboxId,
        targetInboxId,
      });
      yield* proveDraftApprovalAndRejection(client, { senderAddress, targetInboxId });
      yield* acquireChangedRetentionPolicy(client);
      yield* acquireSuppression(client);
      yield* reprocessInbound(client, inbound.inboundId);
      yield* expectMeteredUsage(client, {
        organizationId: config.organizationId,
        startedAt,
        targetInboxId,
      });

      expect(runId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
