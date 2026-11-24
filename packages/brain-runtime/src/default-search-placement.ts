import type { BrainSearchProviderRegistry } from "@deployments-ai/brains";
import {
  activateBrainSearchPlacement,
  backfillBrainSearchIndex,
  brainRuntimePersistence,
  canonicalRecordKeys,
  ensureBrainSearchPlacement,
  getBrainSearchPlacement,
  type BrainIndexBackfillRepository,
  type BrainSearchPlacement,
  type BrainSearchTarget,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { loadBrainEmbeddingProfile } from "./embedding.ts";

/** The install's Brain OpenSearch domain that default placements index into. */
export interface DefaultBrainSearchConfig {
  readonly openSearchEndpoint: string;
  readonly region: string;
}

export type DefaultBrainSearchActivation =
  | {
      readonly outcome: "activated";
      readonly queued: number;
      readonly target: BrainSearchTarget;
    }
  | {
      readonly outcome: "configured";
      readonly phase: BrainSearchPlacement["data"]["phase"];
      readonly queued?: number;
    }
  | { readonly outcome: "memory-search-inactive" };

/**
 * Activates the organization's default AWS-native Brain search target once its memory search
 * placement is active. The target reuses that placement's platform-approved embedding profile,
 * and its index is created and checked hybrid-ready before reads move to it. Documents stored
 * before activation are then queued for indexing. A placement that is already configured, by an
 * operator or an earlier activation, is left unchanged; with `backfillConfigured` an active one
 * is backfilled again, which completes a backfill an interrupted earlier attempt left unfinished.
 */
export async function activateDefaultBrainSearch(input: {
  readonly backfillConfigured: boolean;
  readonly config: DefaultBrainSearchConfig;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => string;
  readonly organizationId: Ulid;
  readonly providers: BrainSearchProviderRegistry;
  readonly repository: BrainIndexBackfillRepository;
}): Promise<DefaultBrainSearchActivation> {
  const { database, organizationId } = input;
  const backfill = (targetId: string) =>
    backfillBrainSearchIndex({ database, organizationId, repository: input.repository, targetId });
  const placement = await ensureBrainSearchPlacement({
    database,
    now: input.now(),
    organizationId,
  });
  if (placement.data.phase !== "unconfigured") {
    const writeTarget = placement.data.phase === "active" ? placement.data.writeTarget : undefined;
    if (!input.backfillConfigured || !writeTarget) {
      return { outcome: "configured", phase: placement.data.phase };
    }
    const { queued } = await backfill(writeTarget.targetId);
    return { outcome: "configured", phase: placement.data.phase, queued };
  }
  const memoryPlacement = await brainRuntimePersistence.read(
    database,
    "control",
    canonicalRecordKeys(
      { data: { organizationId }, itemType: "memory-search-placement" },
      "control",
    ),
    true,
  );
  const memoryTarget =
    memoryPlacement?.itemType === "memory-search-placement" &&
    memoryPlacement.data.phase === "active"
      ? memoryPlacement.data.readTarget
      : undefined;
  if (!memoryTarget) return { outcome: "memory-search-inactive" };
  const profile = await loadBrainEmbeddingProfile(database, memoryTarget.embeddingProfileId);
  if (
    profile.data.distanceMetric !== "cosine" ||
    profile.data.processingBoundary !== "platform-approved"
  ) {
    throw new Error("The organization's memory embedding profile cannot serve Brain search.");
  }
  const target: BrainSearchTarget = {
    components: await Promise.all(
      (["dense", "entity", "exact", "lexical"] as const).map(async (kind) => ({
        componentId: await input.generateId(),
        kind,
      })),
    ),
    embeddingProfileId: profile.data.id,
    location: {
      openSearchEndpoint: input.config.openSearchEndpoint,
      openSearchIndex: `brain-${organizationId.toLowerCase()}-v1`,
      region: input.config.region,
    },
    providerId: "aws-native",
    schemaGeneration: 1,
    targetId: await input.generateId(),
  };
  const provider = await input.providers.resolve(target);
  await provider.prepare({ organizationId });
  const readiness = await provider.inspect({ organizationId });
  if (
    !readiness.ready ||
    !provider.capabilities.hybrid ||
    readiness.components.some((component) => !component.ready)
  ) {
    throw new Error("The default Brain search index did not become hybrid-ready.");
  }
  try {
    await activateBrainSearchPlacement({
      actor: { type: "system" },
      database,
      eventId: await input.generateId(),
      now: input.now(),
      organizationId,
      target,
    });
  } catch (cause) {
    const current = await getBrainSearchPlacement(database, organizationId);
    if (current && current.data.phase !== "unconfigured") {
      return { outcome: "configured", phase: current.data.phase };
    }
    throw cause;
  }
  const { queued } = await backfill(target.targetId);
  return { outcome: "activated", queued, target };
}
