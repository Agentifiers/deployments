import { expect, it } from "@effect/vitest";
import {
  reconcileSlackUserGroup,
  slackUserGroupClient,
  type SlackUserGroupDesiredState,
} from "@deployments-ai/channel-adapters/slack";
import { createHmac, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { acquireChannelBindingCredential, remoteRequest } from "../harness/channel-provider-api.ts";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import {
  e2eApiUrl,
  slackIdentityE2eConfig,
  slackIdentityE2eEnabled,
} from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = slackIdentityE2eEnabled();
const SLACK_SCOPES = [
  "channels:history",
  "chat:write",
  "chat:write.customize",
  "groups:history",
  "usergroups:read",
  "usergroups:write",
] as const;

function slackApi(token: string, method: string, body: Readonly<Record<string, unknown>>) {
  return remoteRequest("https://slack.com", {
    body,
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
    path: `/api/${method}`,
  }).pipe(
    Effect.flatMap((response) =>
      Effect.try({
        try: () => record(response.json, `Slack ${method}`),
        catch: (cause) => new Error(`Slack ${method} returned an invalid response.`, { cause }),
      }).pipe(
        Effect.flatMap((result) =>
          response.status !== 200 || result.ok !== true
            ? Effect.fail(
                new Error(
                  `Slack ${method} failed: ${typeof result.error === "string" ? result.error : response.status}.`,
                ),
              )
            : Effect.succeed(result),
        ),
      ),
    ),
  );
}

function cleanupSlackMessage(token: string, channel: string, ts: string) {
  return slackApi(token, "chat.delete", { channel, ts }).pipe(
    Effect.catch((cause) =>
      cause.message.includes("message_not_found") ? Effect.void : Effect.die(cause),
    ),
    Effect.asVoid,
  );
}

it.effect.skipIf(!enabled)(
  "proves deployed signed Slack ingress, user-group mentions, and custom stream identity",
  () =>
    Effect.gen(function* () {
      const config = yield* slackIdentityE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-slack-${randomUUID()}`;
      const marker = `signed-slack-proof-${randomUUID()}`;
      const startedAt = new Date(Date.now() - 5_000).toISOString();
      const userGroupClient = slackUserGroupClient({ token: config.slackUserToken });
      const previousUserGroup = yield* Effect.tryPromise({
        try: async () => {
          const matched = (await userGroupClient.list(config.slackTeamId)).find(
            (candidate) => candidate.id === config.slackUserGroupId,
          );
          if (!matched) throw new Error("The pinned Slack E2E user group was not found.");
          return matched;
        },
        catch: (cause) => new Error("Slack user-group lookup failed.", { cause }),
      });
      if (!previousUserGroup.userIds || previousUserGroup.userIds.length !== 0) {
        return yield* Effect.fail(
          new Error("The pinned Slack E2E user group must report zero members before use."),
        );
      }
      const desiredUserGroup: SlackUserGroupDesiredState = {
        ...(previousUserGroup.description ? { description: previousUserGroup.description } : {}),
        handle: previousUserGroup.handle,
        name: previousUserGroup.name,
        status: "active",
        teamId: config.slackTeamId,
      };
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: async () =>
            void (await reconcileSlackUserGroup({
              client: userGroupClient,
              desired: {
                ...(previousUserGroup.description
                  ? { description: previousUserGroup.description }
                  : {}),
                handle: previousUserGroup.handle,
                name: previousUserGroup.name,
                status: previousUserGroup.status,
                teamId: config.slackTeamId,
              },
              userGroupId: previousUserGroup.id,
            })),
          catch: (cause) => new Error("Slack user-group cleanup failed.", { cause }),
        }).pipe(Effect.orDie),
      );
      const userGroup = yield* Effect.tryPromise({
        try: async () =>
          (
            await reconcileSlackUserGroup({
              client: userGroupClient,
              desired: desiredUserGroup,
              userGroupId: previousUserGroup.id,
            })
          ).userGroup,
        catch: (cause) => new Error("Slack user-group reconciliation failed.", { cause }),
      });
      expect(userGroup).toMatchObject({ id: config.slackUserGroupId, status: "active" });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E Slack ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: { tools: [] },
          instructions: `Reply with exactly ${marker}.`,
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
          sandbox: { mode: "none" },
          triggers: ["chat"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest, {
        serviceAccountScopes: ["channels:read", "channels:write"],
      });
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const platformAuth = tenantHeaders(config.platformCredential, config);

      const binding = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              agentDefinitionId: agent.definitionId,
              agentDeploymentId: agent.deploymentId,
              channel: "slack",
              externalChannelId: config.slackChannelId,
              externalWorkspaceId: config.slackTeamId,
              metadata: {
                slackAgentIdentity: {
                  iconEmoji: ":robot_face:",
                  username: config.slackAgentUsername,
                },
              },
              provider: "slack_edge",
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:binding` },
            method: "POST",
            path: "/v1/channel-bindings",
          })
          .pipe(Effect.map((response) => json(response, 201, "Slack binding create"))),
        (created) =>
          cleanupHttpRequest(
            "Slack binding",
            http.request({
              headers: runtimeAuth,
              method: "DELETE",
              path: `/v1/channel-bindings/${stringField(created, "id", "Slack binding")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const bindingId = stringField(binding, "id", "Slack binding");
      const credential = yield* acquireChannelBindingCredential({
        bindingId,
        channelApiUrl: config.slackChannelApiUrl,
        environmentId: config.environmentId,
        label: "Slack",
        platformAuth,
        scopes: SLACK_SCOPES,
        values: {
          accessToken: config.slackBotToken,
          signingSecret: config.slackSigningSecret,
        },
      });
      expect(credential).toHaveProperty("reference");

      expect(
        json(
          yield* retryUnavailableHttpRequest(
            "Slack binding verification",
            http.request({
              headers: runtimeAuth,
              method: "POST",
              path: `/v1/channel-bindings/${bindingId}/verify`,
            }),
          ),
          200,
          "Slack binding verification",
        ),
      ).toMatchObject({ credentialAttached: true, status: "active" });

      const seed = yield* Effect.acquireRelease(
        slackApi(config.slackBotToken, "chat.postMessage", {
          channel: config.slackChannelId,
          text: `${marker} <!subteam^${userGroup.id}|@${userGroup.handle}>`,
          unfurl_links: false,
          unfurl_media: false,
        }),
        (message) =>
          cleanupSlackMessage(
            config.slackBotToken,
            config.slackChannelId,
            stringField(message, "ts", "Slack seed message"),
          ),
      );
      const seedTs = stringField(seed, "ts", "Slack seed message");
      const seedBotId = stringField(
        record(seed.message, "Slack seed message.message"),
        "bot_id",
        "Slack seed message.message",
      );
      const clientMessageId = randomUUID();
      const event = JSON.stringify({
        event: {
          channel: config.slackChannelId,
          channel_type: "channel",
          client_msg_id: clientMessageId,
          event_ts: seedTs,
          text: `${marker} <!subteam^${userGroup.id}|@${userGroup.handle}>`,
          ts: seedTs,
          type: "message",
          user: config.slackUserId,
        },
        event_id: `Ev${randomUUID().replaceAll("-", "")}`,
        event_time: Math.floor(Date.now() / 1_000),
        team_id: config.slackTeamId,
        type: "event_callback",
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const ingressPath = `/public/channels/${config.organizationId}/${config.environmentId}/${bindingId}/slack_edge`;
      const invalid = yield* remoteRequest(config.slackChannelApiUrl, {
        body: event,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${"0".repeat(64)}`,
        },
        method: "POST",
        path: ingressPath,
      });
      expect(invalid.status, invalid.body).toBe(401);

      const signature = `v0=${createHmac("sha256", config.slackSigningSecret)
        .update(`v0:${timestamp}:${event}`)
        .digest("hex")}`;
      expect(
        json(
          yield* remoteRequest(config.slackChannelApiUrl, {
            body: event,
            headers: {
              "content-type": "application/json",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": signature,
            },
            method: "POST",
            path: ingressPath,
          }),
          202,
          "signed Slack ingress",
        ),
      ).toEqual({ accepted: true });

      const run = yield* eventually(
        { label: `Slack-triggered run ${marker}`, timeoutMs: 240_000 },
        retryUnavailableHttpRequest(
          "Slack run search",
          http.request({
            body: {
              agentDeploymentId: agent.deploymentId,
              createdAfter: startedAt,
              limit: 20,
            },
            headers: runtimeAuth,
            method: "POST",
            path: "/v1/runs/search",
          }),
        ).pipe(
          Effect.map((response) => {
            const page = json(response, 200, "Slack run search");
            const candidate = records(page.runs, "Slack run search.runs").find(
              (value) => value.trigger === "chat",
            );
            if (candidate?.status === "failed") {
              throw new Error(`Slack-triggered run failed: ${response.body}`);
            }
            return candidate?.status === "completed" ? candidate : undefined;
          }),
        ),
      );
      const threadId = stringField(run, "threadId", "Slack run");
      const messages = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/threads/${threadId}/messages`,
        }),
        200,
        "Slack run messages",
      );
      const userMessage = records(messages.messages, "Slack run messages.messages").find(
        (message) => message.role === "user",
      );
      expect(userMessage).toBeDefined();
      expect(userMessage?.body).toContain(marker);
      expect(userMessage?.metadata).toMatchObject({
        bindingId,
        externalChannelId: config.slackChannelId,
        externalMessageId: `slack:${config.slackTeamId}:${config.slackChannelId}:${clientMessageId}`,
        externalWorkspaceId: config.slackTeamId,
        provider: "slack_edge",
        providerMetadata: { slackUserGroupMentionIds: [userGroup.id] },
        sender: { id: config.slackUserId },
        source: "channel-ingress",
      });

      const reply = yield* eventually(
        { label: `custom Slack stream reply ${marker}`, timeoutMs: 120_000 },
        slackApi(config.slackUserToken, "conversations.replies", {
          channel: config.slackChannelId,
          ts: seedTs,
        }).pipe(
          Effect.map((response) =>
            records(response.messages, "Slack thread messages").find(
              (message) =>
                message.ts !== seedTs &&
                typeof message.text === "string" &&
                message.text.includes(marker),
            ),
          ),
        ),
      );
      // Slack does not permit chat.delete for messages customized through chat:write.customize.
      // This proof is restricted to a dedicated sandbox channel and leaves exactly this one
      // non-secret reply for the channel's retention policy instead of failing false cleanup.
      expect(reply.username).toBe(config.slackAgentUsername);
      expect(stringField(reply, "bot_id", "Slack stream reply")).toBe(seedBotId);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  420_000,
);
