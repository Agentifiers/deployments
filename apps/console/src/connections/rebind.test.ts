import type { PublicId } from "@deployments-ai/api-contract/primitives";
import {
  ConnectionVerificationResponse,
  ProviderConnectionResponse,
} from "@deployments-ai/api-contract/providers";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { withToolBindings } from "../agents/runtime-config.ts";
import type { VerificationView } from "./connection-state.ts";
import {
  ACTIVE_CAPABILITY,
  AFTER,
  connection,
  D1,
  D2,
  D4,
  deployment,
  G1,
  G2,
  G3,
  grant,
  JUST_BEFORE,
  observe,
  publicId,
  R1,
  R2,
  ROTATE,
  SINCE,
  STOPPED,
  WS,
  WS2,
  WS3,
  X,
} from "./rebind.fixture.ts";
import {
  parseRebindSearch,
  planRebind,
  reauthorizeReturn,
  repinChanges,
  revokeOldStep,
  searchAfterRotate,
  searchSkipping,
  type ReauthorizeSearch,
  type RebindObservation,
  type RebindPhase,
  type RebindSearch,
} from "./rebind.ts";

describe("planRebind after a rotate", () => {
  test("walks verification, granting, and pinning to done, leaving stopped deployments", () => {
    const rotated = connection("reauthorization-required");
    const staleCapability = { ...ACTIVE_CAPABILITY, status: "stale" };
    const pinning = [deployment(D1, { a: G1.id, c: G3.id }), deployment(D2, { b: G2.id }), STOPPED];
    const repinned = [
      deployment(D1, { a: R1.id, c: G3.id }),
      deployment(D2, { b: R2.id }),
      STOPPED,
    ];

    const unverified = planRebind(
      observe({
        deployments: pinning,
        grants: [G1, G2, G3],
        old: rotated,
        target: rotated,
        targetCapabilities: [staleCapability],
      }),
      ROTATE,
    );
    expect(unverified.phase).toEqual({
      kind: "awaiting-verification",
      next: { connectionId: X, kind: "verify" },
    });
    expect(unverified.templates.map((template) => template.grant.id)).toEqual([G1.id, G2.id]);
    expect(
      unverified.revokedEarlier.map((earlier) => [earlier.grant.id, earlier.included]),
    ).toEqual([[G3.id, false]]);

    expect(
      planRebind(observe({ deployments: pinning, grants: [G1, G2, G3] }), ROTATE).phase,
    ).toEqual({
      kind: "granting",
      next: {
        body: {
          connectionId: X,
          externalResourceConstraints: { region: "us" },
          purpose: "agent-runtime",
          scopes: ["account:read"],
          workspaceId: WS,
        },
        key: `rebind:${X}:${X}:grant:${G1.id}:0`,
        kind: "create-grant",
        templateId: G1.id,
      },
      remaining: 2,
    });

    const afterFirstGrant = planRebind(
      observe({ deployments: pinning, grants: [G1, G2, G3, R1] }),
      ROTATE,
    );
    expect(afterFirstGrant.phase.kind === "granting" && afterFirstGrant.phase.next.key).toBe(
      `rebind:${X}:${X}:grant:${G2.id}:0`,
    );

    const granted = planRebind(
      observe({ deployments: pinning, grants: [G1, G2, G3, R1, R2] }),
      ROTATE,
    );
    expect(granted.phase).toEqual({
      kind: "pinning",
      next: {
        deploymentId: D1,
        keyPrefix: `rebind:${X}:${X}:pin:${D1}`,
        kind: "pin",
        replacements: { [G1.id]: R1.id, [G2.id]: R2.id },
      },
      remaining: 2,
    });
    expect(granted.repinDeploymentIds).toEqual([D1, D2]);

    expect(
      planRebind(observe({ deployments: repinned, grants: [G1, G2, G3, R1, R2] }), ROTATE).phase,
    ).toEqual({ kind: "done", needsOperator: [D1], repinned: 2, restored: 2, skipped: 0 });
  });

  test("restores a grant revoked at since even when nothing pins it, not one 1 ms earlier", () => {
    const plan = planRebind(
      observe({ deployments: [deployment(D1, { c: G3.id })], grants: [G1, G3] }),
      ROTATE,
    );
    expect(plan.templates.map((template) => [template.grant.id, template.pinnedBy])).toEqual([
      [G1.id, []],
    ]);
    expect(plan.revokedEarlier.map((earlier) => earlier.grant.id)).toEqual([G3.id]);
  });

  test("restores an earlier revocation only when the operator opts it in", () => {
    const deployments = [deployment(D1, { c: G3.id })];
    const restoreLink: RebindSearch = { kind: "rotate" };
    expect(planRebind(observe({ deployments, grants: [G3] }), restoreLink).phase).toEqual({
      kind: "done",
      needsOperator: [D1],
      repinned: 0,
      restored: 0,
      skipped: 0,
    });
    const optedIn = planRebind(observe({ deployments, grants: [G3] }), {
      ...restoreLink,
      include: [G3.id],
    });
    expect(optedIn.phase.kind === "granting" && optedIn.phase.next.key).toBe(
      `rebind:${X}:${X}:grant:${G3.id}:0`,
    );
    expect(optedIn.revokedEarlier.map((earlier) => earlier.included)).toEqual([true]);
  });

  test("a second rotation from the connection page leaves the first one's pins to the operator", () => {
    const secondRotation: RebindSearch = { kind: "rotate", since: AFTER };
    const deployments = [deployment(D1, { a: G1.id })];
    const plan = planRebind(observe({ deployments, grants: [G1, G2] }), secondRotation);
    expect(plan.templates).toEqual([]);
    expect(plan.revokedEarlier.map((earlier) => [earlier.grant.id, earlier.included])).toEqual([
      [G1.id, false],
    ]);
    expect(plan.phase).toEqual({
      kind: "done",
      needsOperator: [D1],
      repinned: 0,
      restored: 0,
      skipped: 0,
    });
    const optedIn = planRebind(observe({ deployments, grants: [G1, G2] }), {
      ...secondRotation,
      include: [G1.id],
    });
    expect(optedIn.phase.kind === "granting" && optedIn.phase.next.key).toBe(
      `rebind:${X}:${X}:grant:${G1.id}:0`,
    );
  });

  test("rotating again after a replacement restores with a key no earlier attempt spent", () => {
    const T2 = "2026-09-10T12:10:00.000Z";
    const formerReplacement = grant(R1.id, "revoked", { createdAt: AFTER, updatedAt: T2 });
    const deployments = [deployment(D1, { a: formerReplacement.id })];
    const plan = planRebind(observe({ deployments, grants: [G1, formerReplacement] }), ROTATE);
    expect(plan.templates.map((template) => template.grant.id)).toEqual([G1.id, R1.id]);
    expect(plan.phase.kind === "granting" && plan.phase.next.key).toBe(
      `rebind:${X}:${X}:grant:${G1.id}:1`,
    );
    const R3 = grant(publicId("R3"), "active", { createdAt: T2, updatedAt: T2 });
    const restored = planRebind(
      observe({ deployments, grants: [G1, formerReplacement, R3] }),
      ROTATE,
    );
    expect(restored.phase.kind === "pinning" && restored.phase.next.replacements).toEqual({
      [G1.id]: R3.id,
      [R1.id]: R3.id,
    });
  });

  test("stops at the failed verification the URL names, and a reload plans the same phase", () => {
    const rotated = connection("reauthorization-required");
    const failed: VerificationView = Schema.decodeUnknownSync(ConnectionVerificationResponse)({
      connectionId: X,
      createdAt: AFTER,
      error: { code: "provider_verification_failed" },
      id: publicId("V1"),
      providerKey: "demio",
      status: "failed",
      updatedAt: AFTER,
      version: 2,
    });
    const observation = observe({
      deployments: [],
      grants: [],
      old: rotated,
      target: rotated,
      targetCapabilities: [],
      verification: failed,
    });
    const search = { ...ROTATE, verification: failed.id };
    expect(planRebind(observation, search).phase).toEqual({
      kind: "verification-failed",
      verification: failed,
    });
    expect(planRebind(observation, search)).toEqual(planRebind(observation, search));
  });

  test("stops at a scope gap until the operator skips the grant", () => {
    const wide = grant(G2.id, "revoked", {
      createdAt: "2026-09-03T00:00:00.000Z",
      scopes: ["account:read", "registrations:write"],
      workspaceId: WS2,
    });
    const deployments = [deployment(D1, { a: R1.id }), deployment(D2, { b: G2.id })];
    const gap = planRebind(observe({ deployments, grants: [G1, wide, R1] }), ROTATE);
    expect(
      gap.phase.kind === "scope-gap" &&
        gap.phase.templates.map((template) => [template.grant.id, template.missingScopes]),
    ).toEqual([[G2.id, ["registrations:write"]]]);

    expect(
      planRebind(observe({ deployments, grants: [G1, wide, R1] }), { ...ROTATE, skip: [G2.id] })
        .phase,
    ).toEqual({ kind: "done", needsOperator: [D2], repinned: 1, restored: 1, skipped: 1 });
  });

  test("leaves failed and deploying deployments to the operator", () => {
    const failed = deployment(
      D2,
      { b: G2.id },
      { currentState: "failed", desiredState: "running" },
    );
    const deploying = deployment(
      D4,
      { a: G1.id },
      { currentState: "deploying", desiredState: "running" },
    );
    const grants = [G1, G2, R1, R2];
    const plan = planRebind(
      observe({ deployments: [deployment(D1, { a: G1.id }), failed, deploying], grants }),
      ROTATE,
    );
    expect(plan.repinDeploymentIds).toEqual([D1]);
    expect(
      planRebind(
        observe({ deployments: [deployment(D1, { a: R1.id }), failed, deploying], grants }),
        ROTATE,
      ).phase,
    ).toEqual({ kind: "done", needsOperator: [D2, D4], repinned: 1, restored: 2, skipped: 0 });
  });

  test("blocks on a step that failed for good until the operator skips it", () => {
    const deployments = [deployment(D1, { a: G1.id }), deployment(D2, { b: G2.id })];
    const archivedWorkspace = { detail: "Workspace was not found.", status: 404 };
    const blocked = planRebind(observe({ deployments, grants: [G1, G2, R1] }), ROTATE, {
      problem: archivedWorkspace,
      stepKey: `rebind:${X}:${X}:grant:${G2.id}:0`,
    });
    expect(
      blocked.phase.kind === "blocked" && [blocked.phase.step.kind, blocked.phase.problem],
    ).toEqual(["create-grant", archivedWorkspace]);
    expect(blocked.phase.kind === "blocked" && searchSkipping(ROTATE, blocked.phase.step)).toEqual({
      kind: "rotate",
      since: SINCE,
      skip: [G2.id],
    });
    const skipped = planRebind(
      observe({ deployments, grants: [G1, G2, R1] }),
      { ...ROTATE, skip: [G2.id] },
      {
        problem: archivedWorkspace,
        stepKey: `rebind:${X}:${X}:grant:${G2.id}:0`,
      },
    );
    expect(skipped.phase.kind === "pinning" && skipped.phase.next.deploymentId).toBe(D1);

    const pinRefused = { code: "release_archived", status: 409 };
    const pinBlocked = planRebind(observe({ deployments, grants: [G1, G2, R1, R2] }), ROTATE, {
      problem: pinRefused,
      stepKey: `rebind:${X}:${X}:pin:${D1}`,
    });
    expect(
      pinBlocked.phase.kind === "blocked" && searchSkipping(ROTATE, pinBlocked.phase.step),
    ).toEqual({ kind: "rotate", since: SINCE, skipDeployments: [D1] });
    expect(
      planRebind(
        observe({
          deployments: [deployments[0]!, deployment(D2, { b: R2.id })],
          grants: [G1, G2, R1, R2],
        }),
        { ...ROTATE, skipDeployments: [D1] },
      ).phase,
    ).toEqual({ kind: "done", needsOperator: [D1], repinned: 1, restored: 2, skipped: 0 });

    const rotated = connection("reauthorization-required");
    const verifyBlocked = planRebind(
      observe({ deployments, grants: [G1], old: rotated, target: rotated, targetCapabilities: [] }),
      ROTATE,
      { problem: { code: "connection_not_verifiable", status: 422 }, stepKey: "verify" },
    );
    expect(
      verifyBlocked.phase.kind === "blocked" && searchSkipping(ROTATE, verifyBlocked.phase.step),
    ).toBe(undefined);
  });

  test("gives grants with one fingerprint a single replacement", () => {
    const twin = grant(publicId("G4"), "revoked", { createdAt: "2026-09-04T00:00:00.000Z" });
    const plan = planRebind(
      observe({ deployments: [deployment(D1, { a: G1.id, b: twin.id })], grants: [G1, twin] }),
      ROTATE,
    );
    expect(plan.phase.kind === "granting" && plan.phase.remaining).toBe(1);
    const restored = planRebind(
      observe({
        deployments: [deployment(D1, { a: G1.id, b: twin.id })],
        grants: [G1, twin, R1],
      }),
      ROTATE,
    );
    expect(restored.phase.kind === "pinning" && restored.phase.next.replacements).toEqual({
      [G1.id]: R1.id,
      [twin.id]: R1.id,
    });
  });
});

