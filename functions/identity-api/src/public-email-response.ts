import { IdentityError, type HumanVerifier } from "@deployments-ai/identity";
import { json } from "./http-responses.ts";

type PublicEmailOperation = "password-recovery" | "sign-up";

function isExplicitPublicError(error: unknown): error is IdentityError {
  return (
    error instanceof IdentityError &&
    (error.code === "human_verification_failed" ||
      error.code === "invalid_request" ||
      error.code === "slow_down")
  );
}

function reportUnexpectedFailure(
  error: unknown,
  operation: PublicEmailOperation,
  requestId?: string,
) {
  console.error("A public identity email request failed after generic acceptance.", {
    errorType: error instanceof Error ? error.name : "UnknownError",
    operation,
    ...(requestId ? { requestId } : {}),
  });
}

class HumanVerificationUnavailable extends Error {
  override readonly name = "HumanVerificationUnavailable";
}

export async function requireHuman(
  verifier: HumanVerifier | undefined,
  body: Readonly<Record<string, unknown>>,
  remoteIp: string | undefined,
) {
  if (!verifier) return;
  const response = body[verifier.widget.responseField];
  const outcome = await verifier.verify({
    remoteIp,
    response: typeof response === "string" ? response : undefined,
  });
  if (outcome === "rejected") {
    throw new IdentityError(
      "human_verification_failed",
      "Complete the human verification check and try again.",
      { exposeDescription: true },
    );
  }
  if (outcome === "unavailable") {
    throw new HumanVerificationUnavailable("The human verification provider is unavailable.");
  }
}

export async function waitForPublicResponse(startedAt: number, minimumMs: number) {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

export async function acceptPublicEmailRequest(input: {
  readonly minimumMs: number;
  readonly operation: PublicEmailOperation;
  readonly request: () => Promise<void>;
  readonly requestId?: string;
  readonly startedAt: number;
}) {
  try {
    await input.request();
  } catch (error) {
    if (isExplicitPublicError(error)) {
      await waitForPublicResponse(input.startedAt, input.minimumMs);
      throw error;
    }
    reportUnexpectedFailure(error, input.operation, input.requestId);
    await waitForPublicResponse(input.startedAt, input.minimumMs);
    throw new IdentityError(
      "temporarily_unavailable",
      "The identity email request could not be durably accepted.",
      { status: 503 },
    );
  }

  await waitForPublicResponse(input.startedAt, input.minimumMs);
  return json(202, { accepted: true });
}
