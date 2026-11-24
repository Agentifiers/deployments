import { expect, it } from "@effect/vitest";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { acquireChannelBindingCredential, remoteRequest } from "../harness/channel-provider-api.ts";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  httpClientLayer,
  type E2eHttpClientService,
} from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import {
  telegramIngressE2eConfig,
  telegramIngressE2eEnabled,
} from "../harness/third-party-live-config.ts";
import { e2eApiUrl } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;

const enabled = telegramIngressE2eEnabled();
const TELEGRAM_MAX_SIGNED_INTEGER = 2 ** 31 - 1;

/** Calls the Bot API without ever placing the token-bearing URL in an error or log line. */
function telegramApi(token: string, method: string, body: Readonly<Record<string, unknown>>) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const result = record((await response.json()) as unknown, `Telegram ${method}`);
      if (!response.ok || result.ok !== true) {
        throw new Error(
          `Telegram ${method} failed: ${typeof result.description === "string" ? result.description : response.status}.`,
        );
      }
      return result.result;
    },
    catch: (cause) =>
      cause instanceof Error && cause.message.startsWith(`Telegram ${method} failed:`)
        ? cause
        : new Error(`Telegram ${method} request failed.`),
  });
}

/** Scans the environment delivery list because channel deliveries are not filterable by run. */
function findRunDelivery(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  runId: string,
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = json(
        yield* retryUnavailableHttpRequest(
          "Telegram delivery list",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/channel-deliveries?${query.toString()}`,
          }),
        ),
        200,
        "Telegram delivery list",
      );
      const match = records(
        page.channelDeliveries,
        "Telegram delivery list.channelDeliveries",
      ).find((delivery) => delivery.runId === runId);
      if (match) return match;
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    return undefined;
  });
}

it.effect.skipIf(!enabled)(
  "proves deployed secret-token Telegram ingress, channel-triggered run, and delivered reply",
  () =>
    Effect.gen(function* () {
      const config = yield* telegramIngressE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-telegram-${randomUUID()}`;
      const marker = `telegram-proof-${randomUUID()}`;
      const startedAt = new Date(Date.now() - 5_000).toISOString();

      const bot = record(
        yield* telegramApi(config.telegramBotToken, "getMe", {}),
        "Telegram getMe result",
      );
      expect(bot).toMatchObject({ id: Number(config.telegramBotId), is_bot: true });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E Telegram ${runKey}`, version: "1.0.0" },
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
              channel: "telegram",
              externalChannelId: config.telegramBotId,
              externalWorkspaceId: config.telegramBotId,
              provider: "telegram",
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:binding` },
            method: "POST",
            path: "/v1/channel-bindings",
          })
          .pipe(Effect.map((response) => json(response, 201, "Telegram binding create"))),
        (created) =>
          cleanupHttpRequest(
            "Telegram binding",
            http.request({
              headers: runtimeAuth,
              method: "DELETE",
              path: `/v1/channel-bindings/${stringField(created, "id", "Telegram binding")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const bindingId = stringField(binding, "id", "Telegram binding");
      expect(binding).toMatchObject({ credentialAttached: false, status: "disabled" });

      // Telegram accepts 1-256 characters from [A-Za-z0-9_-]; base64url of 32 bytes is 43 of them.
      const webhookSecret = randomBytes(32).toString("base64url");
      yield* acquireChannelBindingCredential({
        bindingId,
        channelApiUrl: config.channelApiUrl,
        environmentId: config.environmentId,
        label: "Telegram",
        platformAuth,
        values: {
          botId: config.telegramBotId,
          botToken: config.telegramBotToken,
          webhookSecret,
        },
      });
      expect(
        json(
          yield* retryUnavailableHttpRequest(
            "Telegram binding verification",
            http.request({
              headers: runtimeAuth,
              method: "POST",
              path: `/v1/channel-bindings/${bindingId}/verify`,
            }),
          ),
          200,
          "Telegram binding verification",
        ),
      ).toMatchObject({ credentialAttached: true, status: "active" });

      const ingressPath = `/public/channels/${config.organizationId}/${config.environmentId}/${bindingId}/telegram`;
      const ingressUrl = new URL(ingressPath, config.channelApiUrl).href;
      yield* Effect.acquireRelease(
        telegramApi(config.telegramBotToken, "setWebhook", {
          allowed_updates: ["message"],
          drop_pending_updates: true,
          secret_token: webhookSecret,
          url: ingressUrl,
        }),
        () =>
          telegramApi(config.telegramBotToken, "deleteWebhook", {
            drop_pending_updates: true,
          }).pipe(Effect.asVoid, Effect.orDie),
      );
      expect(
        record(
          yield* telegramApi(config.telegramBotToken, "getWebhookInfo", {}),
          "Telegram getWebhookInfo result",
        ),
      ).toMatchObject({ url: ingressUrl });

      // A bot cannot send an update to itself, so the envelope is synthesized with the exact
      // shape and secret-token header Telegram uses for webhook delivery.
      const messageId = randomInt(1, TELEGRAM_MAX_SIGNED_INTEGER);
      const update = JSON.stringify({
        message: {
          chat: { id: Number(config.telegramChatId), type: "private" },
          date: Math.floor(Date.now() / 1_000),
          from: { first_name: "E2E", id: Number(config.telegramChatId), is_bot: false },
          message_id: messageId,
          text: marker,
        },
        update_id: randomInt(1, TELEGRAM_MAX_SIGNED_INTEGER),
      });
      const invalid = yield* remoteRequest(config.channelApiUrl, {
        body: update,
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": randomBytes(32).toString("base64url"),
        },
        method: "POST",
        path: ingressPath,
      });
      expect(invalid.status, invalid.body).toBe(401);
      expect(
        json(
          yield* remoteRequest(config.channelApiUrl, {
            body: update,
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": webhookSecret,
            },
            method: "POST",
            path: ingressPath,
          }),
          202,
          "secret-token Telegram ingress",
        ),
      ).toEqual({ accepted: true });

      const run = yield* eventually(
        { label: `Telegram-triggered run ${marker}`, timeoutMs: 240_000 },
        retryUnavailableHttpRequest(
          "Telegram run search",
          http.request({
            body: { agentDeploymentId: agent.deploymentId, createdAfter: startedAt, limit: 20 },
            headers: runtimeAuth,
            method: "POST",
            path: "/v1/runs/search",
          }),
        ).pipe(
          Effect.map((response) => {
            const page = json(response, 200, "Telegram run search");
            const candidate = records(page.runs, "Telegram run search.runs").find(
              (value) => value.trigger === "chat",
            );
            if (candidate?.status === "failed") {
              throw new Error(`Telegram-triggered run failed: ${response.body}`);
            }
            return candidate?.status === "completed" ? candidate : undefined;
          }),
        ),
      );
      const runId = stringField(run, "id", "Telegram run");
      const messages = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/threads/${stringField(run, "threadId", "Telegram run")}/messages`,
        }),
        200,
        "Telegram run messages",
      );
      const userMessage = records(messages.messages, "Telegram run messages.messages").find(
        (message) => message.role === "user",
      );
      expect(userMessage?.body).toContain(marker);
      expect(userMessage?.metadata).toMatchObject({
        bindingId,
        externalChannelId: config.telegramBotId,
        externalMessageId: String(messageId),
        externalThreadKey: config.telegramChatId,
        externalWorkspaceId: config.telegramBotId,
        provider: "telegram",
        sender: { displayName: "E2E", id: config.telegramChatId },
        source: "channel-ingress",
      });

      const queued = yield* eventually(
        { label: `Telegram delivery for run ${runId}`, timeoutMs: 60_000 },
        findRunDelivery(http, runtimeAuth, runId),
      );
      const deliveryId = stringField(queued, "id", "Telegram delivery");
      const delivery: JsonRecord = yield* eventually(
        { label: `sent Telegram delivery ${deliveryId}`, timeoutMs: 120_000 },
        retryUnavailableHttpRequest(
          "Telegram delivery get",
          http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/runs/${runId}/channel-deliveries/${deliveryId}`,
          }),
        ).pipe(
          Effect.map((response) => {
            const current = json(response, 200, "Telegram delivery get");
            if (current.status === "failed") {
              throw new Error(`Telegram delivery failed: ${response.body}`);
            }
            return current.status === "sent" ? current : undefined;
          }),
        ),
      );
      expect(delivery).toMatchObject({
        bindingId,
        channel: "telegram",
        externalThreadKey: config.telegramChatId,
        provider: "telegram",
        runId,
        status: "sent",
        threadId: run.threadId,
      });
      expect(delivery.contentPreview).toContain(marker);
      const providerMessageId = stringField(delivery, "providerMessageId", "Telegram delivery");
      expect(providerMessageId).toMatch(/^[1-9]\d*$/u);

      // deleteMessage succeeds only for a message the bot actually sent to this chat, so it proves
      // the recorded provider message ID against Telegram while removing the sandbox reply.
      expect(
        yield* telegramApi(config.telegramBotToken, "deleteMessage", {
          chat_id: Number(config.telegramChatId),
          message_id: Number(providerMessageId),
        }),
      ).toBe(true);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  420_000,
);
