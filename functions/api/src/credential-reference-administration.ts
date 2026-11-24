import {
  CREDENTIAL_REFERENCE_OWNER_TYPES,
  PersistenceError,
  Ulid,
  makeCredentialReferenceInventory,
  type CredentialReferenceOwnerType,
  type CredentialReferencePosition,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence-context.ts";

const CURSOR_VERSION = 1;

function invalidCursor() {
  return new PersistenceError(
    "invalid-input",
    "invalid_cursor",
    "The pagination cursor is invalid.",
  );
}

/** Parses the `ownerType` filter of `GET /v1/credential-references`. */
export function parseCredentialReferenceOwnerType(raw: string): CredentialReferenceOwnerType {
  const ownerType = CREDENTIAL_REFERENCE_OWNER_TYPES.find((candidate) => candidate === raw);
  if (ownerType) return ownerType;
  throw new PersistenceError(
    "invalid-input",
    "invalid_query_parameter",
    `ownerType must be one of ${CREDENTIAL_REFERENCE_OWNER_TYPES.join(", ")}.`,
  );
}

/**
 * Cursors name an owner type and the last owner examined. They are bound to the environment and
 * filter, and resume inside the authorized environment partition only, so a forged cursor can at
 * most skip the caller's own owners.
 */
function encodeCursor(
  position: CredentialReferencePosition,
  environmentId: Ulid,
  ownerTypeFilter: CredentialReferenceOwnerType | undefined,
) {
  return Buffer.from(
    JSON.stringify({
      environmentId,
      ownerTypeFilter: ownerTypeFilter ?? null,
      position,
      version: CURSOR_VERSION,
    }),
  ).toString("base64url");
}

function decodeCursor(
  value: string,
  environmentId: Ulid,
  ownerTypeFilter: CredentialReferenceOwnerType | undefined,
): CredentialReferencePosition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!decoded || typeof decoded !== "object") throw invalidCursor();
  const cursor = decoded as Readonly<Record<string, unknown>>;
  const position = cursor.position as Readonly<Record<string, unknown>> | null | undefined;
  const ownerType = CREDENTIAL_REFERENCE_OWNER_TYPES.find(
    (candidate) => candidate === position?.ownerType,
  );
  if (
    cursor.version !== CURSOR_VERSION ||
    cursor.environmentId !== environmentId ||
    cursor.ownerTypeFilter !== (ownerTypeFilter ?? null) ||
    !ownerType ||
    (ownerTypeFilter !== undefined && ownerType !== ownerTypeFilter) ||
    (position?.ownerId !== undefined && !Schema.is(Ulid)(position.ownerId))
  ) {
    throw invalidCursor();
  }
  return {
    ownerType,
    ...(position?.ownerId === undefined ? {} : { ownerId: position.ownerId as Ulid }),
  };
}

/** Metadata-only inventory of the credential-vault references held by environment owners. */
export function makeCredentialReferenceAdministration(context: AdministrationPersistenceContext) {
  const inventory = makeCredentialReferenceInventory(context.dependencies.database);

  return async function listCredentialReferences(invocation: AdministrationInvocation) {
    const scope = await context.environment(invocation);
    const { ownerType } = invocation.query;
    const after = invocation.query.cursor
      ? decodeCursor(invocation.query.cursor, scope.id, ownerType)
      : undefined;
    const page = await context.databaseValue(
      inventory.list({
        environmentId: scope.id,
        limit: invocation.query.limit ?? 50,
        organizationId: scope.organizationId,
        ...(after ? { after } : {}),
        ...(ownerType ? { ownerType } : {}),
      }),
    );
    return {
      items: page.items,
      nextCursor: page.next ? encodeCursor(page.next, scope.id, ownerType) : null,
    };
  };
}
