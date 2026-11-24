import { IdentityError } from "./errors.ts";

export interface DeviceGrantState {
  readonly expiresAt: string;
  readonly nextPollAt?: string;
  readonly pollingIntervalSeconds: number;
  readonly status: "pending" | "claimed" | "approved" | "denied" | "consumed" | "expired";
}

export function devicePollDecision(
  grant: DeviceGrantState,
  now: Date,
  slowDownSeconds = 5,
): { readonly nextPollAt: string; readonly pollingIntervalSeconds: number } {
  if (Date.parse(grant.expiresAt) <= now.getTime() || grant.status === "expired") {
    throw new IdentityError("expired_token", "Device authorization expired.");
  }
  if (grant.status === "denied") throw new IdentityError("access_denied", "Authorization denied.");
  if (grant.status === "consumed")
    throw new IdentityError("invalid_grant", "Device code consumed.");
  if (grant.nextPollAt && Date.parse(grant.nextPollAt) > now.getTime()) {
    const interval = grant.pollingIntervalSeconds + slowDownSeconds;
    throw new IdentityError("slow_down", String(interval));
  }
  if (grant.status !== "approved") throw new IdentityError("authorization_pending", "Pending.");
  return {
    nextPollAt: new Date(now.getTime() + grant.pollingIntervalSeconds * 1_000).toISOString(),
    pollingIntervalSeconds: grant.pollingIntervalSeconds,
  };
}

export function assertDeviceScopes(scopes: readonly string[]) {
  if (scopes.includes("openid")) {
    throw new IdentityError("invalid_scope", "The first-release device flow is OAuth-only.");
  }
}
