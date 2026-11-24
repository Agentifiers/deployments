import type { SemanticEventData } from "../records/events.ts";
import { internalSemanticEventPayload } from "../semantic-event-storage.ts";

type SemanticEventPayload = (typeof SemanticEventData.Type)["payload"];

interface ExecutionPinFields {
  readonly agentDeploymentId?: string | undefined;
  readonly agentReleaseId?: string | undefined;
  readonly executionBindingId?: string | undefined;
  readonly executionPurpose?: string | undefined;
}

/**
 * Semantic events about preview and evaluation executions stay in the audit log but never fan
 * out to customer webhooks; customer execution events are unchanged.
 */
export function executionEventPayload(
  pins: ExecutionPinFields,
  payload: SemanticEventPayload,
): SemanticEventPayload {
  return pins.executionBindingId === undefined ? payload : internalSemanticEventPayload(payload);
}

/** JSON-safe execution pins for event payloads (deployment pins or binding pins, never both). */
export function executionPinsPayload(pins: ExecutionPinFields): SemanticEventPayload {
  return {
    ...(pins.agentDeploymentId === undefined ? {} : { agentDeploymentId: pins.agentDeploymentId }),
    ...(pins.agentReleaseId === undefined ? {} : { agentReleaseId: pins.agentReleaseId }),
    ...(pins.executionBindingId === undefined
      ? {}
      : { executionBindingId: pins.executionBindingId }),
    ...(pins.executionPurpose === undefined ? {} : { executionPurpose: pins.executionPurpose }),
  };
}
