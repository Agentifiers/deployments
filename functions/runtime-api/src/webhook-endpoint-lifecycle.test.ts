import { describe, expect, test } from "bun:test";
import type { CredentialVaultReference, PlatformRecord } from "@deployments-ai/db";
import { webhookApiFixture, now } from "./webhook-api.fixture.ts";
import { disableWebhook, enableWebhook, updateWebhook } from "./webhook-endpoint-mutations.ts";
import { archiveWebhook, createWebhook, loadWebhook } from "./webhook-operations.ts";
import { rotateWebhookSecret } from "./webhook-secret-operations.ts";

const input = {
  eventTypes: ["run.completed"],
  name: "Run completion",
  url: "https://hooks.example.com/platform",
};

function eventsOf(
  operations: readonly { readonly kind: string; readonly record?: PlatformRecord }[],
) {
  return operations.flatMap((operation) =>
    operation.record?.itemType === "semantic-event" ? [operation.record] : [],
  );
}

describe("webhook endpoint lifecycle", () => {
  test("rotates the signing secret in one transaction and returns it once", async () => {
    const f = webhookApiFixture();
    const created = await createWebhook(f.dependencies, f.caller, input);
    const transactionsBefore = f.memory.transactions.length;

    const rotated = await rotateWebhookSecret(f.dependencies, f.caller, created.id, {});

    expect(f.memory.transactions).toHaveLength(transactionsBefore + 1);
    const operations = f.memory.transactions.at(-1)!;
    expect(
      operations
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(
      expect.arrayContaining(["credential-vault-entry", "webhook-endpoint", "semantic-event"]),
    );
    const [event] = eventsOf(operations);
    expect(event?.data).toMatchObject({
      eventType: "webhook.endpoint.secret-rotated",
      payload: {
        previousSecretExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        webhookEndpointId: created.id,
      },
    });
    expect(JSON.stringify(operations)).not.toContain(rotated.signingSecret);
    expect(JSON.stringify(operations)).not.toContain(created.signingSecret);

    expect(rotated.signingSecret).not.toBe(created.signingSecret);
    expect(rotated).toMatchObject({
      previousSigningSecretExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      signingSecretRotatedAt: now.toISOString(),
      version: 1,
    });
    expect(rotated).not.toHaveProperty("signingSecretRef");
    const endpoint = await loadWebhook(f.dependencies, f.caller, created.id);
    const reference = endpoint.data.signingSecretRef as CredentialVaultReference;
    expect(reference.generation).toBe(1);
    const stored = await f.vault.read({
      environmentId: f.caller.scope.environmentId,
      expectedIdentity: {
        ownerId: created.id,
        ownerType: "webhook-endpoint",
        projectId: f.caller.scope.projectId,
        purpose: "webhook-signing",
      },
      organizationId: f.caller.scope.organizationId,
      reference,
    });
    expect(stored.values).toEqual({
      previousSigningSecret: created.signingSecret,
      signingSecret: rotated.signingSecret,
    });

    const immediate = await rotateWebhookSecret(f.dependencies, f.caller, created.id, {
      previousSecretExpiresInSeconds: 0,
    });
    expect(immediate).not.toHaveProperty("previousSigningSecretExpiresAt");
    expect(eventsOf(f.memory.transactions.at(-1)!)[0]?.data.payload).toEqual({
      webhookEndpointId: created.id,
    });
  });

  test("refuses rotation for archived and externally managed endpoints", async () => {
    const f = webhookApiFixture();
    const external = f.seedEndpoint({ secretsManager: true });
    expect(
      rotateWebhookSecret(f.dependencies, f.caller, external.data.id, {}),
    ).rejects.toMatchObject({ code: "webhook_secret_externally_managed", status: 409 });
    const archived = f.seedEndpoint({ data: { status: "archived" } });
    expect(
      rotateWebhookSecret(f.dependencies, f.caller, archived.data.id, {}),
    ).rejects.toMatchObject({ code: "webhook_archived", status: 409 });
    expect(f.memory.transactions).toEqual([]);
  });

  test("disables and enables an endpoint with lifecycle events", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint();

    const disabled = await disableWebhook(f.dependencies, f.caller, endpoint.data.id);
    expect(disabled).toMatchObject({
      disabledAt: now.toISOString(),
      disabledReason: "manual",
      status: "disabled",
    });
    expect(eventsOf(f.memory.transactions.at(-1)!)[0]?.data).toMatchObject({
      eventType: "webhook.endpoint.disabled",
      payload: { reason: "manual", webhookEndpointId: endpoint.data.id },
    });
    expect(await disableWebhook(f.dependencies, f.caller, endpoint.data.id)).toEqual(disabled);
    expect(f.memory.transactions).toHaveLength(1);

    const enabled = await enableWebhook(f.dependencies, f.caller, endpoint.data.id);
    expect(enabled).toMatchObject({ consecutiveFailures: 0, status: "active" });
    expect(enabled).not.toHaveProperty("disabledAt");
    expect(enabled).not.toHaveProperty("disabledReason");
    expect(eventsOf(f.memory.transactions.at(-1)!)[0]?.data).toMatchObject({
      aggregateVersion: 2,
      eventType: "webhook.endpoint.enabled",
    });
    expect(await enableWebhook(f.dependencies, f.caller, endpoint.data.id)).toEqual(enabled);
    expect(f.memory.transactions).toHaveLength(2);
  });

  test("re-enabling an automatically disabled endpoint clears its failure streak", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint({
      data: {
        consecutiveFailures: 20,
        disabledAt: now.toISOString(),
        disabledReason: "consecutive-failures",
        status: "disabled",
      },
    });
    const enabled = await enableWebhook(f.dependencies, f.caller, endpoint.data.id);
    expect(enabled).toMatchObject({ consecutiveFailures: 0, status: "active" });
    expect(f.read(endpoint).data).not.toHaveProperty("consecutiveFailures");
    const archived = f.seedEndpoint({ data: { status: "archived" } });
    for (const transition of [disableWebhook, enableWebhook]) {
      expect(transition(f.dependencies, f.caller, archived.data.id)).rejects.toMatchObject({
        code: "webhook_archived",
        status: 409,
      });
    }
  });

  test("updates fields, clears filters, and rejects private URLs", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint({ data: { resourceFilters: { aggregateTypes: ["run"] } } });
    const updated = await updateWebhook(f.dependencies, f.caller, endpoint.data.id, {
      eventTypes: ["run.failed", "run.completed"],
      name: "Renamed",
      resourceFilters: null,
      url: "https://receiver.example.com/hooks",
    });
    expect(updated).toMatchObject({
      eventTypes: ["run.completed", "run.failed"],
      name: "Renamed",
      url: "https://receiver.example.com/hooks",
      version: 1,
    });
    expect(updated).not.toHaveProperty("resourceFilters");
    expect(eventsOf(f.memory.transactions.at(-1)!)[0]?.data).toMatchObject({
      eventType: "webhook.endpoint.updated",
      payload: { changedFields: ["eventTypes", "name", "resourceFilters", "url"] },
    });
    expect(
      updateWebhook(f.dependencies, f.caller, endpoint.data.id, { url: "https://10.0.0.1/hook" }),
    ).rejects.toMatchObject({ code: "invalid_webhook_subscription", status: 400 });
    const archived = f.seedEndpoint({ data: { status: "archived" } });
    expect(
      updateWebhook(f.dependencies, f.caller, archived.data.id, { name: "Late" }),
    ).rejects.toMatchObject({ code: "webhook_archived", status: 409 });
  });

  test("archiving a disabled endpoint revokes its secret and releases its slot", async () => {
    const f = webhookApiFixture();
    const created = await createWebhook(f.dependencies, f.caller, input);
    await disableWebhook(f.dependencies, f.caller, created.id);

    const archived = await archiveWebhook(f.dependencies, f.caller, created.id);

    expect(archived.status).toBe("archived");
    const operations = f.memory.transactions.at(-1)!;
    expect(
      operations.some(
        (operation) => operation.kind === "delete" && operation.record.itemType === "unique-claim",
      ),
    ).toBe(true);
    expect(
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "credential-vault-entry" &&
          operation.record.data.status === "revoked",
      ),
    ).toBe(true);
  });
});
