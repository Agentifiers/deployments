import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  makePlatformOrganizationDirectory,
  Ulid,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  activateDefaultMemorySearch,
  defaultMemorySearchConfigFromEnv,
  type DefaultMemorySearchActivation,
  type DefaultMemorySearchConfig,
  type DefaultMemorySearchControl,
} from "./default-search-placement.ts";
import { runtimeMemorySearchControlPlane } from "./operation-control.ts";
import { processQueue, queuePayload, type QueueEventLike } from "./queue.ts";
import { runtimeDatabase } from "./runtime.ts";

type Provisioning = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

/** Activates one organization, as `organization.created` delivery and operators do. */
export interface DefaultMemorySearchOrganizationRequest {
  readonly organizationId: string;
}

/** Activates one page of every organization on the install; repeat with `nextCursor`. */
export interface DefaultMemorySearchInstallRequest {
  readonly cursor?: string;
  readonly organizations: "all";
}

export type DefaultMemorySearchRequest =
  | DefaultMemorySearchOrganizationRequest
  | DefaultMemorySearchInstallRequest;

export interface DefaultMemorySearchInstallResult {
  readonly failed: readonly string[];
  readonly nextCursor?: string;
  readonly results: readonly ({ readonly organizationId: string } & (
    | { readonly outcome: DefaultMemorySearchActivation["outcome"] }
    | { readonly outcome: "failed" }
  ))[];
}

interface Dependencies {
  readonly config: DefaultMemorySearchConfig;
  readonly control: DefaultMemorySearchControl;
  readonly database: DynamoDatabaseService;
  readonly dispatch: (operation: Provisioning) => Promise<void>;
}

const sqs = new SQSClient({});
const organizationId = Schema.decodeUnknownSync(Ulid);

/**
 * Queues the provisioning action at once so a new organization does not wait for the
 * five-minute operation reconciler, which still redispatches the action if this send is lost.
 */
function dispatchProvisioning(queueUrl: string) {
  return async (operation: Provisioning) => {
    await sqs.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify({
          actionGeneration: operation.data.actionGeneration,
          nextAction: operation.data.nextAction,
          operationId: operation.data.id,
          organizationId: operation.data.organizationId,
        }),
        QueueUrl: queueUrl,
      }),
    );
  };
}

export async function activateDefaultMemorySearchForInstall(
  dependencies: Dependencies,
  request: DefaultMemorySearchInstallRequest,
): Promise<DefaultMemorySearchInstallResult> {
  const page = await makePlatformOrganizationDirectory(dependencies.database).list({
    ...(request.cursor ? { cursor: request.cursor } : {}),
    limit: 25,
  });
  const results: DefaultMemorySearchInstallResult["results"][number][] = [];
  for (const organization of page.items) {
    try {
      const activation = await activateDefaultMemorySearch({
        ...dependencies,
        organizationId: organizationId(organization.id),
      });
      results.push({ organizationId: organization.id, outcome: activation.outcome });
    } catch (cause) {
      console.error("Default memory search activation failed.", {
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        organizationId: organization.id,
      });
      results.push({ organizationId: organization.id, outcome: "failed" });
    }
  }
  return {
    failed: results.flatMap((result) =>
      result.outcome === "failed" ? [result.organizationId] : [],
    ),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    results,
  };
}

export async function handleDefaultMemorySearch(
  event: DefaultMemorySearchRequest | QueueEventLike,
  dependencies: Dependencies,
) {
  if ("Records" in event) {
    return processQueue(event, async (record) => {
      await activateDefaultMemorySearch({
        ...dependencies,
        organizationId: organizationId(queuePayload(record).organizationId),
      });
    });
  }
  if ("organizations" in event) return activateDefaultMemorySearchForInstall(dependencies, event);
  return activateDefaultMemorySearch({
    ...dependencies,
    organizationId: organizationId(event.organizationId),
  });
}

export async function handler(event: DefaultMemorySearchRequest | QueueEventLike) {
  const queueUrl = process.env.DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL?.trim();
  if (!queueUrl) throw new Error("DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL is required.");
  return handleDefaultMemorySearch(event, {
    config: defaultMemorySearchConfigFromEnv(),
    control: await runtimeMemorySearchControlPlane(),
    database: runtimeDatabase(),
    dispatch: dispatchProvisioning(queueUrl),
  });
}
