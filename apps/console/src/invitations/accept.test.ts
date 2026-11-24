import { describe, expect, test } from "bun:test";
import {
  acceptFailurePhase,
  acceptRecovery,
  invitationLink,
  invitationPath,
  invitationSearch,
  mayHaveJoined,
  type AcceptPhase,
} from "./accept.ts";

const INVITATION = "01ARZ3NDEKTSV4RRFFQ69G6002";
const TOKEN = "dpl_inv_01ARZ3NDEKTSV4RRFFQ69G6002_abc";

describe("invitation link", () => {
  test("parses an emailed link and rejects anything the API would refuse", () => {
    expect(invitationLink({ invitation: INVITATION, token: TOKEN })).toEqual({
      invitationId: INVITATION,
      token: TOKEN,
    });
    expect(invitationLink({ invitation: "x", token: "t" })).toBeUndefined();
    expect(invitationLink({ invitation: INVITATION, token: " t" })).toBeUndefined();
    expect(invitationLink({ invitation: INVITATION, token: "t".repeat(1_025) })).toBeUndefined();
    expect(invitationLink({ invitation: INVITATION })).toBeUndefined();
  });

  test("keeps only string search values", () => {
    expect(invitationSearch({ invitation: 7, token: "t" })).toEqual({ token: "t" });
    expect(invitationSearch({ extra: "x", invitation: INVITATION })).toEqual({
      invitation: INVITATION,
    });
  });

  test("rebuilds the accept path the sign-in round trip returns to", () => {
    expect(invitationPath({ invitationId: INVITATION, token: TOKEN })).toBe(
      "/invitations/accept?invitation=01ARZ3NDEKTSV4RRFFQ69G6002&token=dpl_inv_01ARZ3NDEKTSV4RRFFQ69G6002_abc",
    );
  });
});

describe("acceptFailurePhase", () => {
  test.each<[Parameters<typeof acceptFailurePhase>[0], AcceptPhase]>([
    [{ code: "invitation_email_mismatch", status: 403 }, { kind: "wrong-account" }],
    [{ code: "member_exists", status: 409 }, { kind: "already-member" }],
    [{ code: "invitation_expired", status: 409 }, { kind: "expired" }],
    [{ code: "invitation_unavailable", status: 409 }, { kind: "unavailable" }],
    [{ code: "invitation_not_found", status: 404 }, { kind: "invalid" }],
    [{ code: "invalid_invitation_token", status: 403 }, { kind: "invalid" }],
    [{ code: "validation_failed", status: 422 }, { kind: "invalid" }],
    [{ status: 400 }, { kind: "invalid" }],
    [
      { code: "invitation_conflict", status: 409 },
      { code: "invitation_conflict", kind: "rejected" },
    ],
    [{ status: 429 }, { kind: "rejected" }],
    [{ status: 503 }, { kind: "uncertain" }],
    [undefined, { kind: "uncertain" }],
  ])("%p → %p", (problem, phase) => {
    expect(acceptFailurePhase(problem)).toEqual(phase);
  });
});

describe("acceptRecovery", () => {
  const alpha = { id: "01ARZ3NDEKTSV4RRFFQ69G6002", name: "Alpha" };
  const beta = { id: "01ARZ3NDEKTSV4RRFFQ69G6003", name: "Beta" };
  const gamma = { id: "01ARZ3NDEKTSV4RRFFQ69G6004", name: "Gamma" };

  test("names the one organization that appeared since the first attempt", () => {
    expect(acceptRecovery([alpha], [alpha, beta])).toEqual({ kind: "joined", organization: beta });
    expect(acceptRecovery([], [gamma])).toEqual({ kind: "joined", organization: gamma });
  });

  test("proves nothing when no organization or several appeared", () => {
    expect(acceptRecovery([alpha], [alpha])).toEqual({ kind: "unconfirmed" });
    expect(acceptRecovery([alpha], [alpha, beta, gamma])).toEqual({ kind: "unconfirmed" });
  });

  test("checks the organization list after a lost answer, and after a retry that follows one", () => {
    const kinds = [
      "uncertain",
      "unavailable",
      "already-member",
      "wrong-account",
      "expired",
      "invalid",
    ] as const;
    expect(
      Object.fromEntries(
        kinds.map((kind) => [
          kind,
          [
            mayHaveJoined({ kind }, { earlierAnswerLost: false }),
            mayHaveJoined({ kind }, { earlierAnswerLost: true }),
          ],
        ]),
      ),
    ).toEqual({
      "already-member": [false, true],
      expired: [false, false],
      invalid: [false, false],
      uncertain: [true, true],
      unavailable: [false, true],
      "wrong-account": [false, false],
    });
  });
});
