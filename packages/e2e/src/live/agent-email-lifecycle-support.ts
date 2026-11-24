import { expect } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { E2eHttpClientService } from "../harness/http-client.ts";
import { cleanupHttpRequest, stringField } from "../harness/live-agent.ts";
import { liveAgentModel } from "../harness/live-model.ts";
import {
  agentEmailIntegerField as integerField,
  agentEmailJson as json,
  agentEmailRecords as records,
} from "./agent-email-proof-support.ts";

type JsonRecord = Record<string, unknown>;
type Headers = Readonly<Record<string, string>>;

/** HTTP client, tenant credential, idempotency prefix, and proof marker for one email run. */
export interface AgentEmailLifecycleClient {
  readonly auth: Headers;
  readonly http: E2eHttpClientService;
  readonly marker: string;
  readonly runKey: string;
}

export function agentEmailManifest(runKey: string, marker: string) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: runKey, name: `E2E email ${runKey}`, version: "1.0.0" },
    spec: {
      capabilities: { tools: [] },
      instructions: `Acknowledge the inbound email marker ${marker} in one short sentence.`,
      model: liveAgentModel.model,
      runtime: liveAgentModel.runtime,
      sandbox: { mode: "none" },
      triggers: ["api", "email"],
    },
  };
}

function listPlacements(client: AgentEmailLifecycleClient) {
  const { auth, http } = client;
  return Effect.gen(function* () {
    const items: JsonRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/placements?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        }),
        200,
        "placement list",
      );
      items.push(...records(page.items, "placement list.items"));
      const nextCursor = page.nextCursor;
      cursor = typeof nextCursor === "string" && nextCursor ? nextCursor : undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Placement pagination repeated a cursor.");
        seenCursors.add(cursor);
      }
    } while (cursor);
    return items;
  });
}

/** Creates an inbox that is archived when the test scope closes. */
export function acquireInbox(client: AgentEmailLifecycleClient, role: string) {
  const { auth, http, marker, runKey } = client;
  return Effect.acquireRelease(
    http
      .request({
        body: {
          clientId: `${runKey}:${role}`,
          localPart: `${role}-${randomUUID().slice(0, 18)}`,
          metadata: { marker, role },
          name: `E2E ${role}`,
        },
        headers: { ...auth, "idempotency-key": `${runKey}:inbox:${role}` },
        method: "POST",
        path: "/v1/agent-email/inboxes",
      })
      .pipe(Effect.map((response) => json(response, 201, `${role} inbox create`))),
    (inbox) =>
      cleanupHttpRequest(
        `${role} inbox`,
        http.request({
          body: { status: "archived" },
          headers: {
            ...auth,
            "idempotency-key": `${runKey}:inbox:${role}:archive`,
          },
          method: "PATCH",
          path: `/v1/agent-email/inboxes/${stringField(inbox, "id", `${role} inbox`)}`,
        }),
      ).pipe(Effect.orDie),
  );
}

/** Renames the target inbox and proves both proof inboxes are listed. */
export function updateAndListInboxes(
  client: AgentEmailLifecycleClient,
  inboxes: { readonly senderInboxId: string; readonly targetInboxId: string },
) {
  const { auth, http, marker, runKey } = client;
  const { senderInboxId, targetInboxId } = inboxes;
  return Effect.gen(function* () {
    const updatedInbox = json(
      yield* http.request({
        body: { name: `E2E target updated ${marker}` },
        headers: { ...auth, "idempotency-key": `${runKey}:inbox:update` },
        method: "PATCH",
        path: `/v1/agent-email/inboxes/${targetInboxId}`,
      }),
      200,
      "target inbox update",
    );
    expect(updatedInbox.name).toContain(marker);
    expect(
      records(
        json(
          yield* http.request({ headers: auth, method: "GET", path: "/v1/agent-email/inboxes" }),
          200,
          "inbox list",
        ).items,
        "inbox list.items",
      ).map((inbox) => inbox.id),
    ).toEqual(expect.arrayContaining([senderInboxId, targetInboxId]));
  });
}

