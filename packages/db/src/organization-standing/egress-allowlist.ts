import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key, Keys } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  OrganizationEgressAllowlistRecord,
  type OrganizationEgressAllowlistRecord as StoredAllowlist,
} from "../records/organization-standing.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { EgressAllowlistEntry } from "./egress-destinations.ts";

const MAX_WRITE_ATTEMPTS = 5;

/** An organization's allowlist. A missing record reads as version 0 with no entries. */
export interface OrganizationEgressAllowlist {
  readonly organizationId: Ulid;
  /** Sorted by origin. */
  readonly entries: readonly EgressAllowlistEntry[];
  readonly version: number;
  readonly updatedAt: string | undefined;
  readonly updatedByPrincipalId: Ulid | undefined;
}

export interface OrganizationEgressAllowlistRepository {
  readonly read: (
    organizationId: Ulid,
    options?: { readonly consistent?: boolean },
  ) => Promise<OrganizationEgressAllowlist>;
  /**
   * Replaces the whole list. Entries must already satisfy `egressAllowlistIssues`. When the
   * origins and notes already match, writes nothing and returns `changed: false`.
   */
  readonly replace: (input: {
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
    readonly entries: readonly EgressAllowlistEntry[];
    /** Marks the event when a platform administrator acted under operator access. */
    readonly operatorAccessGrantId?: Ulid;
  }) => Promise<{ readonly changed: boolean; readonly allowlist: OrganizationEgressAllowlist }>;
}

export interface OrganizationEgressAllowlistReader {
  /** Strongly consistent; a read error propagates so callers fail closed. */
  readonly read: (organizationId: Ulid) => Promise<readonly EgressAllowlistEntry[]>;
}

async function loadAllowlist(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  consistent: boolean,
): Promise<StoredAllowlist | undefined> {
  const stored = await database.getRecord(
    "control",
    Keys.control.organizationEgressAllowlist(organizationId),
    consistent,
  );
  return stored?.itemType === "organization-egress-allowlist" ? stored : undefined;
}

function view(organizationId: Ulid, stored: StoredAllowlist | undefined) {
  return {
    entries: stored?.data.entries ?? [],
    organizationId,
    updatedAt: stored?.data.updatedAt,
    updatedByPrincipalId: stored?.data.updatedByPrincipalId,
    version: stored?.data.version ?? 0,
  };
}

function byOrigin(entries: readonly EgressAllowlistEntry[]) {
  return new Map(entries.map((entry) => [entry.origin, entry.note]));
}

export function makeOrganizationEgressAllowlistReader(
  database: DynamoDatabaseService,
): OrganizationEgressAllowlistReader {
  return {
    read: async (organizationId) =>
      (await loadAllowlist(database, organizationId, true))?.data.entries ?? [],
  };
}

export function makeOrganizationEgressAllowlistRepository(
  database: DynamoDatabaseService,
  options: { readonly generateId?: () => Ulid; readonly now?: () => Date } = {},
): OrganizationEgressAllowlistRepository {
  const ids = makeIdGenerator();
  const generateId = options.generateId ?? (() => ids.generate());
  const now = options.now ?? (() => new Date());

  const organizationNotFound = async (organizationId: Ulid) => {
    const organization = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      true,
    );
    return organization?.itemType === "organization"
      ? undefined
      : new PersistenceError(
          "not-found",
          "organization_not_found",
          `Organization ${organizationId} does not exist.`,
        );
  };

  return {
    read: async (organizationId, readOptions) =>
      view(
        organizationId,
        await loadAllowlist(database, organizationId, readOptions?.consistent ?? false),
      ),
    replace: async ({ entries, operatorAccessGrantId, organizationId, principalId }) => {
      const next = byOrigin(entries);
      const sorted = [...next]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([origin, note]) => (note === undefined ? { origin } : { note, origin }));
      for (let attempt = 1; ; attempt += 1) {
        const previous = await loadAllowlist(database, organizationId, true);
        const current = byOrigin(previous?.data.entries ?? []);
        const added = [...next.keys()].filter((origin) => !current.has(origin)).toSorted();
        const removed = [...current.keys()].filter((origin) => !next.has(origin)).toSorted();
        const notesMatch = [...next].every(([origin, note]) => current.get(origin) === note);
        if (added.length === 0 && removed.length === 0 && notesMatch) {
          if (!previous) {
            const notFound = await organizationNotFound(organizationId);
            if (notFound) throw notFound;
          }
          return { allowlist: view(organizationId, previous), changed: false };
        }
        const at = now().toISOString();
        const version = (previous?.data.version ?? 0) + 1;
        const record = Schema.decodeUnknownSync(OrganizationEgressAllowlistRecord)(
          withCanonicalRecordKeys({
            data: {
              createdAt: previous?.data.createdAt ?? at,
              entries: sorted,
              organizationId,
              updatedAt: at,
              updatedByPrincipalId: principalId,
              version,
            },
            itemType: "organization-egress-allowlist" as const,
          }),
        );
        const event = makeSemanticEventRecord({
          actor: {
            id: principalId,
            ...(operatorAccessGrantId ? { operatorAccessGrantId } : {}),
            type: "principal",
          },
          aggregateId: organizationId,
          aggregateType: "organization-egress-allowlist",
          aggregateVersion: version,
          eventId: generateId(),
          eventType: "organization.egress-allowlist-updated",
          occurredAt: at,
          organizationId,
          payload: { added, removed },
        });
        try {
          await transactWithSemanticEvents(
            database,
            [{ kind: "put", ...(previous ? { previousRecord: previous } : {}), record }],
            [event],
          );
          return { allowlist: view(organizationId, record), changed: true };
        } catch (cause) {
          if (!isDatabaseWriteConflict(cause)) throw cause;
          const notFound = await organizationNotFound(organizationId);
          if (notFound) throw notFound;
          if (attempt >= MAX_WRITE_ATTEMPTS) {
            throw new PersistenceError(
              "conflict",
              "version_conflict",
              "The egress allowlist kept changing concurrently; retry the request.",
            );
          }
        }
      }
    },
  };
}
