import { Effect } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { fromDatabase } from "../database-effect.ts";
import { key } from "../keys.ts";
import type { PlatformRecord, TableName } from "../records/index.ts";

type IdentityItemType = Extract<
  PlatformRecord["itemType"],
  | "identity-action"
  | "identity-bff-revocation-fence"
  | "identity-rate-limit"
  | "identity-public-email-request"
  | "identity-registration"
  | "identity-email-delivery"
  | "identity-mfa-challenge"
  | "identity-session"
  | "identity-session-locator"
  | "identity-signing-key"
  | "oauth-authorization-code"
  | "oauth-authorization-request"
  | "oauth-client"
  | "oauth-device-grant"
  | "oauth-refresh-family"
  | "oauth-refresh-token"
  | "oauth-reauthentication-request"
  | "principal"
  | "principal-credential"
  | "principal-email-change"
  | "principal-mfa-factor"
  | "principal-security-state"
  | "unique-claim"
  | "web-bff-authorization-transaction"
  | "web-bff-session"
>;

export type IdentityRecord<ItemType extends IdentityItemType> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export interface IdentityLoginMaterial {
  readonly credential: IdentityRecord<"principal-credential"> | undefined;
  readonly principal: IdentityRecord<"principal"> | undefined;
  readonly securityState: IdentityRecord<"principal-security-state"> | undefined;
}

/** Keyset position of an `identity-session` in its principal's newest-first GSI1 listing. */
export interface IdentitySessionCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface IdentitySessionPageRequest {
  /** Exclusive keyset bound: only sessions ordered strictly before this position are returned. */
  readonly before?: IdentitySessionCursor;
  readonly limit: number;
}

export interface IdentitySessionPage {
  readonly items: readonly IdentityRecord<"identity-session">[];
  /** Present only when DynamoDB reports more items after the last returned session. */
  readonly next?: IdentitySessionCursor;
}

function exactKey(prefix: string, value: string) {
  const materialized = key(prefix, value);
  return { pk: materialized, sk: materialized };
}

function mfaFactorKey(principalId: string) {
  return { pk: key("PRINCIPAL", principalId), sk: key("PRINCIPAL-MFA-FACTOR", principalId) };
}

function optionalRecord<ItemType extends IdentityItemType>(
  itemType: ItemType,
  record: PlatformRecord | undefined,
): IdentityRecord<ItemType> | undefined {
  return record?.itemType === itemType ? (record as IdentityRecord<ItemType>) : undefined;
}

/** Condition-checks that the observed BFF fence is unchanged and still admits its session epoch. */
function bffFenceCheck(
  fence: IdentityRecord<"identity-bff-revocation-fence">,
): TransactionOperation {
  return {
    conditionExpression:
      "#data.#version = :version AND #data.#principalStatus = :active AND #data.#sessionEpoch = :sessionEpoch",
    expressionAttributeNames: {
      "#data": "data",
      "#principalStatus": "principalStatus",
      "#sessionEpoch": "sessionEpoch",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":sessionEpoch": fence.data.sessionEpoch,
      ":version": fence.data.version,
    },
    key: { pk: fence.pk, sk: fence.sk },
    kind: "condition-check",
    table: "identity",
  };
}

/**
 * Full-record replacement of a BFF session. Besides the canonical exact-version guard, it pins the
 * observed status, refresh state, and lease owner so a stale holder can never overwrite a newer
 * state or resurrect a terminal one.
 */
function bffSessionReplacement(
  previous: IdentityRecord<"web-bff-session">,
  next: IdentityRecord<"web-bff-session">,
): TransactionOperation {
  const names: Record<string, string> = { "#bffData": "data", "#bffStatus": "status" };
  const values: Record<string, unknown> = { ":bffStatus": previous.data.status };
  const conditions = ["#bffData.#bffStatus = :bffStatus"];
  if (previous.data.status === "active") {
    names["#bffRefreshState"] = "refreshState";
    values[":bffRefreshState"] = previous.data.refreshState;
    conditions.push("#bffData.#bffRefreshState = :bffRefreshState");
    if (previous.data.refreshState === "leased") {
      names["#bffLeaseOwner"] = "refreshLeaseOwnerHash";
      values[":bffLeaseOwner"] = previous.data.refreshLeaseOwnerHash;
      conditions.push("#bffData.#bffLeaseOwner = :bffLeaseOwner");
    }
  }
  return {
    conditionExpression: conditions.join(" AND "),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
    kind: "put",
    previousRecord: previous,
    record: next,
  };
}

