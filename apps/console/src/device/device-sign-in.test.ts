import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import {
  claimedPhase,
  codeFromFragment,
  devicePath,
  deviceSearch,
  formatUserCode,
  isCompleteUserCode,
  refusedPhase,
  type DeviceRequest,
} from "./device-sign-in.ts";

const request: DeviceRequest = {
  account: { email: "ada@example.com" },
  approved: false,
  clientId: "deployments-cli",
  clientName: "Deployments CLI",
  requestedScopes: ["agents:read"],
};

describe("device sign-in", () => {
  test("formats typed or pasted codes the way the terminal shows them", () => {
    expect(
      ["abcd", "abcdefgh", "ab cd-ef gh", "ABCD-EFGH-IJ", "abcd–efgh"].map(formatUserCode),
    ).toEqual(["ABCD", "ABCD-EFGH", "ABCD-EFGH", "ABCD-EFGH", "ABCD-EFGH"]);
    expect(["ABCD-EFGH", "ABCD-EFG", "ABCDEFGH"].map(isCompleteUserCode)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("reads the code from the query and from the fragment older CLIs print", () => {
    expect(deviceSearch({ code: "ABCD-EFGH" })).toEqual({ code: "ABCD-EFGH" });
    expect(deviceSearch({ code: 7 })).toEqual({});
    expect(codeFromFragment("#code=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(codeFromFragment("#code=ABCD%2DEFGH")).toBe("ABCD-EFGH");
    expect(codeFromFragment("")).toBeUndefined();
    expect(devicePath("ABCD-EFGH")).toBe("/device?code=ABCD-EFGH");
    expect(devicePath(undefined)).toBe("/device");
  });

  test("a claim confirms a new request and shows an already approved one as approved", () => {
    expect(claimedPhase(request)).toEqual({ kind: "confirm", request });
    expect(claimedPhase({ ...request, approved: true })).toEqual({
      clientName: "Deployments CLI",
      kind: "approved",
    });
  });

  test("names each refused code and leaves other failures to a retry", () => {
    const failure = (code: string | undefined, status = 400) =>
      new PlatformApiError("claimDeviceCode", {
        ...(code ? { code } : {}),
        status,
        title: "Request failed",
      });
    expect(
      [
        failure("device_code_expired"),
        failure("device_code_used"),
        failure("device_code_unknown"),
        failure("invalid_request"),
        failure(undefined, 503),
        new Error("network"),
      ].map(refusedPhase),
    ).toEqual([
      { kind: "refused", reason: "expired" },
      { kind: "refused", reason: "used" },
      { kind: "refused", reason: "unknown" },
      undefined,
      undefined,
      undefined,
    ]);
  });
});
