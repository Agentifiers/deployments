import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  Ulid,
  canonicalRecordKeys,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { makeMemorySearchControlPlane } from "@deployments-ai/memory";
import {
  createMemoryMembershipKeyringLoader,
  currentMemoryMembershipDigest,
} from "@deployments-ai/memory-runtime";
import { Schema } from "effect";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  e2eMemoryCatalogMatches,
  e2eMemorySearchCatalog,
  e2eMemorySearchEnvelope,
  e2eMemoryTargetLocationMatches,
} from "./bootstrap-e2e-memory-search-support.ts";
import { runMain } from "./platform-deploy/process.ts";
import { required } from "./required-environment.ts";

async function getRecord(
  database: DynamoDatabaseService,
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
) {
  return database.getRecord("control", canonicalRecordKeys({ data, itemType }, "control"), true);
}

async function ensureEnvelope(database: DynamoDatabaseService, organizationId: typeof Ulid.Type) {
  const organization = await getRecord(database, "organization", { id: organizationId });
  if (
    organization?.itemType !== "organization" ||
    organization.data.id !== organizationId ||
    organization.data.status !== "active"
  ) {
    throw new Error("The credentialed E2E organization is unavailable or inactive.");
  }
  const [placement, fence] = await Promise.all([
    getRecord(database, "memory-search-placement", { organizationId }),
    getRecord(database, "memory-search-mutation-fence", { organizationId }),
  ]);
  if (placement && placement.itemType !== "memory-search-placement") {
    throw new Error("The credentialed E2E memory placement has an invalid record type.");
  }
  if (fence && fence.itemType !== "memory-search-mutation-fence") {
    throw new Error("The credentialed E2E memory mutation fence has an invalid record type.");
  }
  if (placement && fence) return placement;
  const envelope = e2eMemorySearchEnvelope(organizationId, new Date().toISOString());
  try {
    await database.transactWrite([
      ...(placement ? [] : [{ kind: "put" as const, record: envelope.placement }]),
      ...(fence ? [] : [{ kind: "put" as const, record: envelope.fence }]),
    ]);
  } catch (cause) {
    const [reconciledPlacement, reconciledFence] = await Promise.all([
      getRecord(database, "memory-search-placement", { organizationId }),
      getRecord(database, "memory-search-mutation-fence", { organizationId }),
    ]);
    if (
      reconciledPlacement?.itemType === "memory-search-placement" &&
      reconciledFence?.itemType === "memory-search-mutation-fence"
    ) {
      return reconciledPlacement;
    }
    throw cause;
  }
  return placement ?? envelope.placement;
}

async function ensureCatalog(
  database: DynamoDatabaseService,
  control: ReturnType<typeof makeMemorySearchControlPlane>,
  expected: ReturnType<typeof e2eMemorySearchCatalog>,
) {
  const records = await Promise.all([
    getRecord(database, "memory-embedding-profile", { id: expected.profileId }),
    getRecord(database, "memory-search-generation", { id: expected.generationId }),
    getRecord(database, "memory-search-component", { id: expected.componentId }),
  ]);
  const present = records.filter((record): record is PlatformRecord => record !== undefined);
  if (present.length === 0) {
    await control.registerCatalog(expected.catalog);
    return;
  }
  if (present.length !== records.length || !e2eMemoryCatalogMatches(present, expected)) {
    throw new Error("The credentialed E2E memory catalog is partial or conflicts with its target.");
  }
}

async function waitForActivePlacement(
  database: DynamoDatabaseService,
  organizationId: typeof Ulid.Type,
  targetId: string,
) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const placement = await getRecord(database, "memory-search-placement", { organizationId });
    if (
      placement?.itemType === "memory-search-placement" &&
      placement.data.phase === "active" &&
      placement.data.readTarget?.targetId === targetId &&
      !placement.data.candidateTarget
    ) {
      return placement;
    }
    await Bun.sleep(5_000);
  }
  throw new Error("Credentialed E2E memory search provisioning did not become active in time.");
}

