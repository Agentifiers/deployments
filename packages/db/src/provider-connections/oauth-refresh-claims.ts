import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { OAuthRefreshClaimRecord } from "../records/coordination.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export type OAuthRefreshClaim = Extract<
  PlatformRecord,
  { readonly itemType: "oauth-refresh-claim" }
>;

export interface OAuthRefreshClaimTarget {
  readonly connectionId: Ulid;
  readonly credentialGeneration: number;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly owner: string;
  readonly projectId: Ulid;
}

export interface OAuthRefreshClaimAcquireInput extends OAuthRefreshClaimTarget {
  readonly leaseMs: number;
  readonly now: Date;
}

export interface OAuthRefreshClaimPersistence {
  /**
   * Claims the refresh of one credential generation. `held` means another live owner is refreshing
   * (or won a concurrent race); callers then wait for the connection to advance its generation.
   */
  readonly acquire: (input: OAuthRefreshClaimAcquireInput) => Promise<"acquired" | "held">;
  /** Deletes the caller's own claim; a missing or foreign claim is left untouched. */
  readonly release: (input: OAuthRefreshClaimTarget) => Promise<void>;
}

export function oauthRefreshClaimKey(
  input: Pick<
    OAuthRefreshClaimTarget,
    "connectionId" | "credentialGeneration" | "environmentId" | "organizationId"
  >,
) {
  return {
    pk: key("ORG", input.organizationId, "ENV", input.environmentId),
    sk: key("OAUTH-REFRESH-CLAIM", input.connectionId, String(input.credentialGeneration)),
  };
}

export function makeOAuthRefreshClaimPersistence(
  database: DynamoDatabaseService,
): OAuthRefreshClaimPersistence {
  const ids = makeIdGenerator();

  const current = async (input: OAuthRefreshClaimTarget) => {
    const value = await database.getRecord("execution", oauthRefreshClaimKey(input), true);
    return value?.itemType === "oauth-refresh-claim" ? value : undefined;
  };

  // A lost create-only or conditional takeover race means another refresher owns the generation.
  const writeOrHeld = async (write: Promise<void>) => {
    try {
      await write;
      return "acquired" as const;
    } catch (error) {
      if (isDatabaseWriteConflict(error)) return "held" as const;
      throw error;
    }
  };

  const acquire = async (input: OAuthRefreshClaimAcquireInput) => {
    const previous = await current(input);
    const nowIso = input.now.toISOString();
    if (previous && Date.parse(previous.data.expiresAt) > input.now.getTime()) {
      return "held" as const;
    }
    const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
    const record = Schema.decodeUnknownSync(OAuthRefreshClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          connectionId: input.connectionId,
          createdAt: previous?.data.createdAt ?? nowIso,
          credentialGeneration: input.credentialGeneration,
          environmentId: input.environmentId,
          expiresAt,
          id: previous?.data.id ?? ids.generate(),
          organizationId: input.organizationId,
          owner: input.owner,
          projectId: input.projectId,
          updatedAt: nowIso,
          version: previous ? previous.data.version + 1 : 0,
        },
        itemType: "oauth-refresh-claim" as const,
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    );
    return writeOrHeld(
      database.transactWrite([
        { kind: "put", ...(previous ? { previousRecord: previous } : {}), record },
      ]),
    );
  };

  const release = async (input: OAuthRefreshClaimTarget) => {
    const claim = await current(input);
    if (claim?.data.owner !== input.owner) return;
    // The database's version condition turns a concurrent takeover or delete into a write
    // conflict, which leaves the other refresher's state untouched.
    try {
      await database.transactWrite([{ kind: "delete", record: claim }]);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
    }
  };

  return { acquire, release };
}
