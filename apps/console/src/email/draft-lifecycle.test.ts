import { describe, expect, test } from "bun:test";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { operationAccess } from "../access.ts";
import { DRAFT_STATUSES, draftActions, draftReasonLabel, freshDraft } from "./draft-lifecycle.ts";

const access = (role: "admin" | "member" | "owner" | "viewer") =>
  operationAccess({
    capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
    organizationRole: role,
  });

describe("draft lifecycle", () => {
  test("an owner gets each status's transitions from the runtime's table", () => {
    const owner = access("owner");
    expect(
      Object.fromEntries(DRAFT_STATUSES.map((status) => [status, draftActions(status, owner)])),
    ).toEqual({
      approved: ["send", "cancel"],
      cancelled: [],
      draft: ["submit", "edit", "cancel"],
      failed: [],
      pending_approval: ["approve", "reject", "cancel"],
      queued: [],
      rejected: ["submit", "edit", "cancel"],
      scheduled: ["cancel"],
      sent: [],
    });
  });

  test("approving and rejecting need agent-email admin, which a member lacks", () => {
    const member = access("member");
    expect(draftActions("pending_approval", member)).not.toContain("approve");
    expect(draftActions("pending_approval", member)).not.toContain("reject");
    expect(draftActions("pending_approval", access("admin"))).toEqual([
      "approve",
      "reject",
      "cancel",
    ]);
  });

  test("a token without agent email scopes gets no draft actions", () => {
    expect(draftActions("draft", operationAccess({ capabilities: [] }))).toEqual([]);
  });

  test("a rejected draft keeps its rejection label after it is cancelled", () => {
    const rejectedAt = "2026-10-08T07:10:00.000Z";
    expect(draftReasonLabel({ rejectedAt })).toBe("Rejection reason");
    expect(draftReasonLabel({})).toBe("Failure");
  });
});

describe("send dialog recipients", () => {
  const cached = { toAddresses: ["old@agents.example.com"] };
  const query = { data: cached, error: null, isFetchedAfterMount: false, isFetching: true };

  test("waits for the re-read instead of trusting the cached draft", () => {
    expect(freshDraft(query)).toEqual({ kind: "reading" });
    expect(freshDraft({ ...query, isFetching: false })).toEqual({ kind: "reading" });
  });

  test("uses the draft only once the re-read succeeds", () => {
    const fresh = { toAddresses: ["new@agents.example.com"] };
    expect(
      freshDraft({ ...query, data: fresh, isFetchedAfterMount: true, isFetching: false }),
    ).toEqual({ draft: fresh, kind: "ready" });
  });

  test("reports a failed re-read even though the cache still holds the old draft", () => {
    const error = new Error("The platform API is unavailable.");
    expect(freshDraft({ ...query, error, isFetchedAfterMount: true, isFetching: false })).toEqual({
      error,
      kind: "failed",
    });
  });
});