// A migration prepares the candidate in the VPC worker and then waits for an explicit cutover.
async function waitForReadyMigration(
  database: DynamoDatabaseService,
  organizationId: typeof Ulid.Type,
  operationId: string,
) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const operation = await getRecord(database, "memory-search-provisioning", {
      id: operationId,
      organizationId,
    });
    if (operation?.itemType !== "memory-search-provisioning") {
      throw new Error("The credentialed E2E memory migration operation is unavailable.");
    }
    if (operation.data.phase === "ready" && operation.data.status === "waiting") return;
    if (["aborted", "completed", "failed"].includes(operation.data.status)) {
      throw new Error(
        `Credentialed E2E memory migration ended ${operation.data.status} in phase ${operation.data.phase}.`,
      );
    }
    await Bun.sleep(5_000);
  }
  throw new Error("Credentialed E2E memory migration did not become ready in time.");
}

async function dispatchProvisioning(
  database: DynamoDatabaseService,
  sqs: SQSClient,
  organizationId: typeof Ulid.Type,
  operationId: typeof Ulid.Type,
) {
  const operation = await getRecord(database, "memory-search-provisioning", {
    id: operationId,
    organizationId,
  });
  if (operation?.itemType !== "memory-search-provisioning") {
    throw new Error("The credentialed E2E memory provisioning operation is unavailable.");
  }
  if (!operation.data.nextAction || operation.data.status === "completed") return;
  await sqs.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify({
        actionGeneration: operation.data.actionGeneration,
        nextAction: operation.data.nextAction,
        operationId: operation.data.id,
        organizationId,
      }),
      QueueUrl: required("DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL"),
    }),
  );
}

async function main() {
  const organizationId = Schema.decodeUnknownSync(Ulid)(
    required("DEPLOYMENTS_E2E_ORGANIZATION_ID"),
  );
  const region = required("AWS_REGION");
  const baseClient = new DynamoDBClient({ region });
  const sqs = new SQSClient({ region });
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(),
  );
  try {
    const initial = await ensureEnvelope(database, organizationId);
    const expected = e2eMemorySearchCatalog(
      organizationId,
      required("DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT"),
      region,
    );
    if (
      initial.data.phase === "active" &&
      !initial.data.candidateTarget &&
      initial.data.readTarget &&
      e2eMemoryTargetLocationMatches(initial.data.readTarget, expected.target)
    ) {
      console.log("Credentialed E2E memory search placement is active.");
      return;
    }
    if (
      initial.data.candidateTarget &&
      initial.data.candidateTarget.targetId !== expected.target.targetId
    ) {
      throw new Error(
        "Credentialed E2E memory search placement is provisioning another target; finish or abort it first.",
      );
    }
    const ids = makeIdGenerator();
    const membershipKeyring = createMemoryMembershipKeyringLoader({
      readSecret: () =>
        loadAwsSecretString(required("DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN")),
    });
    const control = makeMemorySearchControlPlane({
      database,
      generateId: async () => ids.generate(),
      membershipDigest: async (targetId) =>
        currentMemoryMembershipDigest(await membershipKeyring.load(), targetId),
    });
    let placement = initial;
    // An unconfigured organization provisions the target; an active placement on another search
    // domain (for example after the domain was replaced) migrates to it.
    if (!placement.data.candidateTarget) {
      await ensureCatalog(database, control, expected);
      const requested = await control.requestProvisioning({
        evidenceKeys: ["dense", "exact", "lexical", "cleanup"],
        organizationId,
        target: expected.target,
      });
      placement = requested.placement;
    }
    const operationId = placement.data.operationId;
    if (!operationId) throw new Error("Credentialed E2E memory provisioning has no operation.");
    await dispatchProvisioning(database, sqs, organizationId, operationId);
    if (placement.data.phase === "active") {
      await waitForReadyMigration(database, organizationId, operationId);
      await control.completeMigration(organizationId, operationId);
    }
    await waitForActivePlacement(database, organizationId, expected.target.targetId);
    console.log("Credentialed E2E memory search placement is active.");
  } finally {
    baseClient.destroy();
    sqs.destroy();
  }
}

if (import.meta.main) runMain(main);