describe("planRebind after a reauthorization", () => {
  const Y = publicId("Y");
  const REVOKED_AT = "2026-09-10T12:20:00.000Z";
  const oauth = (id: PublicId, status: string, overrides: Readonly<Record<string, unknown>> = {}) =>
    Schema.decodeUnknownSync(ProviderConnectionResponse)({
      authMethod: "oauth",
      createdAt: "2026-09-01T00:00:00.000Z",
      displayName: "QA GitHub",
      externalAccountId: "user-42",
      hasCredential: true,
      id,
      providerKey: "github",
      scopes: ["account:read"],
      status,
      updatedAt: SINCE,
      version: 4,
      ...overrides,
    });
  const A1 = grant(publicId("A1"), "active", { updatedAt: "2026-09-05T00:00:00.000Z" });
  const N1 = {
    ...grant(publicId("N1"), "active", { createdAt: AFTER, updatedAt: AFTER }),
    connectionId: Y,
  };
  const old = oauth(X, "reauthorization-required");
  const target = oauth(Y, "active", { createdAt: AFTER, updatedAt: AFTER });
  const pinned = [deployment(D1, { a: A1.id })];
  const waiting: RebindObservation = {
    deployments: pinned,
    grants: [A1],
    now: "2026-09-10T12:10:00.000Z",
    old,
    targetCapabilities: [],
  };
  const returned: ReauthorizeSearch = { kind: "reauthorize", since: SINCE, target: Y };

  test("waits for an authorization ordered by the old connection, restoring its active grants", () => {
    const plan = planRebind(waiting, { kind: "reauthorize" });
    expect(plan.phase).toEqual({
      kind: "awaiting-authorization",
      order: { kind: "revoke-first" },
      since: SINCE,
    });
    expect(plan.templates.map((template) => template.grant.id)).toEqual([A1.id]);
  });

  test("after a revoke-first, restores the grants its revocation revoked", () => {
    const revoked = grant(A1.id, "revoked");
    const plan = planRebind(
      {
        ...waiting,
        grants: [revoked, G3],
        old: oauth(X, "disconnected"),
        deployments: [deployment(D1, { a: A1.id, c: G3.id })],
      },
      { kind: "reauthorize" },
    );
    expect(plan.phase).toEqual({
      kind: "awaiting-authorization",
      order: { kind: "authorize-first" },
      since: SINCE,
    });
    expect(plan.templates.map((template) => template.grant.id)).toEqual([A1.id]);
    expect(plan.revokedEarlier.map((earlier) => earlier.grant.id)).toEqual([G3.id]);
  });

  test("leaves a grant revoked by hand on a live old connection to the operator", () => {
    const T = "2026-09-10T12:01:00.000Z";
    const pinnedByHand = grant(publicId("GR"), "revoked", { updatedAt: T, workspaceId: WS2 });
    const unpinnedByHand = grant(publicId("GN"), "revoked", { updatedAt: T, workspaceId: WS3 });
    const plan = planRebind(
      {
        ...waiting,
        deployments: [deployment(D1, { a: A1.id }), deployment(D2, { b: pinnedByHand.id })],
        grants: [A1, pinnedByHand, unpinnedByHand],
        old: oauth(X, "active"),
      },
      { kind: "reauthorize", since: SINCE },
    );
    expect(plan.templates.map((template) => template.grant.id)).toEqual([A1.id]);
    expect(plan.revokedEarlier.map((earlier) => earlier.grant.id)).toEqual([pinnedByHand.id]);
  });

  test("a refused authorization may be the account the old connection still holds", () => {
    const failed: ReauthorizeSearch = {
      error: "authorization_failed",
      kind: "reauthorize",
      since: SINCE,
    };
    expect(planRebind(waiting, failed).phase).toEqual({
      collisionPossible: true,
      error: "authorization_failed",
      kind: "authorization-failed",
      since: SINCE,
    });
    expect(planRebind({ ...waiting, old: oauth(X, "disconnected") }, failed).phase).toEqual({
      collisionPossible: false,
      error: "authorization_failed",
      kind: "authorization-failed",
      since: SINCE,
    });
  });

  test("a declined consent never blames the account the old connection holds", () => {
    expect(
      planRebind(waiting, { error: "access_denied", kind: "reauthorize", since: SINCE }).phase,
    ).toEqual({
      collisionPossible: false,
      error: "access_denied",
      kind: "authorization-failed",
      since: SINCE,
    });
  });

  test("rejects a target for another provider, created before the reauthorization, or unknown", () => {
    const wrong: RebindPhase = {
      collisionPossible: false,
      error: "wrong-provider",
      kind: "authorization-failed",
      since: SINCE,
    };
    expect(
      planRebind(
        { ...waiting, target: oauth(Y, "active", { createdAt: AFTER, providerKey: "notion" }) },
        returned,
      ).phase,
    ).toEqual(wrong);
    expect(
      planRebind({ ...waiting, target: oauth(Y, "active", { createdAt: JUST_BEFORE }) }, returned)
        .phase,
    ).toEqual(wrong);
    expect(
      planRebind(
        { ...waiting, target: oauth(Y, "active", { createdAt: "2026-09-05T00:00:00.000Z" }) },
        { ...returned, since: "2001-01-01T00:00:00.000Z" },
      ).phase,
    ).toEqual(wrong);
    expect(planRebind(waiting, returned).phase).toEqual(wrong);
  });

  test("verifies the target, moves grants and pins to it, then revokes the old connection", () => {
    const capability = { ...ACTIVE_CAPABILITY, connectionId: Y };
    expect(planRebind({ ...waiting, target }, returned).phase).toEqual({
      kind: "awaiting-verification",
      next: { connectionId: Y, kind: "verify" },
    });
    const verified = { ...waiting, target, targetCapabilities: [capability] };
    expect(planRebind(verified, returned).phase).toEqual({
      kind: "granting",
      next: {
        body: {
          connectionId: Y,
          externalResourceConstraints: { region: "us" },
          purpose: "agent-runtime",
          scopes: ["account:read"],
          workspaceId: WS,
        },
        key: `rebind:${X}:${Y}:grant:${A1.id}:0`,
        kind: "create-grant",
        templateId: A1.id,
      },
      remaining: 1,
    });
    expect(planRebind({ ...verified, grants: [A1, N1] }, returned).phase).toEqual({
      kind: "pinning",
      next: {
        deploymentId: D1,
        keyPrefix: `rebind:${X}:${Y}:pin:${D1}`,
        kind: "pin",
        replacements: { [A1.id]: N1.id },
      },
      remaining: 1,
    });
    const repinned = [deployment(D1, { a: N1.id })];
    expect(
      planRebind({ ...verified, deployments: repinned, grants: [A1, N1] }, returned).phase,
    ).toEqual({
      kind: "revoking-old",
      next: {
        connectionId: X,
        expectedVersion: 4,
        key: `rebind:${X}:${Y}:revoke:4`,
        kind: "revoke-old",
      },
    });
    const afterRevoke = {
      ...verified,
      deployments: repinned,
      grants: [grant(A1.id, "revoked", { updatedAt: REVOKED_AT }), N1],
      old: oauth(X, "disconnected", { updatedAt: REVOKED_AT, version: 5 }),
    };
    expect(planRebind(afterRevoke, returned).phase).toEqual({
      kind: "done",
      needsOperator: [],
      repinned: 1,
      restored: 1,
      skipped: 0,
    });
  });

  test("revoking first has no target in its key, and neither revoke can be skipped", () => {
    expect(revokeOldStep(old, undefined)).toEqual({
      connectionId: X,
      expectedVersion: 4,
      key: `rebind:${X}:pending:revoke:4`,
      kind: "revoke-old",
    });
    expect(searchSkipping(returned, revokeOldStep(old, Y))).toBe(undefined);
    expect(
      searchSkipping(returned, { deploymentId: D1, keyPrefix: "k", kind: "pin", replacements: {} }),
    ).toEqual({ kind: "reauthorize", since: SINCE, skipDeployments: [D1], target: Y });
  });

  test("carries the operator's choices from the provider callback to the rebind page", () => {
    expect(
      reauthorizeReturn({
        connection_id: Y,
        include: [G3.id],
        provider: "github",
        rebind: X,
        since: "2026-09-10T12:00:00Z",
        skip: [A1.id, "not-an-id"],
      }),
    ).toEqual({
      oldConnectionId: X,
      search: { include: [G3.id], kind: "reauthorize", since: SINCE, skip: [A1.id], target: Y },
    });
    expect(reauthorizeReturn({ connection_id: Y, provider: "github" })).toBe(undefined);
  });
});

