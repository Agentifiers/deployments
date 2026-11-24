import { describe, expect, test } from "bun:test";
import { auditDraft, changeEntries, parseAuditSearch, readAuditDraft } from "./audit-state.ts";

const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G600B";
const RESOURCE = "01M4CGZA4N2G1B23FA73Y8FSZ4";
const empty = { actor: "", event: "", resource: "", since: "", until: "" };

describe("parseAuditSearch", () => {
  test("keeps exactly the filters the API accepts", () => {
    expect(
      parseAuditSearch({
        actor: PRINCIPAL,
        event: " credential.read ",
        resource: RESOURCE,
        since: "2026-10-07T00:00:00.000Z",
        until: "2026-10-08T00:00:00.000Z",
      }),
    ).toEqual({
      actor: PRINCIPAL,
      event: "credential.read",
      resource: RESOURCE,
      since: "2026-10-07T00:00:00.000Z",
      until: "2026-10-08T00:00:00.000Z",
    });
  });

  test("drops instants that are not canonical toISOString values", () => {
    expect(parseAuditSearch({ since: "2026-10-07T00:00:00Z", until: "2026-10-07" })).toEqual({});
    expect(parseAuditSearch({ since: "2026-02-30T00:00:00.000Z" })).toEqual({});
  });

  test("drops an until that does not follow since", () => {
    expect(
      parseAuditSearch({ since: "2026-10-08T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" }),
    ).toEqual({ since: "2026-10-08T00:00:00.000Z" });
  });

  test("drops IDs that are not ULIDs and blank events", () => {
    expect(parseAuditSearch({ actor: "alice", event: "   ", resource: 7 })).toEqual({});
  });
});

describe("readAuditDraft", () => {
  test("converts local times to canonical instants", () => {
    expect(
      readAuditDraft({
        ...empty,
        event: "credential.read",
        since: "2026-10-07T09:30",
        until: "2026-10-07T10:00",
      }),
    ).toEqual({
      filters: {
        event: "credential.read",
        since: new Date("2026-10-07T09:30").toISOString(),
        until: new Date("2026-10-07T10:00").toISOString(),
      },
      kind: "valid",
    });
  });

  test("an empty form filters nothing", () => {
    expect(readAuditDraft(empty)).toEqual({ filters: {}, kind: "valid" });
  });

  test("names each field the API would refuse", () => {
    expect(
      readAuditDraft({
        actor: "alice",
        event: "x".repeat(257),
        resource: "not-an-id",
        since: "2026-10-07T10:00",
        until: "2026-10-07T09:00",
      }),
    ).toEqual({
      issues: {
        actor: "Enter a principal, agent, or service account ID.",
        event: "Enter at most 256 characters.",
        resource: "Enter a resource ID.",
        until: "Choose a time after the start.",
      },
      kind: "invalid",
    });
  });

  test("a draft rebuilt from filters reads back to the same filters", () => {
    const filters = {
      actor: PRINCIPAL,
      since: new Date("2026-10-07T09:30").toISOString(),
      until: new Date("2026-10-07T10:00").toISOString(),
    };
    expect(readAuditDraft(auditDraft(filters))).toEqual({ filters, kind: "valid" });
  });
});

describe("changeEntries", () => {
  test("renders stored values as text pairs", () => {
    expect(changeEntries({ audit: 2555, id: RESOURCE, status: "active", tags: ["a"] })).toEqual([
      ["audit", "2555"],
      ["id", RESOURCE],
      ["status", "active"],
      ["tags", '["a"]'],
    ]);
    expect(changeEntries(undefined)).toEqual([]);
  });
});
