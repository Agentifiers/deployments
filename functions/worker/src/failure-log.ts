import { redactRuntimeSensitivePrefix } from "@deployments-ai/agent-runtime";

const MAX_LOGGED_FAILURE_MESSAGE_CHARACTERS = 1_000;

/** Error class names and bounded, redacted messages down the cause chain; no payloads. */
export function failureChain(error: unknown) {
  const chain: { readonly message: string; readonly type: string }[] = [];
  let current: unknown = error;
  while (current !== undefined && chain.length < 6) {
    chain.push(
      current instanceof Error
        ? {
            message: redactRuntimeSensitivePrefix(current.message).slice(
              0,
              MAX_LOGGED_FAILURE_MESSAGE_CHARACTERS,
            ),
            type: current.name,
          }
        : { message: "", type: typeof current },
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}
