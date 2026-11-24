import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AGENT_EMAIL_API_ROUTES,
  AGENT_EMAIL_API_SCHEMAS,
  AgentEmailAttachmentInput,
  AgentEmailMessageResponse,
  AgentEmailThreadResponse,
  CreateAgentEmailBindingRequest,
  CreateAgentEmailPlacementRequest,
  MAX_AGENT_EMAIL_ATTACHMENTS,
  SendAgentEmailMessageRequest,
  UpdateAgentEmailPolicyRequest,
} from "./agent-email.ts";
import { makePublicOpenApiSpec } from "./openapi.ts";

const publicOpenApiSpec = makePublicOpenApiSpec();

function operation(method: string, path: string) {
  const openApiPath = path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return publicOpenApiSpec.paths[openApiPath]?.[method.toLowerCase()];
}

describe("agent email API contract", () => {
  test("publishes 42 SDK operations and four binding operations without collisions", () => {
    expect(AGENT_EMAIL_API_ROUTES).toHaveLength(46);
    const names = AGENT_EMAIL_API_ROUTES.map((route) => route.name);
    const methodPaths = AGENT_EMAIL_API_ROUTES.map(
      (route) => `${route.method} ${route.path.replaceAll(/:[^/]+/gu, "{}")}`,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(methodPaths).size).toBe(methodPaths.length);
  });

  test("registers concrete request and response schemas for every route", () => {
    for (const route of AGENT_EMAIL_API_ROUTES) {
      expect(AGENT_EMAIL_API_SCHEMAS).toHaveProperty(route.responseBody);
      if ("requestBody" in route && route.requestBody) {
        expect(AGENT_EMAIL_API_SCHEMAS).toHaveProperty(route.requestBody);
      }
      expect(operation(route.method, route.path)?.operationId).toBe(route.name);
    }
  });

  test("uses the common platform bearer and environment authorization boundary", () => {
    for (const route of AGENT_EMAIL_API_ROUTES) {
      expect(route.authentication).toBe("platform-bearer");
      expect(route.scopeHeaders).toBe("environment");
      expect(route.tag).toBe("Agent Email");
      expect(["agent-email:admin", "agent-email:read", "agent-email:write"]).toContain(
        route.requiredAuthorization,
      );
    }

    const createInbox = operation("POST", "/v1/agent-email/inboxes");
    expect(createInbox?.security).toEqual([{ platformBearer: [] }]);
    expect(createInbox?.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "x-deployments-environment",
        required: true,
      }),
    );
  });

  test("requires idempotency only for durable mutations", () => {
    const readPostOperations = new Set([
      "createAgentEmailAttachmentAccessUrl",
      "createAgentEmailRawAccessUrl",
      "exportAgentEmailUsage",
      "searchAgentEmailMessages",
      "searchAgentEmailThreads",
    ]);

    for (const route of AGENT_EMAIL_API_ROUTES) {
      const expected =
        route.method === "GET" || readPostOperations.has(route.name) ? "none" : "required";
      expect(route.idempotency).toBe(expected);
    }

    expect(operation("POST", "/v1/agent-email/inboxes")?.parameters).toContainEqual(
      expect.objectContaining({ name: "idempotency-key", required: true }),
    );
    expect(
      operation("POST", "/v1/agent-email/inboxes/:inboxId/messages/search")?.parameters,
    ).not.toContainEqual(expect.objectContaining({ name: "idempotency-key" }));
  });

  test("documents the usage export body as optional", () => {
    expect(operation("POST", "/v1/agent-email/usage/export")?.requestBody).toMatchObject({
      required: false,
    });
  });

  test("documents expired or purged raw messages as gone", () => {
    const route = AGENT_EMAIL_API_ROUTES.find(
      (candidate) => candidate.name === "createAgentEmailRawAccessUrl",
    );
    expect(route?.errors).toContain(410);
    expect(
      operation("POST", "/v1/agent-email/messages/:messageId/raw/access")?.responses,
    ).toHaveProperty("410");
    expect(
      AGENT_EMAIL_API_ROUTES.find((candidate) => candidate.name === "getAgentEmailMessage")?.errors,
    ).not.toContain(410);
  });

  test("enforces binding discrimination and bounded attachment and policy inputs", () => {
    const decodeBinding = Schema.decodeUnknownSync(CreateAgentEmailBindingRequest);
    const deploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(() =>
      decodeBinding({
        agentDeploymentId: deploymentId,
        bindingType: "platform_agent",
      }),
    ).not.toThrow();
    expect(() =>
      decodeBinding({
        bindingType: "external",
        externalId: "customer-routing-key",
      }),
    ).not.toThrow();
    expect(() => decodeBinding({ bindingType: "platform_agent" })).toThrow();
    expect(() => decodeBinding({ bindingType: "external" })).toThrow();

    const decodeAttachment = Schema.decodeUnknownSync(AgentEmailAttachmentInput);
    expect(() =>
      decodeAttachment({
        contentBase64: "aGVsbG8=",
        contentType: "text/plain",
        fileName: "message.txt",
      }),
    ).not.toThrow();
    expect(() =>
      decodeAttachment({
        contentBase64: "aGVsbG8=",
        contentType: "text/plain",
        fileName: "x".repeat(256),
      }),
    ).toThrow();
    for (const invalid of [
      {
        contentId: "x".repeat(79),
        contentType: "text/plain",
        fileName: "message.txt",
      },
      {
        contentId: "part\r\ninjected",
        contentType: "text/plain",
        fileName: "message.txt",
      },
      {
        contentType: "text/plain\r\nX-Test: injected",
        fileName: "message.txt",
      },
      { contentType: "x".repeat(79), fileName: "message.txt" },
      { contentType: "text/plain", fileName: "message\r\ninjected.txt" },
    ]) {
      expect(() =>
        decodeAttachment({
          contentBase64: "aGVsbG8=",
          ...invalid,
        }),
      ).toThrow();
    }

    const decodeSend = Schema.decodeUnknownSync(SendAgentEmailMessageRequest);
    const attachment = {
      contentBase64: "aGVsbG8=",
      contentType: "text/plain",
      fileName: "message.txt",
    };
    const maximumAttachments = Array.from(
      { length: MAX_AGENT_EMAIL_ATTACHMENTS },
      () => attachment,
    );
    expect(() =>
      decodeSend({ attachments: maximumAttachments, subject: "Hello", to: ["to@example.com"] }),
    ).not.toThrow();
    expect(() =>
      decodeSend({
        attachments: [...maximumAttachments, attachment],
        subject: "Hello",
        to: ["to@example.com"],
      }),
    ).toThrow();

    const decodePolicy = Schema.decodeUnknownSync(UpdateAgentEmailPolicyRequest);
    expect(() => decodePolicy({ rawRetentionDays: 365 })).not.toThrow();
    expect(() => decodePolicy({ rawRetentionDays: 366 })).toThrow();
    expect(() => decodePolicy({ maxAttachmentBytes: 4 * 1024 * 1024 })).not.toThrow();
    expect(() => decodePolicy({ maxAttachmentBytes: 4 * 1024 * 1024 + 1 })).toThrow();
    expect(() => decodePolicy({ maxRecipientsPerMessage: 47 })).not.toThrow();
    expect(() => decodePolicy({ maxRecipientsPerMessage: 48 })).toThrow();
    expect(() =>
      decodePolicy({ allowlist: ["approved@example.com"], sendingStatus: "active" }),
    ).not.toThrow();
    expect(() => decodePolicy({ blocklist: ["not-an-address"] })).toThrow();
    expect(() => decodePolicy({ sendingStatus: "suspended" })).toThrow();
    expect(() => decodePolicy({ warmupStage: "production" })).not.toThrow();
    expect(() => decodePolicy({ warmupStage: "unbounded" })).toThrow();

    const decodePlacement = Schema.decodeUnknownSync(CreateAgentEmailPlacementRequest);
    expect(() =>
      decodePlacement({
        name: "Primary",
        region: "us-east-1",
        secondaryRegion: "us-west-2",
      }),
    ).not.toThrow();
    expect(() => decodePlacement({ name: "Primary", region: "US-EAST-1" })).toThrow();
    expect(() => decodePlacement({ name: "Primary", region: "us-east-1 " })).toThrow();
    expect(() =>
      decodePlacement({
        name: "Primary",
        region: "us-east-1",
        secondaryRegion: "us-east-1",
      }),
    ).toThrow();
  });

  test("represents bounded inbound address lists and thread participants", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const timestamp = "2026-07-26T00:00:00.000Z";
    const addresses = Array.from({ length: 100 }, (_, index) => `person${index}@example.com`);
    const decodeMessage = Schema.decodeUnknownSync(AgentEmailMessageResponse);
    const message = {
      attachments: [],
      bccAddresses: addresses,
      ccAddresses: addresses,
      createdAt: timestamp,
      direction: "inbound",
      fromAddress: "sender@example.com",
      id,
      inboxId: id,
      organizationId: id,
      references: [],
      replyToAddresses: addresses,
      reprocessCount: 0,
      status: "received",
      subject: "Inbound",
      threadKey: "thread",
      toAddresses: addresses,
      updatedAt: timestamp,
    };
    expect(() => decodeMessage(message)).not.toThrow();
    expect(() =>
      decodeMessage({ ...message, toAddresses: [...addresses, "overflow@example.com"] }),
    ).toThrow();

    const decodeThread = Schema.decodeUnknownSync(AgentEmailThreadResponse);
    const thread = {
      createdAt: timestamp,
      id,
      inboxId: id,
      lastMessageAt: timestamp,
      messageCount: 1,
      organizationId: id,
      participants: Array.from({ length: 256 }, (_, index) => `participant${index}@example.com`),
      subject: "Thread",
      updatedAt: timestamp,
    };
    expect(() => decodeThread(thread)).not.toThrow();
    expect(() =>
      decodeThread({
        ...thread,
        participants: [...thread.participants, "overflow@example.com"],
      }),
    ).toThrow();
  });
});
