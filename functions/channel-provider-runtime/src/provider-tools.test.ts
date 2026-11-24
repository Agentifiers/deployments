import { describe, expect, test } from "bun:test";
import {
  ProviderNativeExecutionKnownFailureError,
  ProviderNativeExecutionOutcomeUnknownError,
} from "@deployments-ai/tools";
import { ProviderConnectionRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";

import {
  bindProviderToolMessageToConnection,
  processProviderToolRecords,
  providerToolUnknownOutcomeAuditId,
  type ProviderToolMessage,
} from "./provider-tools.ts";

const event = {
  Records: [
    {
      body: JSON.stringify({
        connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        credentialPurpose: "provider-api",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        externalAccountId: "sendgrid-account-1",
        idempotencyKey: "run-1:sendgrid.email.send",
        input: { body: { from: { email: "sender@example.com" }, subject: "Approved send" } },
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        provider: "sendgrid",
        reference: {
          credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          generation: 1,
          store: "dynamodb-kms",
        },
        toolName: "sendgrid.email.send",
      }),
      messageId: "message-1",
    },
  ],
};

function providerConnection(
  options: { readonly authMethod?: string; readonly externalAccountId?: string | null } = {},
) {
  return Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-connection" as const,
      data: {
        authMethod: options.authMethod ?? "api-key",
        createdAt: "2026-07-24T00:00:00.000Z",
        credentialRef: {
          credentialId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          generation: 1,
          store: "dynamodb-kms" as const,
        },
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        ...(options.externalAccountId === null
          ? {}
          : { externalAccountId: options.externalAccountId ?? "sendgrid-account-1" }),
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        providerKey: "sendgrid",
        scopes: [],
        status: "active" as const,
        updatedAt: "2026-07-24T00:00:00.000Z",
        version: 1,
      },
    }),
  );
}

describe("provider tool queue handling", () => {
  test("binds queue metadata to the active persisted provider connection", () => {
    const message = JSON.parse(event.Records[0]!.body) as ProviderToolMessage;
    expect(bindProviderToolMessageToConnection(message, providerConnection())).toEqual(message);

    for (const changed of [
      { ...message, externalAccountId: "attacker-account" },
      { ...message, provider: "postmark" },
      {
        ...message,
        reference: { ...(message.reference as object), generation: 2 },
      },
      { ...message, credentialPurpose: "provider-oauth-token" as const },
    ]) {
      expect(() => bindProviderToolMessageToConnection(changed, providerConnection())).toThrow(
        "does not match the persisted provider connection",
      );
    }
  });

  test("uses retained queue identity for legacy OAuth connections", () => {
    const message = {
      ...(JSON.parse(event.Records[0]!.body) as ProviderToolMessage),
      credentialPurpose: "provider-oauth-token" as const,
    };
    expect(
      bindProviderToolMessageToConnection(
        message,
        providerConnection({ authMethod: "oauth", externalAccountId: null }),
      ),
    ).toEqual(message);
    expect(() =>
      bindProviderToolMessageToConnection(
        { ...message, credentialPurpose: "provider-api" },
        providerConnection({ externalAccountId: null }),
      ),
    ).toThrow("not active or complete");
  });

  test("scopes quarantine identity to the provider account and credential generation", () => {
    const message = JSON.parse(event.Records[0]!.body) as ProviderToolMessage;
    expect(providerToolUnknownOutcomeAuditId(message)).not.toBe(
      providerToolUnknownOutcomeAuditId({ ...message, externalAccountId: "sendgrid-account-2" }),
    );
    expect(providerToolUnknownOutcomeAuditId(message)).not.toBe(
      providerToolUnknownOutcomeAuditId({
        ...message,
        reference: {
          ...(message.reference as Readonly<Record<string, unknown>>),
          generation: 2,
        },
      }),
    );
    expect(providerToolUnknownOutcomeAuditId(message)).not.toBe(
      providerToolUnknownOutcomeAuditId({
        ...message,
        input: { body: { from: { email: "sender@example.com" }, subject: "Different send" } },
      }),
    );
  });
  test("retries failures that are known not to have dispatched", async () => {
    const result = await processProviderToolRecords(event, {
      executeMessage: async () => {
        throw new ProviderNativeExecutionKnownFailureError(
          "sendgrid.email.send",
          new Error("request rejected before dispatch"),
        );
      },
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
  });

  test("retries ambiguous mutations when durable quarantine is unavailable", async () => {
    const result = await processProviderToolRecords(event, {
      executeMessage: async () => {
        throw new ProviderNativeExecutionOutcomeUnknownError(
          "sendgrid.email.send",
          new Error("response lost after dispatch"),
        );
      },
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
  });

  test("acknowledges ambiguous mutations only after durable quarantine", async () => {
    const quarantined: string[] = [];
    const result = await processProviderToolRecords(event, {
      executeMessage: async () => {
        throw new ProviderNativeExecutionOutcomeUnknownError(
          "sendgrid.email.send",
          new Error("response lost after dispatch"),
        );
      },
      quarantineOutcome: async ({ messageId }) => void quarantined.push(messageId),
    });

    expect(quarantined).toEqual(["message-1"]);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test("does not redispatch an already quarantined provider mutation", async () => {
    let executed = false;
    const result = await processProviderToolRecords(event, {
      executeMessage: async () => {
        executed = true;
      },
      isOutcomeQuarantined: async () => true,
    });

    expect(executed).toBe(false);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test("normalizes retained messages before quarantine and execution", async () => {
    const legacy = {
      Records: [
        {
          body: JSON.stringify({
            ...(JSON.parse(event.Records[0]!.body) as Record<string, unknown>),
            connectionId: undefined,
            credentialPurpose: undefined,
          }),
          messageId: "legacy-message",
        },
      ],
    };
    let executed: ProviderToolMessage | undefined;
    const result = await processProviderToolRecords(legacy, {
      executeMessage: async (message) => void (executed = message),
      normalizeMessage: async (message) => ({
        ...message,
        connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        credentialPurpose: "provider-api",
      }),
    });

    expect(executed).toMatchObject({
      connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      credentialPurpose: "provider-api",
    });
    expect(result).toEqual({ batchItemFailures: [] });
  });

  test("retries queue parsing, credential, and other non-executor failures", async () => {
    const result = await processProviderToolRecords(event, {
      executeMessage: async () => {
        throw new Error("credential vault unavailable");
      },
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "message-1" }] });
  });
});
