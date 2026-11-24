import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import {
  AppLoginHandoffRecord,
  AppLoginTransactionRecord,
  AppSessionRecord,
  sameAppHost,
  type AppHost,
  type AppMemberSessionSubject,
  type AppReturnPath,
  type AppSessionId,
  type AppSessionSubject,
} from "../records/apps.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { AppPersistenceError, commit } from "./errors.ts";

export interface AppSessionKey {
  readonly sessionId: AppSessionId;
}

export interface CreateAppSessionInput extends AppSessionKey {
  readonly appId: Ulid;
  readonly expiresAt: Date;
  readonly subject: AppSessionSubject;
}

export interface BeginAppLoginInput {
  readonly appId: Ulid;
  readonly bindingHash: string;
  readonly codeVerifier: string;
  readonly expiresAt: Date;
  readonly host: AppHost;
  readonly nonceHash: string;
  readonly returnTo: AppReturnPath;
  readonly stateHash: string;
}

export type ConsumedAppLoginTransaction = AppLoginTransactionRecord & {
  readonly __brand: "ConsumedAppLoginTransaction";
};

export interface IssueAppLoginHandoffInput {
  readonly expiresAt: Date;
  readonly handoffHash: string;
  readonly login: ConsumedAppLoginTransaction;
  readonly subject: AppMemberSessionSubject;
}

/** Redeemable only on the host the login started on, which also becomes the session's host. */
export interface RedeemAppLoginHandoffInput {
  readonly appId: Ulid;
  readonly bindingHash: string;
  readonly handoffHash: string;
  readonly host: AppHost;
  readonly session: {
    readonly expiresAt: Date;
    readonly sessionId: AppSessionId;
  };
}

export type AppLoginHandoffRedemption =
  | {
      readonly kind: "redeemed";
      readonly returnTo: AppReturnPath;
      readonly session: AppSessionRecord;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "expired"
        | "missing"
        | "other-app"
        | "other-browser"
        | "other-host"
        | "used";
    };

export interface AppSessionPersistence {
  readonly createSession: (input: CreateAppSessionInput) => Promise<AppSessionRecord>;
  /** Returns undefined once the session is logically expired, before TTL removes it. */
  readonly getSession: (input: AppSessionKey) => Promise<AppSessionRecord | undefined>;
  readonly deleteSession: (input: AppSessionKey) => Promise<void>;
  readonly beginLogin: (input: BeginAppLoginInput) => Promise<AppLoginTransactionRecord>;
  readonly consumeLogin: (input: {
    readonly stateHash: string;
  }) => Promise<ConsumedAppLoginTransaction | undefined>;
  readonly issueLoginHandoff: (input: IssueAppLoginHandoffInput) => Promise<AppLoginHandoffRecord>;
  readonly redeemLoginHandoff: (
    input: RedeemAppLoginHandoffInput,
  ) => Promise<AppLoginHandoffRedemption>;
}

const decodeSession = Schema.decodeUnknownSync(AppSessionRecord);
const decodeLogin = Schema.decodeUnknownSync(AppLoginTransactionRecord);
const decodeHandoff = Schema.decodeUnknownSync(AppLoginHandoffRecord);

type HashKeyedItemType = "app-login-handoff" | "app-login-transaction" | "app-session";

function ttl(expiresAt: Date) {
  return Math.floor(expiresAt.getTime() / 1_000);
}