function versionCheck(
  record: IdentityRecord<"identity-session" | "identity-session-locator">,
): TransactionOperation {
  return {
    conditionExpression: "#data.#version = :version",
    expressionAttributeNames: { "#data": "data", "#version": "version" },
    expressionAttributeValues: { ":version": record.data.version },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table: "identity",
  };
}

export function makeIdentityRepository(database: DynamoDatabaseService) {
  async function get<ItemType extends IdentityItemType>(
    table: TableName,
    itemType: ItemType,
    recordKey: { readonly pk: string; readonly sk: string },
  ) {
    return optionalRecord(itemType, await database.getRecord(table, recordKey, true));
  }

  return {
    authorizationCodeForHash: (codeHash: string) =>
      get("identity", "oauth-authorization-code", exactKey("OAUTH-AUTHORIZATION-CODE", codeHash)),
    /** Create-only write of a new pending authorization transaction. */
    createBffAuthorization: (record: IdentityRecord<"web-bff-authorization-transaction">) =>
      database.transactWrite([{ kind: "put", record }]),
    /** Moves exactly the observed pending version to its next (consumed/expired) version. */
    replacePendingBffAuthorization: (
      previous: IdentityRecord<"web-bff-authorization-transaction">,
      next: IdentityRecord<"web-bff-authorization-transaction">,
    ) =>
      database.transactWrite([
        {
          conditionExpression: "#bffData.#bffStatus = :pending",
          expressionAttributeNames: { "#bffData": "data", "#bffStatus": "status" },
          expressionAttributeValues: { ":pending": "pending" },
          kind: "put",
          previousRecord: previous,
          record: next,
        },
      ]),
    /** Create-only session write committed only while the observed fence still admits it. */
    createBffSession: (
      fence: IdentityRecord<"identity-bff-revocation-fence">,
      session: IdentityRecord<"web-bff-session">,
    ) => database.transactWrite([bffFenceCheck(fence), { kind: "put", record: session }]),
    /**
     * Exact-next-version session transition. Passing the observed fence additionally requires it
     * unchanged (lease acquisition); terminal transitions omit it so they always remain possible.
     */
    replaceBffSession: (
      previous: IdentityRecord<"web-bff-session">,
      next: IdentityRecord<"web-bff-session">,
      fence?: IdentityRecord<"identity-bff-revocation-fence">,
    ) =>
      database.transactWrite([
        ...(fence ? [bffFenceCheck(fence)] : []),
        bffSessionReplacement(previous, next),
      ]),
    authorizationRequestForHash: (requestHandleHash: string) =>
      get(
        "identity",
        "oauth-authorization-request",
        exactKey("OAUTH-AUTHORIZATION-REQUEST", requestHandleHash),
      ),
    bffAuthorizationForHash: (transactionTokenHash: string) =>
      get(
        "identity",
        "web-bff-authorization-transaction",
        exactKey("WEB-BFF-AUTHORIZATION", transactionTokenHash),
      ),
    bffFenceForPrincipal: (principalId: string) =>
      get("identity", "identity-bff-revocation-fence", exactKey("BFF-IDENTITY-FENCE", principalId)),
    bffSessionForHash: (cookieTokenHash: string) =>
      get("identity", "web-bff-session", exactKey("WEB-BFF-SESSION", cookieTokenHash)),
    browserSessionVersionChecks: (
      locator: IdentityRecord<"identity-session-locator">,
      session: IdentityRecord<"identity-session">,
    ): readonly TransactionOperation[] => [versionCheck(locator), versionCheck(session)],
    /**
     * The same guard as `browserSessionVersionChecks`, but the unchanged session is replaced by
     * one whose `lastRefreshedAt` records that a token bound to it was just used.
     */
    browserSessionActivity: (
      locator: IdentityRecord<"identity-session-locator">,
      session: IdentityRecord<"identity-session">,
      at: string,
    ): readonly TransactionOperation[] => [
      versionCheck(locator),
      {
        kind: "put",
        previousRecord: session,
        record: {
          ...session,
          data: {
            ...session.data,
            lastRefreshedAt: at,
            updatedAt: at,
            version: session.data.version + 1,
          },
        },
      },
    ],
    clientForId: (clientId: string) =>
      get("identity", "oauth-client", exactKey("OAUTH-CLIENT", clientId)),
    credentialForPrincipal: (principalId: string) =>
      get("identity", "principal-credential", {
        pk: key("PRINCIPAL", principalId),
        sk: key("PRINCIPAL-CREDENTIAL", "password"),
      }),
    deliveryForId: (deliveryId: string) =>
      get(
        "identity-email-outbox",
        "identity-email-delivery",
        exactKey("IDENTITY-EMAIL-DELIVERY", deliveryId),
      ),
    deviceGrantForHash: (deviceCodeHash: string) =>
      get("identity", "oauth-device-grant", exactKey("OAUTH-DEVICE-GRANT", deviceCodeHash)),
    deviceGrantForKey: (recordKey: { readonly pk: string; readonly sk: string }) =>
      get("identity", "oauth-device-grant", recordKey),
    emailChangeForPrincipal: (principalId: string) =>
      get("identity", "principal-email-change", {
        pk: key("PRINCIPAL", principalId),
        sk: key("PRINCIPAL-EMAIL-CHANGE", principalId),
      }),
    identityActionForHash: (tokenHash: string) =>
      get("identity", "identity-action", exactKey("IDENTITY-ACTION", tokenHash)),
    mfaChallengeForHash: (tokenHash: string) =>
      get("identity", "identity-mfa-challenge", exactKey("IDENTITY-MFA-CHALLENGE", tokenHash)),
    mfaFactorForPrincipal: (principalId: string) =>
      get("identity", "principal-mfa-factor", mfaFactorKey(principalId)),
    /** Commits a password-only sign-in only while the principal still has no active factor. */
    mfaFactorInactiveCheck: (principalId: string): TransactionOperation => ({
      conditionExpression: "attribute_not_exists(pk) OR #data.#state <> :active",
      expressionAttributeNames: { "#data": "data", "#state": "state" },
      expressionAttributeValues: { ":active": "active" },
      key: mfaFactorKey(principalId),
      kind: "condition-check",
      table: "identity",
    }),
    rateLimit: (limitKey: string, scopeHash: string, window: string) =>
      get(
        "identity",
        "identity-rate-limit",
        (() => {
          const materialized = key("IDENTITY-RATE-LIMIT", limitKey, scopeHash, window);
          return { pk: materialized, sk: materialized };
        })(),
      ),
    publicEmailRequestForId: (requestId: string) =>
      get(
        "identity",
        "identity-public-email-request",
        exactKey("IDENTITY-PUBLIC-EMAIL-REQUEST", requestId),
      ),
    registrationForEmailHash: (emailHash: string) =>
      get("identity", "identity-registration", exactKey("IDENTITY-REGISTRATION", emailHash)),
    listPendingDeliveries: (
      shard: string,
      dueThrough: string,
      limit: number,
      exclusiveStartKey?: Record<string, unknown>,
      signal?: AbortSignal,
    ) =>
      database.queryRecords(
        "identity-email-outbox",
        {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: {
            "#gsi1pk": "gsi1pk",
            "#gsi1sk": "gsi1sk",
          },
          ExpressionAttributeValues: {
            ":due": key(dueThrough, "\uffff"),
            ":partition": key("IDENTITY-EMAIL-PENDING", shard),
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#gsi1pk = :partition AND #gsi1sk <= :due",
          Limit: limit,
          ScanIndexForward: true,
        },
        signal,
      ),
    listRefreshFamilies: (principalId: string, limit: number, cursor?: Record<string, unknown>) =>
      database.queryRecords("identity", {
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        ExpressionAttributeNames: { "#gsi1pk": "gsi1pk" },
        ExpressionAttributeValues: {
          ":partition": key("PRINCIPAL", principalId, "OAUTH-REFRESH-FAMILIES"),
        },
        IndexName: "gsi1",
        KeyConditionExpression: "#gsi1pk = :partition",
        Limit: limit,
      }),
    listActiveSessions: async (
      principalId: string,
      page: IdentitySessionPageRequest,
    ): Promise<IdentitySessionPage> => {
      // "active" sorts before every other session status, so `< :before` stays inside the
      // active range; the status check below keeps that ordering assumption fail-closed.
      const prefix = `${key("IDENTITY-SESSION", "active")}#`;
      const result = await database.queryRecords("identity", {
        ExpressionAttributeNames: { "#gsi1pk": "gsi1pk", "#gsi1sk": "gsi1sk" },
        ExpressionAttributeValues: {
          ":partition": key("PRINCIPAL", principalId, "IDENTITY-SESSIONS"),
          ...(page.before
            ? {
                ":before": key("IDENTITY-SESSION", "active", page.before.createdAt, page.before.id),
              }
            : { ":prefix": prefix }),
        },
        IndexName: "gsi1",
        KeyConditionExpression: page.before
          ? "#gsi1pk = :partition AND #gsi1sk < :before"
          : "#gsi1pk = :partition AND begins_with(#gsi1sk, :prefix)",
        Limit: page.limit,
        ScanIndexForward: false,
      });
      const items = result.items.filter(
        (record): record is IdentityRecord<"identity-session"> =>
          record.itemType === "identity-session" &&
          record.data.status === "active" &&
          record.data.principalId === principalId,
      );
      const last = items.at(-1);
      return {
        items,
        ...(result.lastEvaluatedKey && last
          ? { next: { createdAt: last.data.createdAt, id: last.data.id } }
          : {}),
      };
    },
    loginMaterialVersionChecks: (
      principal: IdentityRecord<"principal">,
      securityState: IdentityRecord<"principal-security-state">,
    ): readonly TransactionOperation[] => [
      {
        conditionExpression: "#data.#version = :version AND #data.#status = :active",
        expressionAttributeNames: {
          "#data": "data",
          "#status": "status",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":active": "active",
          ":version": principal.data.version,
        },
        key: { pk: principal.pk, sk: principal.sk },
        kind: "condition-check",
        table: "control",
      },
      {
        conditionExpression: "#data.#version = :version AND #data.#sessionEpoch = :sessionEpoch",
        expressionAttributeNames: {
          "#data": "data",
          "#sessionEpoch": "sessionEpoch",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":sessionEpoch": securityState.data.sessionEpoch,
          ":version": securityState.data.version,
        },
        key: { pk: securityState.pk, sk: securityState.sk },
        kind: "condition-check",
        table: "identity",
      },
    ],
    loadLoginMaterial: (principalId: string) =>
      Effect.runPromise(
        Effect.all(
          {
            credential: fromDatabase(() =>
              get("identity", "principal-credential", {
                pk: key("PRINCIPAL", principalId),
                sk: key("PRINCIPAL-CREDENTIAL", "password"),
              }),
            ),
            principal: fromDatabase(() =>
              get("control", "principal", exactKey("PRINCIPAL", principalId)),
            ),
            securityState: fromDatabase(() =>
              get("identity", "principal-security-state", {
                pk: key("PRINCIPAL", principalId),
                sk: key("PRINCIPAL-SECURITY-STATE", "current"),
              }),
            ),
          },
          { concurrency: 3 },
        ),
      ),
    principalForEmailHash: async (emailHash: string) => {
      const claim = await get("control", "unique-claim", {
        pk: key("UNIQUE", "principal-email"),
        sk: key("VALUE", emailHash),
      });
      return claim
        ? get("control", "principal", { pk: claim.data.ownerPk, sk: claim.data.ownerSk })
        : undefined;
    },
    principalForId: (principalId: string) =>
      get("control", "principal", exactKey("PRINCIPAL", principalId)),
    refreshFamilyForId: (familyId: string) =>
      get("identity", "oauth-refresh-family", exactKey("OAUTH-REFRESH-FAMILY", familyId)),
    refreshTokenForHash: (tokenHash: string) =>
      get("identity", "oauth-refresh-token", exactKey("OAUTH-REFRESH-TOKEN", tokenHash)),
    reauthenticationRequestForHash: (tokenHash: string) =>
      get(
        "identity",
        "oauth-reauthentication-request",
        exactKey("OAUTH-REAUTHENTICATION-REQUEST", tokenHash),
      ),
    securityStateForPrincipal: (principalId: string) =>
      get("identity", "principal-security-state", {
        pk: key("PRINCIPAL", principalId),
        sk: key("PRINCIPAL-SECURITY-STATE", "current"),
      }),
    sessionForHash: (tokenHash: string) =>
      get("identity", "identity-session", exactKey("IDENTITY-SESSION", tokenHash)),
    sessionLocator: (principalId: string, sessionId: string) =>
      get("identity", "identity-session-locator", {
        pk: key("PRINCIPAL", principalId),
        sk: key("IDENTITY-SESSION-LOCATOR", sessionId),
      }),
    transact: (
      operations: readonly TransactionOperation[],
      clientRequestToken?: string,
      signal?: AbortSignal,
    ) => database.transactWrite(operations, clientRequestToken, signal),
    userCodeClaim: (userCodeHash: string) =>
      get("control", "unique-claim", {
        pk: key("UNIQUE", "oauth-device-user-code"),
        sk: key("VALUE", userCodeHash),
      }),
  };
}

export type IdentityRepository = ReturnType<typeof makeIdentityRepository>;
