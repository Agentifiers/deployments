import type {
  BrainAskRequest,
  BrainApiRouteName,
  BrainSearchRequest,
} from "@deployments-ai/api-contract";
import type { Brain, BrainAuthorizedQueryInput, BrainQueryRuntime } from "@deployments-ai/brains";
import { PersistenceError } from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { failure } from "../persistence-failure.ts";
import type { BrainApiInvocation } from "./service-contracts.ts";

interface BrainQueryRuntimeInput extends BrainAuthorizedQueryInput {
  readonly identity: ApiIdentity;
}

export type { BrainQueryRuntime } from "@deployments-ai/brains";

type QueryRouteName = Extract<BrainApiRouteName, "askBrains" | "searchBrains">;

/**
 * API Gateway and the Brain Lambda stop a request at 29 s (infrastructure/modules/platform-api);
 * the rest of that budget covers authentication, idempotency, and the response.
 */
const BRAIN_QUERY_DEADLINE_MS = 25_000;

class BrainQueryTimeoutError extends Error {
  readonly code = "brain_query_timeout";
  readonly status = 504;

  constructor() {
    super("The Brain query did not finish in time. Retry with the same idempotency key.");
    this.name = "BrainQueryTimeoutError";
  }
}

function singletonScope(value: readonly string[] | "*" | undefined) {
  return Array.isArray(value) && value.length === 1 ? value[0] : undefined;
}

export async function invokeBrainQueryRoute(input: {
  readonly authorizeRead: (brain: Brain) => Promise<void>;
  readonly getBrain: (brainId: string) => Promise<Brain | undefined>;
  readonly invocation: BrainApiInvocation;
  readonly routeName: QueryRouteName;
  readonly runtime?: BrainQueryRuntime;
}) {
  const signal = AbortSignal.timeout(BRAIN_QUERY_DEADLINE_MS);
  const runtime =
    input.runtime ??
    failure(
      "internal",
      "brain_search_unavailable",
      "Brain search is not configured for this deployment.",
    );
  const environmentId =
    singletonScope(input.invocation.identity.environmentIds) ??
    failure(
      "invalid-input",
      "brain_query_scope_required",
      "Brain queries require one project and environment scope.",
    );
  const projectId =
    singletonScope(input.invocation.identity.projectIds) ??
    failure(
      "invalid-input",
      "brain_query_scope_required",
      "Brain queries require one project and environment scope.",
    );
  const request = input.invocation.body as BrainAskRequest | BrainSearchRequest;
  const brains = await Promise.all(
    request.brainIds.map(async (brainId) => {
      const brain = await input.getBrain(brainId);
      if (!brain) {
        return failure(
          "not-found",
          "brain_query_scope_not_found",
          "One or more requested Brains are unavailable.",
        );
      }
      try {
        await input.authorizeRead(brain);
      } catch (cause) {
        if (cause instanceof PersistenceError && cause.kind === "forbidden") {
          return failure(
            "not-found",
            "brain_query_scope_not_found",
            "One or more requested Brains are unavailable.",
          );
        }
        throw cause;
      }
      return brain;
    }),
  );
  const shared: BrainQueryRuntimeInput = {
    authorizeDisclosure: async (brainId) => {
      const brain = await input.getBrain(brainId);
      if (!brain) return undefined;
      try {
        await input.authorizeRead(brain);
        return brain;
      } catch {
        return undefined;
      }
    },
    brains,
    identity: input.invocation.identity,
    organizationId: input.invocation.organizationId,
    signal,
    telemetryContext: {
      environmentId,
      ...(input.invocation.idempotencyKey ? { operationId: input.invocation.idempotencyKey } : {}),
      projectId,
      purpose: "brain-api",
      workspaceId: undefined,
    },
  };
  try {
    if (input.routeName === "searchBrains") {
      const body = request as BrainSearchRequest;
      return await runtime.search({
        ...shared,
        brainIds: body.brainIds,
        ...(body.limit === undefined ? {} : { limit: body.limit }),
        query: body.query,
      });
    }
    const body = request as BrainAskRequest;
    return await runtime.ask({
      ...shared,
      brainIds: body.brainIds,
      ...(body.evidenceLimit === undefined ? {} : { evidenceLimit: body.evidenceLimit }),
      question: body.question,
    });
  } catch (cause) {
    if (signal.aborted) throw new BrainQueryTimeoutError();
    throw cause;
  }
}
