import "@tanstack/react-start/server-only";
import type { DeviceRequest } from "../device/device-sign-in.ts";
import { accountCall } from "./account-data.ts";

/** Binds the code to the signed-in identity session and returns what the CLI asks for. */
export function claimDeviceCode(accessToken: string, userCode: string) {
  return accountCall<DeviceRequest>("claimDeviceCode", {
    accessToken,
    body: { userCode },
    method: "POST",
    path: "/v1/account/device/claim",
  });
}

export function decideDeviceCode(
  accessToken: string,
  userCode: string,
  decision: "approve" | "deny",
) {
  return accountCall<Record<string, never>>(
    decision === "approve" ? "approveDeviceCode" : "denyDeviceCode",
    { accessToken, body: { userCode }, method: "POST", path: `/v1/account/device/${decision}` },
  );
}