/** Proves the provider-managed hosted domain is verified and readable by ID. */
export function expectHostedDomain(client: AgentEmailLifecycleClient, agentEmailDomain: string) {
  const { auth, http } = client;
  return Effect.gen(function* () {
    const domains = records(
      json(
        yield* http.request({ headers: auth, method: "GET", path: "/v1/agent-email/domains" }),
        200,
        "domain list",
      ).items,
      "domain list.items",
    );
    const hostedDomain = domains.find((domain) => domain.domain === agentEmailDomain);
    expect(hostedDomain).toMatchObject({ providerManaged: true, status: "verified" });
    const domainId = stringField(hostedDomain!, "id", "hosted domain");
    expect(
      json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/domains/${domainId}`,
        }),
        200,
        "domain get",
      ),
    ).toMatchObject({ domain: agentEmailDomain, id: domainId });
  });
}

/**
 * Creates a disposable placement candidate, promotes it only when no active default exists,
 * and proves both placements are listed and readable.
 */
export function acquireDefaultPlacement(client: AgentEmailLifecycleClient, awsRegion: string) {
  const { auth, http, marker, runKey } = client;
  return Effect.gen(function* () {
    const existingPlacements = yield* listPlacements(client);
    const existingDefault = existingPlacements.find(
      (placement) => placement.isDefault === true && placement.status === "active",
    );
    const placementCandidate = yield* Effect.acquireRelease(
      http
        .request({
          body: {
            isDefault: false,
            name: `E2E placement ${marker}`,
            region: awsRegion,
          },
          headers: { ...auth, "idempotency-key": `${runKey}:placement` },
          method: "POST",
          path: "/v1/agent-email/placements",
        })
        .pipe(Effect.map((response) => json(response, 201, "placement create"))),
      (placement) =>
        cleanupHttpRequest(
          "email placement",
          http.request({
            body: { status: "disabled" },
            headers: { ...auth, "idempotency-key": `${runKey}:placement:disable` },
            method: "PATCH",
            path: `/v1/agent-email/placements/${stringField(placement, "id", "placement")}`,
          }),
        ).pipe(Effect.orDie),
    );
    expect(
      placementCandidate,
      `placement did not become active: ${JSON.stringify(placementCandidate)}`,
    ).toMatchObject({
      isDefault: false,
      region: awsRegion,
      status: "active",
    });
    const placementCandidateId = stringField(placementCandidate, "id", "placement candidate");
    const defaultPlacement = existingDefault
      ? existingDefault
      : json(
          yield* http.request({
            body: { isDefault: true },
            headers: { ...auth, "idempotency-key": `${runKey}:placement:promote` },
            method: "PATCH",
            path: `/v1/agent-email/placements/${placementCandidateId}`,
          }),
          200,
          "placement promote",
        );
    expect(defaultPlacement).toMatchObject({
      isDefault: true,
      region: awsRegion,
      status: "active",
    });
    const placementId = stringField(defaultPlacement, "id", "default placement");
    const placements = yield* listPlacements(client);
    expect(placements.map((placement) => placement.id)).toEqual(
      expect.arrayContaining([placementCandidateId, placementId]),
    );
    expect(
      json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/placements/${placementId}`,
        }),
        200,
        "placement get",
      ).id,
    ).toBe(placementId);
  });
}

/** Binds the target inbox to the agent deployment until the test scope closes. */
export function acquireAgentBinding(
  client: AgentEmailLifecycleClient,
  binding: { readonly agentDeploymentId: string; readonly targetInboxId: string },
) {
  const { auth, http, marker, runKey } = client;
  const { agentDeploymentId, targetInboxId } = binding;
  return Effect.gen(function* () {
    const created = yield* Effect.acquireRelease(
      http
        .request({
          body: {
            agentDeploymentId,
            bindingType: "platform_agent",
            metadata: { marker },
          },
          headers: { ...auth, "idempotency-key": `${runKey}:binding` },
          method: "POST",
          path: `/v1/agent-email/inboxes/${targetInboxId}/bindings`,
        })
        .pipe(Effect.map((response) => json(response, 201, "binding create"))),
      (value) =>
        cleanupHttpRequest(
          "email binding",
          http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:binding:delete` },
            method: "DELETE",
            path: `/v1/agent-email/bindings/${stringField(value, "id", "binding")}`,
          }),
        ).pipe(Effect.orDie),
    );
    const bindingId = stringField(created, "id", "binding");
    expect(
      records(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/agent-email/inboxes/${targetInboxId}/bindings`,
          }),
          200,
          "binding list",
        ).items,
        "binding list.items",
      ).map((entry) => entry.id),
    ).toContain(bindingId);
  });
}
/** Changes raw retention until the test scope closes, then restores the previous value. */
export function acquireChangedRetentionPolicy(client: AgentEmailLifecycleClient) {
  const { auth, http, runKey } = client;
  return Effect.gen(function* () {
    const currentPolicy = json(
      yield* http.request({ headers: auth, method: "GET", path: "/v1/agent-email/policy" }),
      200,
      "email policy get",
    );
    const previousRetention = integerField(currentPolicy, "rawRetentionDays", "email policy");
    const changedRetention = previousRetention === 30 ? 31 : 30;
    yield* Effect.acquireRelease(
      http
        .request({
          body: { rawRetentionDays: changedRetention },
          headers: { ...auth, "idempotency-key": `${runKey}:policy:update` },
          method: "PATCH",
          path: "/v1/agent-email/policy",
        })
        .pipe(Effect.map((response) => json(response, 200, "email policy update"))),
      () =>
        cleanupHttpRequest(
          "email policy restore",
          http.request({
            body: { rawRetentionDays: previousRetention },
            headers: { ...auth, "idempotency-key": `${runKey}:policy:restore` },
            method: "PATCH",
            path: "/v1/agent-email/policy",
          }),
        ).pipe(Effect.orDie),
    );
  });
}

/** Suppresses a throwaway address until the test scope closes. */
export function acquireSuppression(client: AgentEmailLifecycleClient) {
  const { auth, http, runKey } = client;
  return Effect.gen(function* () {
    const suppressedAddress = `suppressed-${randomUUID().slice(0, 18)}@example.com`;
    const suppression = yield* Effect.acquireRelease(
      http
        .request({
          body: { address: suppressedAddress, reason: "manual" },
          headers: { ...auth, "idempotency-key": `${runKey}:suppression` },
          method: "POST",
          path: "/v1/agent-email/suppressions",
        })
        .pipe(Effect.map((response) => json(response, 201, "suppression create"))),
      (created) =>
        cleanupHttpRequest(
          "email suppression",
          http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:suppression:remove` },
            method: "POST",
            path: `/v1/agent-email/suppressions/${stringField(created, "id", "suppression")}/remove`,
          }),
        ).pipe(Effect.orDie),
    );
    expect(suppression).toMatchObject({ address: suppressedAddress, reason: "manual" });
  });
}
