import type {
  ArchiveBrainRequest,
  BrainApiRouteName,
  EraseBrainRequest,
  UpdateBrainRequest,
} from "@deployments-ai/api-contract";
import type { Brain, BrainErasure, BrainGrant } from "@deployments-ai/brains";
import {
  key,
  organizationRoleAllows,
  type PlatformRecord,
  apiPersistence,
} from "@deployments-ai/db";
import type { BrainApiInvocation, BrainApiServiceDependencies } from "./service-contracts.ts";

type LifecycleRoute = Extract<
  BrainApiRouteName,
  "archiveBrain" | "eraseBrain" | "getBrainErasure" | "updateBrain"
>;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicErasureId(invocation: BrainApiInvocation) {
  if (!invocation.idempotencyKey) return undefined;
  let value = BigInt(
    `0x${createHash("sha256")
      .update(
        [
          invocation.organizationId,
          invocation.params.brainId,
          invocation.identity.principalId,
          invocation.idempotencyKey,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 32)}`,
  );
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

async function platformRecord(
  dependencies: BrainApiServiceDependencies,
  recordKey: { readonly pk: string; readonly sk: string },
): Promise<PlatformRecord | undefined> {
  return await apiPersistence.read(dependencies.database, "control", recordKey, true);
}

async function authorizeReceipt(
  input: Pick<
    Parameters<typeof invokeBrainLifecycleRoute>[0],
    "dependencies" | "fail" | "invocation"
  >,
  erasure: BrainErasure,
) {
  const { dependencies, invocation } = input;
  if (invocation.identity.authentication === "api-credential") {
    return input.fail(
      "forbidden",
      "brain_erasure_receipt_human_required",
      "Only an active human organization member may read a Brain erasure receipt.",
    );
  }
  const [principal, membership] = await Promise.all([
    platformRecord(dependencies, {
      pk: key("PRINCIPAL", invocation.identity.principalId),
      sk: key("PRINCIPAL", invocation.identity.principalId),
    }),
    platformRecord(dependencies, {
      pk: key("ORG", invocation.organizationId),
      sk: key("ORGANIZATION-MEMBER", invocation.identity.principalId),
    }),
  ]);
  const authorized =
    principal?.itemType === "principal" &&
    principal.data.status === "active" &&
    membership?.itemType === "organization-member" &&
    membership.data.status === "active" &&
    (erasure.requestedByPrincipalId === invocation.identity.principalId ||
      organizationRoleAllows(membership.data.role, "brains.erasure-receipts.read-any"));
  if (!authorized) {
    return input.fail(
      "forbidden",
      "brain_erasure_receipt_forbidden",
      "The Brain erasure receipt is unavailable to this principal.",
    );
  }
}

function publicErasure(operation: BrainErasure) {
  return {
    brainId: operation.brainId,
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
    contentVerificationCount: operation.contentVerificationCount,
    createdAt: operation.createdAt,
    erasureGeneration: operation.erasureGeneration,
    ...(operation.error ? { error: operation.error } : {}),
    id: operation.id,
    organizationId: operation.organizationId,
    ...(operation.recordsDeleted !== undefined ? { recordsDeleted: operation.recordsDeleted } : {}),
    ...(operation.searchReceipt ? { searchReceipt: operation.searchReceipt } : {}),
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    status: operation.status,
    updatedAt: operation.updatedAt,
    version: operation.version,
  };
}

export async function invokeBrainLifecycleRoute(input: {
  readonly authorizeAdmin: (brain: Brain, allowInactive: boolean) => Promise<BrainGrant>;
  readonly dependencies: BrainApiServiceDependencies;
  readonly fail: (
    kind: "conflict" | "forbidden" | "invalid-input" | "not-found" | "unprocessable",
    code: string,
    message: string,
  ) => never;
  readonly invocation: BrainApiInvocation;
  readonly now: () => string;
  readonly requiredBrain: () => Promise<Brain>;
  readonly routeName: LifecycleRoute;
}) {
  const { dependencies, invocation, routeName } = input;
  const repository = dependencies.repository;
  if (routeName === "getBrainErasure") {
    const brainId = invocation.params.brainId!;
    const erasureId = invocation.params.erasureId!;
    const erasure = await repository.getErasure(invocation.organizationId, brainId, erasureId);
    if (!erasure) {
      return input.fail(
        "not-found",
        "brain_erasure_not_found",
        "The Brain erasure is unavailable.",
      );
    }
    await authorizeReceipt(input, erasure);
    return publicErasure(erasure);
  }

  const replayErasureId =
    routeName === "eraseBrain" ? deterministicErasureId(invocation) : undefined;
  if (replayErasureId) {
    const replay = await repository.getErasure(
      invocation.organizationId,
      invocation.params.brainId!,
      replayErasureId,
    );
    if (replay) {
      await authorizeReceipt(input, replay);
      return publicErasure(replay);
    }
  }

  const previous = await input.requiredBrain();
  const authorizingGrant = await input.authorizeAdmin(previous, routeName === "eraseBrain");
  const body = invocation.body as UpdateBrainRequest | ArchiveBrainRequest | EraseBrainRequest;
  if (body.expectedVersion !== previous.version) {
    return input.fail("conflict", "brain_version_conflict", "The Brain version has changed.");
  }
  const timestamp = input.now();

  if (routeName === "eraseBrain") {
    if (invocation.identity.authentication === "api-credential") {
      return input.fail(
        "forbidden",
        "brain_erasure_human_required",
        "Only a human Brain owner may request erasure.",
      );
    }
    if (previous.status === "erasing") {
      return input.fail(
        "conflict",
        "brain_erasure_in_progress",
        "The Brain is already being erased.",
      );
    }
    const erasureId = replayErasureId ?? (await dependencies.generateId());
    const next: Brain = {
      ...previous,
      status: "erasing",
      updatedAt: timestamp,
      updatedByPrincipalId: invocation.identity.principalId,
      version: previous.version + 1,
    };
    const operation = await repository.beginErasure({
      authorizingGrant,
      brain: next,
      erasure: {
        brainId: previous.id,
        contentVerificationCount: 0,
        createdAt: timestamp,
        erasureGeneration: next.version,
        id: erasureId,
        nextDueAt: timestamp,
        organizationId: invocation.organizationId,
        phase: "draining",
        priority: 0,
        requestedByPrincipalId: invocation.identity.principalId,
        status: "pending",
        updatedAt: timestamp,
        version: 0,
      },
      eventId: await dependencies.generateId(),
      previous,
    });
    return publicErasure(operation);
  }

  const changes =
    routeName === "updateBrain"
      ? (() => {
          const { expectedVersion: _expectedVersion, ...mutable } = body as UpdateBrainRequest;
          return mutable;
        })()
      : {};
  const next: Brain =
    routeName === "archiveBrain"
      ? {
          ...previous,
          status: "archived",
          updatedAt: timestamp,
          updatedByPrincipalId: invocation.identity.principalId,
          version: previous.version + 1,
        }
      : ({
          ...previous,
          ...changes,
          updatedAt: timestamp,
          updatedByPrincipalId: invocation.identity.principalId,
          version: previous.version + 1,
        } as Brain);
  return repository.update({
    authorizingGrant,
    brain: next,
    eventId: await dependencies.generateId(),
    previous,
  });
}
import { createHash } from "node:crypto";
