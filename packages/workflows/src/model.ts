import type {
  JsonValue,
  WorkflowDefinitionDocumentV1,
  WorkflowExecutionResponse,
  WorkflowStepAttemptResponse,
} from "@deployments-ai/api-contract";

export type WorkflowExecution = WorkflowExecutionResponse;
export type WorkflowStepAttempt = WorkflowStepAttemptResponse;
export type WorkflowDefinition = WorkflowDefinitionDocumentV1;
export type WorkflowStep = WorkflowDefinition["steps"][number];

export interface WorkflowExecutionContext {
  readonly stepOutputs: Readonly<Record<string, JsonValue>>;
}

export type WorkflowRuntimeAction =
  | {
      readonly kind: "dispatch-agent";
      readonly agentDeploymentId: string;
      readonly input: Readonly<Record<string, JsonValue>>;
      readonly onFailure?: string;
      readonly onSuccess: string;
      readonly stepId: string;
    }
  | {
      readonly agentDeploymentId: string;
      readonly approvalStepId?: string;
      readonly kind: "dispatch-tool";
      readonly input: Readonly<Record<string, JsonValue>>;
      readonly onFailure?: string;
      readonly onSuccess: string;
      readonly stepId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "request-approval";
      readonly onApproved: string;
      readonly onExpired?: string;
      readonly onRejected: string;
      readonly prompt: string;
      readonly stepId: string;
      readonly timeoutSeconds?: number;
    }
  | {
      readonly channel: string;
      readonly kind: "send-notification";
      readonly message: string;
      readonly onFailure?: string;
      readonly onSuccess: string;
      readonly stepId: string;
      readonly target: string;
    }
  | {
      readonly kind: "emit-escalation";
      readonly message: string;
      readonly onFailure?: string;
      readonly onSuccess: string;
      readonly stepId: string;
      readonly target: string;
    }
  | {
      readonly conditionResult: boolean;
      readonly kind: "advance-branch";
      readonly nextStepId: string;
      readonly stepId: string;
    }
  | {
      readonly kind: "complete";
      readonly output: Readonly<Record<string, JsonValue>>;
      readonly stepId: string;
    }
  | { readonly kind: "cancel" };

export class WorkflowRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRuntimeError";
  }
}
