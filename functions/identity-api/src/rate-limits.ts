import {
  identityRateLimitRecord,
  isDatabaseWriteConflict,
  type IdentityRepository,
  type Ulid,
} from "@deployments-ai/db";
import { IdentityError, sha256 } from "@deployments-ai/identity";

export interface IdentityRateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface IdentityRateLimitPolicies {
  readonly forgotPasswordEmail: IdentityRateLimitPolicy;
  readonly forgotPasswordSource: IdentityRateLimitPolicy;
  /**
   * Every password or code one principal submits to prove themselves again: second sign-in steps
   * and account security changes, whatever the source and outcome.
   */
  readonly verificationPrincipal: IdentityRateLimitPolicy;
  readonly signInSource: IdentityRateLimitPolicy;
  readonly signUpEmail: IdentityRateLimitPolicy;
  readonly signUpSource: IdentityRateLimitPolicy;
}

export const DEFAULT_IDENTITY_RATE_LIMIT_POLICIES: IdentityRateLimitPolicies = {
  forgotPasswordEmail: { limit: 3, windowSeconds: 60 * 60 },
  forgotPasswordSource: { limit: 20, windowSeconds: 60 * 60 },
  verificationPrincipal: { limit: 10, windowSeconds: 15 * 60 },
  signInSource: { limit: 60, windowSeconds: 15 * 60 },
  signUpEmail: { limit: 3, windowSeconds: 60 * 60 },
  signUpSource: { limit: 10, windowSeconds: 60 * 60 },
};

const RATE_LIMIT_WRITE_ATTEMPTS = 5;

function policyWindow(timestamp: Date, policy: IdentityRateLimitPolicy) {
  const epochSeconds = Math.floor(timestamp.getTime() / 1_000);
  const window = Math.floor(epochSeconds / policy.windowSeconds);
  const expiresAt = new Date((window + 1) * policy.windowSeconds * 1_000).toISOString();
  return { expiresAt, window: String(window) };
}

async function consume(input: {
  readonly limitKey: string;
  readonly now: Date;
  readonly policy: IdentityRateLimitPolicy;
  readonly requestId?: Ulid;
  readonly repository: IdentityRepository;
  readonly scopeHash: string;
}) {
  const { expiresAt, window } = policyWindow(input.now, input.policy);
  let lastConflict: unknown;
  for (let attempt = 0; attempt < RATE_LIMIT_WRITE_ATTEMPTS; attempt += 1) {
    const previous = await input.repository.rateLimit(input.limitKey, input.scopeHash, window);
    if (input.requestId && previous?.data.consumedRequestIds?.includes(input.requestId)) {
      return;
    }
    if (previous && previous.data.count >= input.policy.limit) {
      throw new IdentityError("slow_down", "Too many authentication requests.", {
        status: 429,
      });
    }
    const record = identityRateLimitRecord({
      count: (previous?.data.count ?? 0) + 1,
      ...(input.requestId
        ? {
            consumedRequestIds: [...(previous?.data.consumedRequestIds ?? []), input.requestId],
          }
        : {}),
      expiresAt,
      id: sha256(`${input.limitKey}\u0000${input.scopeHash}\u0000${window}`),
      limitKey: input.limitKey,
      scopeHash: input.scopeHash,
      version: (previous?.data.version ?? 0) + 1,
      window,
    });
    try {
      await input.repository.transact([
        previous ? { kind: "put", previousRecord: previous, record } : { kind: "put", record },
      ]);
      return;
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
}

export async function enforceIdentityRateLimits(input: {
  readonly emailHash?: string;
  readonly emailPolicy?: IdentityRateLimitPolicy;
  readonly limitKey: "forgot-password" | "sign-in" | "sign-up";
  readonly now: Date;
  readonly requestId?: Ulid;
  readonly repository: IdentityRepository;
  readonly sourceHash?: string;
  readonly sourcePolicy: IdentityRateLimitPolicy;
}) {
  if (input.sourceHash) {
    await consume({
      limitKey: `${input.limitKey}:source`,
      now: input.now,
      policy: input.sourcePolicy,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      repository: input.repository,
      scopeHash: input.sourceHash,
    });
  }
  if (input.emailHash && input.emailPolicy) {
    await consume({
      limitKey: `${input.limitKey}:email`,
      now: input.now,
      policy: input.emailPolicy,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      repository: input.repository,
      scopeHash: input.emailHash,
    });
  }
}

/** Bounds what one principal may submit, whichever source it comes from. */
export function enforcePrincipalRateLimit(input: {
  readonly limitKey: "verification";
  readonly now: Date;
  readonly policy: IdentityRateLimitPolicy;
  readonly principalId: string;
  readonly repository: IdentityRepository;
}) {
  return consume({
    limitKey: `${input.limitKey}:principal`,
    now: input.now,
    policy: input.policy,
    repository: input.repository,
    scopeHash: sha256(input.principalId),
  });
}