describe("searchAfterRotate", () => {
  test("keeps the first rotation's since and choices when rotating again", () => {
    expect(
      searchAfterRotate(AFTER, { ...ROTATE, skip: [G2.id], verification: publicId("V1") }),
    ).toEqual({
      kind: "rotate",
      since: SINCE,
      skip: [G2.id],
    });
    expect(searchAfterRotate(AFTER)).toEqual({ kind: "rotate", since: AFTER });
  });
});

describe("repinChanges", () => {
  const P1 = publicId("P1");
  const config = {
    agentBindings: { helper: { agentDeploymentId: "01K000000000000000000000D9" } },
    apiVersion: "agents.deployments.ai/v1",
    brainRetrievalMode: "hybrid",
    kind: "AgentDeploymentConfig",
    toolAuthorizations: {
      a: { authorizationId: G1.id, toolPolicyId: P1 },
      c: { authorizationId: G3.id },
    },
  } as const;

  test("through withToolBindings, swaps only the replaced pins and keeps policies and bindings", () => {
    expect(withToolBindings(config, repinChanges(config, { [G1.id]: R1.id }))).toEqual({
      agentBindings: {
        helper: { agentDeploymentId: "01K000000000000000000000D9" },
      },
      apiVersion: "agents.deployments.ai/v1",
      brainRetrievalMode: "hybrid",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: {
        a: { authorizationId: R1.id, toolPolicyId: P1 },
        c: { authorizationId: G3.id },
      },
    });
  });

  test("is empty when no pin matches", () => {
    expect(repinChanges(config, { [publicId("G9")]: publicId("R9") })).toEqual({});
    expect(repinChanges(undefined, { [G1.id]: R1.id })).toEqual({});
  });
});

