import { createServerFn } from "@tanstack/react-start";
import { isCompleteUserCode } from "../device/device-sign-in.ts";
import { claimDeviceCode, decideDeviceCode } from "../server/device-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields } from "./server-input.ts";

function userCodeInput(input: unknown) {
  const { userCode } = fields(input);
  if (typeof userCode !== "string" || !isCompleteUserCode(userCode)) {
    throw new TypeError("userCode must look like ABCD-EFGH.");
  }
  return userCode;
}

export const claimDeviceCodeFn = createServerFn({ method: "POST" })
  .validator((input: { readonly userCode: string }) => ({ userCode: userCodeInput(input) }))
  .handler(async ({ data }) => claimDeviceCode(await requireAccessToken(), data.userCode));

export const decideDeviceCodeFn = createServerFn({ method: "POST" })
  .validator((input: { readonly decision: "approve" | "deny"; readonly userCode: string }) => {
    const { decision } = fields(input);
    if (decision !== "approve" && decision !== "deny") {
      throw new TypeError("decision must be approve or deny.");
    }
    return { decision, userCode: userCodeInput(input) } as const;
  })
  .handler(async ({ data }) =>
    decideDeviceCode(await requireAccessToken(), data.userCode, data.decision),
  );
