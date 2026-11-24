import { describe, expect, test } from "bun:test";
import { invitationExpiresAt, invitationUrl, normalizeInviteEmail } from "./invitations.ts";

describe("invitation helpers", () => {
  test("ends the chosen number of days a minute early", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    expect(invitationExpiresAt(30, now)).toBe("2026-11-04T11:59:00.000Z");
    expect(invitationExpiresAt(1, now)).toBe("2026-10-06T11:59:00.000Z");
  });

  test("lowercases and trims the address", () => {
    expect(normalizeInviteEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  test("builds the link the invitation email carries", () => {
    expect(
      invitationUrl("https://app.example.com", {
        invitationId: "01ARZ3NDEKTSV4RRFFQ69G6002",
        token: "dpl_inv_01ARZ3NDEKTSV4RRFFQ69G6002_abc",
      }),
    ).toBe(
      "https://app.example.com/invitations/accept?invitation=01ARZ3NDEKTSV4RRFFQ69G6002&token=dpl_inv_01ARZ3NDEKTSV4RRFFQ69G6002_abc",
    );
  });
});
