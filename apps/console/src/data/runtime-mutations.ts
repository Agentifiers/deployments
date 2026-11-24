import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { cancelRun, replayRun, resolveApproval, retryRun } from "../server/runtime-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

interface RunInput extends ScopedInput {
  readonly runId: string;
}

const DECISIONS = ["approved", "rejected"] as const;

export const cancelRunFn = createServerFn({ method: "POST" })
  .validator((input: RunInput) => scopedInput(input, ["runId"]))
  .handler(async ({ data }) => cancelRun({ ...data, accessToken: await requireAccessToken() }));

export const retryRunFn = createServerFn({ method: "POST" })
  .validator((input: RunInput) => scopedInput(input, ["runId"]))
  .handler(async ({ data }) => retryRun({ ...data, accessToken: await requireAccessToken() }));

export const replayRunFn = createServerFn({ method: "POST" })
  .validator((input: RunInput & KeyedInput) => keyedInput(input, ["runId"]))
  .handler(async ({ data }) => replayRun({ ...data, accessToken: await requireAccessToken() }));

export const resolveApprovalFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: RunInput & {
        readonly approvalId: string;
        readonly decision: (typeof DECISIONS)[number];
      },
    ) => {
      const decision = oneOf(DECISIONS, fields(input).decision);
      if (!decision) throw new TypeError("decision must be approved or rejected.");
      return { ...scopedInput(input, ["approvalId", "runId"]), decision };
    },
  )
  .handler(async ({ data }) =>
    resolveApproval({ ...data, accessToken: await requireAccessToken() }),
  );
