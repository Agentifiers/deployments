import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type CallbackEvidence = RouteResponse<"getCallbackDispatchEvidence">;

/**
 * The authorization record the worker wrote before an HTTP callback tool call left the platform.
 * Its ID is the tool call's, so `null` means the call dispatched no HTTP callback.
 */
export async function loadCallbackEvidence(
  accessToken: string,
  scope: EnvironmentScope,
  toolCallId: string,
): Promise<CallbackEvidence | null> {
  try {
    return await callRoute(
      "getCallbackDispatchEvidence",
      { path: { evidenceId: toolCallId }, scope },
      accessToken,
    );
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return null;
    throw error;
  }
}
