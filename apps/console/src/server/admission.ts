import "@tanstack/react-start/server-only";
import { notFound } from "@tanstack/react-router";
import { UnauthenticatedError } from "../errors.ts";

/**
 * The API answers 401 both for a dead session and for an organization, project, or environment
 * the caller cannot see. `probe` needs only the session: when it succeeds, the scoped resource is
 * not found, so the page renders Not found instead of a sign-in that would land on the same 401.
 */
export async function notFoundUnlessSignedOut(
  error: unknown,
  probe: () => Promise<unknown>,
): Promise<never> {
  if (!(error instanceof UnauthenticatedError)) throw error;
  try {
    await probe();
  } catch (probeError) {
    throw probeError instanceof UnauthenticatedError ? error : probeError;
  }
  throw notFound();
}
