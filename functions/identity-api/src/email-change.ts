import type { EmailChangeData } from "@deployments-ai/db";

/** How long the link sent to the new address works. */
export const EMAIL_CHANGE_LINK_SECONDS = 60 * 60;
/** How long the notice sent to the old address can report the change. */
export const EMAIL_CHANGE_REPORT_SECONDS = 7 * 24 * 60 * 60;

type State<Name extends EmailChangeData["state"]> = Extract<EmailChangeData, { state: Name }>;

/**
 * The change as the person can act on it now. A pending change that expired, or whose password
 * changed since, is `void`: it reads as nothing pending, and a newer request simply replaces it.
 */
export type EmailChangeView =
  | { readonly kind: "none" }
  | { readonly kind: "void"; readonly change: State<"pending"> }
  | { readonly kind: "pending"; readonly change: State<"pending"> }
  | { readonly kind: "applied"; readonly change: State<"applied"> }
  | { readonly kind: "settled"; readonly change: State<"cancelled" | "reported"> };

export function viewEmailChange(
  change: EmailChangeData | undefined,
  at: Date,
  credentialVersion: number,
): EmailChangeView {
  switch (change?.state) {
    case undefined:
      return { kind: "none" };
    case "pending":
      return Date.parse(change.expiresAt) <= at.getTime() ||
        change.credentialVersion !== credentialVersion
        ? { change, kind: "void" }
        : { change, kind: "pending" };
    case "applied":
      return { change, kind: "applied" };
    case "cancelled":
    case "reported":
      return { change, kind: "settled" };
    default: {
      const unhandled: never = change;
      return unhandled;
    }
  }
}

/**
 * Why a new change must wait, and until when. An applied change waits out its report window so
 * changing again cannot destroy the old address's report link. A report holds for as long again
 * from when it was made, so whoever made the reported change cannot move the address straight
 * back once they regain access.
 */
export type EmailChangeHold = {
  readonly reason: "changed" | "reported";
  readonly until: string;
};

export function emailChangeHold(view: EmailChangeView, at: Date): EmailChangeHold | undefined {
  const hold: EmailChangeHold | undefined =
    view.kind === "applied"
      ? { reason: "changed", until: view.change.reportExpiresAt }
      : view.kind === "settled" && view.change.state === "reported"
        ? {
            reason: "reported",
            until: new Date(
              Date.parse(view.change.reportedAt) + EMAIL_CHANGE_REPORT_SECONDS * 1_000,
            ).toISOString(),
          }
        : undefined;
  return hold && Date.parse(hold.until) > at.getTime() ? hold : undefined;
}

function base(
  previous: EmailChangeData | undefined,
  principalId: EmailChangeData["principalId"],
  updatedAt: string,
) {
  return {
    createdAt: previous?.createdAt ?? updatedAt,
    id: principalId,
    principalId,
    updatedAt,
    version: (previous?.version ?? 0) + 1,
  };
}

/** Every transition the record can take. Each returns the next full record data. */
export const emailChangeTransitions = {
  request(input: {
    readonly at: Date;
    readonly credentialVersion: number;
    readonly newEmail: string;
    readonly previous: EmailChangeData | undefined;
    readonly principalId: EmailChangeData["principalId"];
    readonly tokenHash: string;
  }): State<"pending"> {
    const updatedAt = input.at.toISOString();
    return {
      ...base(input.previous, input.principalId, updatedAt),
      credentialVersion: input.credentialVersion,
      expiresAt: new Date(input.at.getTime() + EMAIL_CHANGE_LINK_SECONDS * 1_000).toISOString(),
      newEmail: input.newEmail,
      state: "pending",
      tokenHash: input.tokenHash,
    };
  },
  cancel(previous: State<"pending">, at: Date): State<"cancelled"> {
    const updatedAt = at.toISOString();
    return {
      ...base(previous, previous.principalId, updatedAt),
      cancelledAt: updatedAt,
      state: "cancelled",
    };
  },
  apply(
    previous: State<"pending">,
    input: { readonly at: Date; readonly previousEmail: string; readonly reportTokenHash: string },
  ): State<"applied"> {
    const updatedAt = input.at.toISOString();
    return {
      ...base(previous, previous.principalId, updatedAt),
      appliedAt: updatedAt,
      newEmail: previous.newEmail,
      previousEmail: input.previousEmail,
      reportExpiresAt: new Date(
        input.at.getTime() + EMAIL_CHANGE_REPORT_SECONDS * 1_000,
      ).toISOString(),
      reportTokenHash: input.reportTokenHash,
      state: "applied",
    };
  },
  report(previous: State<"applied">, at: Date, emailRestored: boolean): State<"reported"> {
    const updatedAt = at.toISOString();
    return {
      ...base(previous, previous.principalId, updatedAt),
      emailRestored,
      reportedAt: updatedAt,
      state: "reported",
    };
  },
};