export function makeAppSessionPersistence(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly now: () => Date;
}): AppSessionPersistence {
  const { database, now } = dependencies;

  async function read(itemType: HashKeyedItemType, id: string) {
    const partition = key(itemType.toUpperCase(), id);
    return database.getRecord("identity", { pk: partition, sk: partition }, true);
  }

  function unexpired<Stored extends { readonly data: { readonly expiresAt: string } }>(
    record: Stored | undefined,
  ) {
    return record && Date.parse(record.data.expiresAt) > now().getTime() ? record : undefined;
  }

  async function storedSession(sessionId: AppSessionId) {
    const record = await read("app-session", sessionId);
    return record?.itemType === "app-session" ? record : undefined;
  }

  async function consume(operation: string, operations: readonly TransactionOperation[]) {
    try {
      await commit(operation, database.transactWrite(operations));
      return true;
    } catch (error) {
      if (error instanceof AppPersistenceError && error.reason === "conflict") return false;
      throw error;
    }
  }

  function sessionRecord(input: CreateAppSessionInput & { readonly host: AppHost }) {
    return decodeSession(
      withCanonicalRecordKeys({
        data: {
          appId: input.appId,
          createdAt: now().toISOString(),
          expiresAt: input.expiresAt.toISOString(),
          host: input.host,
          id: input.sessionId,
          subject: input.subject,
        },
        itemType: "app-session" as const,
        ttl: ttl(input.expiresAt),
      }),
    );
  }

  return {
    async createSession(input) {
      const session = sessionRecord({ ...input, host: { kind: "slug" } });
      await commit("create-session", database.transactWrite([{ kind: "put", record: session }]));
      return session;
    },

    async getSession(input) {
      return unexpired(await storedSession(input.sessionId));
    },

    async deleteSession(input) {
      const session = await storedSession(input.sessionId);
      if (!session) return;
      await consume("delete-session", [{ kind: "delete", record: session }]);
    },

    async beginLogin(input) {
      const login = decodeLogin(
        withCanonicalRecordKeys({
          data: {
            appId: input.appId,
            bindingHash: input.bindingHash,
            codeVerifier: input.codeVerifier,
            createdAt: now().toISOString(),
            expiresAt: input.expiresAt.toISOString(),
            host: input.host,
            id: input.stateHash,
            nonceHash: input.nonceHash,
            returnTo: input.returnTo,
          },
          itemType: "app-login-transaction" as const,
          ttl: ttl(input.expiresAt),
        }),
      );
      await commit("begin-login", database.transactWrite([{ kind: "put", record: login }]));
      return login;
    },

    async consumeLogin(input) {
      const record = await read("app-login-transaction", input.stateHash);
      const login = unexpired(record?.itemType === "app-login-transaction" ? record : undefined);
      if (!login) return undefined;
      return (await consume("consume-login", [{ kind: "delete", record: login }]))
        ? (login as ConsumedAppLoginTransaction)
        : undefined;
    },

    async issueLoginHandoff(input) {
      const handoff = decodeHandoff(
        withCanonicalRecordKeys({
          data: {
            appId: input.login.data.appId,
            bindingHash: input.login.data.bindingHash,
            createdAt: now().toISOString(),
            expiresAt: input.expiresAt.toISOString(),
            host: input.login.data.host,
            id: input.handoffHash,
            returnTo: input.login.data.returnTo,
            subject: input.subject,
          },
          itemType: "app-login-handoff" as const,
          ttl: ttl(input.expiresAt),
        }),
      );
      await commit(
        "issue-login-handoff",
        database.transactWrite([{ kind: "put", record: handoff }]),
      );
      return handoff;
    },

    async redeemLoginHandoff(input) {
      const record = await read("app-login-handoff", input.handoffHash);
      const handoff = record?.itemType === "app-login-handoff" ? record : undefined;
      if (!handoff) return { kind: "rejected", reason: "missing" };
      if (!unexpired(handoff)) return { kind: "rejected", reason: "expired" };
      if (handoff.data.appId !== input.appId) return { kind: "rejected", reason: "other-app" };
      if (handoff.data.bindingHash !== input.bindingHash) {
        return { kind: "rejected", reason: "other-browser" };
      }
      if (!sameAppHost(handoff.data.host, input.host))
        return { kind: "rejected", reason: "other-host" };
      const session = sessionRecord({
        appId: input.appId,
        expiresAt: input.session.expiresAt,
        host: handoff.data.host,
        sessionId: input.session.sessionId,
        subject: handoff.data.subject,
      });
      const redeemed = await consume("redeem-login-handoff", [
        { kind: "delete", record: handoff },
        { kind: "put", record: session },
      ]);
      return redeemed
        ? { kind: "redeemed", returnTo: handoff.data.returnTo, session }
        : { kind: "rejected", reason: "used" };
    },
  };
}
