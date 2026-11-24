import type { AppDomainResponse } from "@deployments-ai/api-contract";
import { PlatformApiError } from "../errors.ts";

type DomainState = AppDomainResponse["state"];
type DomainProblemCode = NonNullable<
  Exclude<DomainState, { kind: "unverified" }>["problem"]
>["code"];

export const DOMAIN_CHECK_SECONDS = 30;

const MAX_BACKOFF_SECONDS = 600;

/**
 * What the publisher does about each problem the platform records. A check queues the domain's
 * edge setup, which requests a failed or timed-out certificate again. The platform retries the
 * other problems on its own schedule, and a check does not shorten it.
 */
const PROBLEM_STEPS: Record<
  DomainProblemCode,
  { readonly checkHelps: boolean; readonly step: string }
> = {
  certificate_failed: {
    checkHelps: true,
    step: "Check that the CNAME record matches the one under DNS records, then check the domain to request a new certificate.",
  },
  certificate_timed_out: {
    checkHelps: true,
    step: "Fix the CNAME record so it matches the one under DNS records, then check the domain to request a new certificate.",
  },
  domain_conflict: {
    checkHelps: false,
    step: "Remove the hostname from the other CloudFront resource that serves it. The platform tries again at the time the message gives.",
  },
  edge_rejected: {
    checkHelps: false,
    step: "Fix the CNAME record so it matches the one under DNS records. The platform tries again at the time the message gives.",
  },
  organization_certificate_limit: {
    checkHelps: false,
    step: "Wait. The platform requests the certificate at the time the message gives.",
  },
  platform_certificate_limit: {
    checkHelps: false,
    step: "Wait. The platform requests the certificate at the time the message gives.",
  },
  previous_tenant_draining: {
    checkHelps: false,
    step: "Wait. The platform connects the hostname once the earlier attachment is gone, usually in minutes.",
  },
};

export const domainProblemStep = (code: DomainProblemCode) => PROBLEM_STEPS[code].step;

/**
 * Whether a check does anything for the domain. A check of an unverified domain looks up its TXT
 * record. Any other check queues the domain's edge setup and answers at once, which helps a domain
 * the platform is still connecting and one whose certificate failed.
 */
export function domainCheckable(state: DomainState): boolean {
  if (state.kind === "unverified") return true;
  return state.problem ? PROBLEM_STEPS[state.problem.code].checkHelps : state.kind === "verified";
}

/**
 * Whether the console keeps checking a domain while its page is open. Only an unverified domain's
 * check answers with the result the page waits for. A miss stays in DNS resolver caches for the
 * zone's negative TTL, so it repeats only once the publisher asked for a check, after publishing
 * the records.
 */
export const domainPolls = (state: DomainState, checkRequested: boolean) =>
  state.kind === "unverified" && checkRequested;

/**
 * Whether the domain list follows a domain while its page is open: while the platform works on it,
 * and while it waits on a TXT record for a reader who cannot check it.
 */
export const domainFollowed = (state: DomainState, canRefresh: boolean) =>
  state.kind === "unverified" ? !canRefresh : state.kind === "verified" || state.problem !== null;

type CheckOutcome =
  | { readonly kind: "steady" | "stop" }
  | { readonly kind: "back-off"; readonly retryAfterSeconds: number };

type CheckResult = Readonly<{ error: unknown; failedChecks: number }>;

/**
 * A refusal that another check would repeat (no access, a detached domain, a hostname another app
 * verified) stops the checks. A throttled or failing platform backs off. Anything else, such as a
 * TXT record not found yet, is an expected answer.
 */
function checkOutcome(error: unknown): CheckOutcome {
  if (!error) return { kind: "steady" };
  if (!(error instanceof PlatformApiError)) return { kind: "back-off", retryAfterSeconds: 0 };
  const { code, retryAfterSeconds = 0, status } = error.problem;
  if (status === 403 || status === 404 || (status === 409 && code === "domain_claimed")) {
    return { kind: "stop" };
  }
  return status === 429 || status >= 500
    ? { kind: "back-off", retryAfterSeconds }
    : { kind: "steady" };
}

/** The back-off's failures in a row, which an expected answer resets. */
export function nextFailedChecks({ error, failedChecks }: CheckResult): number {
  return checkOutcome(error).kind === "back-off" ? failedChecks + 1 : 0;
}

/**
 * Seconds until a polling domain is checked again, or `false` to stop. A back-off doubles over the
 * failures in a row, waits at least the Retry-After, and never waits past 10 minutes.
 */
export function domainRecheckSeconds({ error, failedChecks }: CheckResult): number | false {
  const outcome = checkOutcome(error);
  switch (outcome.kind) {
    case "steady":
      return DOMAIN_CHECK_SECONDS;
    case "stop":
      return false;
    case "back-off":
      return Math.min(
        Math.max(outcome.retryAfterSeconds, DOMAIN_CHECK_SECONDS * 2 ** failedChecks),
        MAX_BACKOFF_SECONDS,
      );
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

export function domainProgress(state: DomainState): string {
  switch (state.kind) {
    case "unverified":
      return "Publish the DNS records, then check the domain to prove your organization controls it.";
    case "verified":
      return "Ownership proven. The platform is issuing a certificate and connecting the hostname to the app.";
    case "active":
      return "Serving the app.";
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}