describe("parseRebindSearch", () => {
  test("keeps a valid timestamp, verification, and ID lists", () => {
    expect(
      parseRebindSearch({
        include: ["01K00000000000000000000GR3"],
        kind: "rotate",
        since: SINCE,
        skip: ["01K00000000000000000000GR2", "not-an-id"],
        skipDeployments: [],
        verification: "01K00000000000000000000VER",
      }),
    ).toEqual({
      include: ["01K00000000000000000000GR3"],
      kind: "rotate",
      since: SINCE,
      skip: ["01K00000000000000000000GR2"],
      verification: "01K00000000000000000000VER",
    });
    expect(parseRebindSearch({ since: "2026-09-10T12:00:00Z" })).toEqual({
      kind: "rotate",
      since: SINCE,
    });
    expect(parseRebindSearch({ since: "yesterday", verification: "V1" })).toEqual({
      kind: "rotate",
    });
  });

  test("reads a reauthorization's target and callback error", () => {
    expect(
      parseRebindSearch({ error: "access_denied", kind: "reauthorize", since: SINCE, target: "x" }),
    ).toEqual({ error: "access_denied", kind: "reauthorize", since: SINCE });
    expect(
      parseRebindSearch({
        error: "server_error",
        kind: "reauthorize",
        target: "01K00000000000000000000TGT",
      }),
    ).toEqual({ kind: "reauthorize", target: "01K00000000000000000000TGT" });
  });
});
