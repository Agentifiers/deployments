import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import {
  replaceWithClaims,
  type AdministrationContext,
} from "../identity-federation/administration-context.ts";
import { Keys } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import {
  MAX_DIRECTORY_TOKENS,
  type DirectoryRole,
  type DirectoryToken,
  type OrganizationDirectoryRecord,
} from "../records/directory.ts";
import type { DirectoryReads } from "./reads.ts";
import { directoryRecord } from "./record-builders.ts";
import { DIRECTORY_TOKEN_HASH_CLAIM_NAMESPACE } from "./record-rules.ts";

/** Every directory bearer token starts with this, so the API key authenticator can skip it. */
export const DIRECTORY_TOKEN_PREFIX = "dpl_scim_";

const AGGREGATE_TYPE = "organization-directory";
const NOT_CONFIGURED = {
  code: "directory_not_configured",
  message: "Directory sync is not configured for this organization.",
} as const;
const CONFLICT = {
  code: "directory_conflict",
  message: "The directory changed concurrently; retry.",
} as const;

export interface DirectoryAdministrator {
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
}

/** Who is calling SCIM. The organization comes only from the token, never from the request. */
export interface DirectoryCaller {
  readonly organizationId: Ulid;
  readonly tokenId: Ulid;
}

export type DirectoryTokenSummary = Omit<DirectoryToken, "tokenHash">;

export interface DirectorySettings {
  readonly createdAt: string;
  readonly defaultRole: DirectoryRole;
  readonly tokens: readonly DirectoryTokenSummary[];
  readonly updatedAt: string;
}

/** The only place a token's secret appears. */
export interface IssuedDirectoryToken {
  readonly secret: string;
  readonly settings: DirectorySettings;
  readonly token: DirectoryTokenSummary;
}

export interface DirectoryAdministration {
  readonly authenticate: (bearerToken: string) => Promise<DirectoryCaller | undefined>;
  readonly getSettings: (organizationId: Ulid) => Promise<DirectorySettings>;
  readonly issueToken: (administrator: DirectoryAdministrator) => Promise<IssuedDirectoryToken>;
  readonly putSettings: (
    administrator: DirectoryAdministrator,
    settings: { readonly defaultRole: DirectoryRole },
  ) => Promise<DirectorySettings>;
  readonly revokeToken: (
    administrator: DirectoryAdministrator,
    tokenId: Ulid,
  ) => Promise<DirectorySettings>;
}

function summary({ tokenHash: _hash, ...token }: DirectoryToken): DirectoryTokenSummary {
  return token;
}

function settingsView({ data }: OrganizationDirectoryRecord): DirectorySettings {
  return {
    createdAt: data.createdAt,
    defaultRole: data.defaultRole,
    tokens: data.tokens.map(summary),
    updatedAt: data.updatedAt,
  };
}

export function makeDirectoryAdministration(
  context: AdministrationContext,
  reads: DirectoryReads,
  randomSecret: () => string = () => randomBytes(32).toString("base64url"),
): DirectoryAdministration {
  const { database } = context;

  async function configured(organizationId: Ulid) {
    const record = await reads.directory(organizationId);
    if (!record) {
      throw new PersistenceError("not-found", NOT_CONFIGURED.code, NOT_CONFIGURED.message);
    }
    return record;
  }

  async function write(input: {
    readonly administrator: DirectoryAdministrator;
    readonly eventType: string;
    readonly operations: readonly TransactionOperation[];
    readonly payload: Readonly<Record<string, string>>;
    readonly record: OrganizationDirectoryRecord;
  }) {
    await context.commit(
      input.administrator,
      input.operations,
      {
        aggregateId: input.record.data.organizationId,
        aggregateType: AGGREGATE_TYPE,
        aggregateVersion: input.record.data.version,
        eventType: input.eventType,
        occurredAt: input.record.data.updatedAt,
        payload: input.payload,
      },
      CONFLICT,
    );
    return settingsView(input.record);
  }

  function replaced(
    current: OrganizationDirectoryRecord,
    changes: Pick<OrganizationDirectoryRecord["data"], "defaultRole" | "tokens">,
    at: string,
  ) {
    return directoryRecord("organization-directory", {
      ...current.data,
      ...changes,
      updatedAt: at,
      version: current.data.version + 1,
    });
  }

  return {
    authenticate: async (bearerToken) => {
      if (!bearerToken.startsWith(DIRECTORY_TOKEN_PREFIX)) return undefined;
      const hash = createHash("sha256").update(bearerToken).digest("hex");
      const claim = await database.getRecord(
        "control",
        Keys.control.uniqueClaim(DIRECTORY_TOKEN_HASH_CLAIM_NAMESPACE, hash),
        true,
      );
      if (claim?.itemType !== "unique-claim") return undefined;
      const owner = await database.getRecord(
        "control",
        { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
        true,
      );
      if (owner?.itemType !== "organization-directory") return undefined;
      const presented = Buffer.from(hash);
      const token = owner.data.tokens.find((candidate) => {
        const expected = Buffer.from(candidate.tokenHash);
        return expected.length === presented.length && timingSafeEqual(expected, presented);
      });
      return token ? { organizationId: owner.data.organizationId, tokenId: token.id } : undefined;
    },

    getSettings: async (organizationId) => settingsView(await configured(organizationId)),

    putSettings: async (administrator, { defaultRole }) => {
      const current = await reads.directory(administrator.organizationId);
      const at = context.now().toISOString();
      if (!current) {
        const record = directoryRecord("organization-directory", {
          createdAt: at,
          defaultRole,
          id: administrator.organizationId,
          organizationId: administrator.organizationId,
          tokens: [],
          updatedAt: at,
          version: 1,
        });
        return write({
          administrator,
          eventType: "organization-directory.created",
          operations: [{ kind: "put", record }],
          payload: { defaultRole },
          record,
        });
      }
      if (current.data.defaultRole === defaultRole) return settingsView(current);
      const record = replaced(current, { defaultRole, tokens: current.data.tokens }, at);
      return write({
        administrator,
        eventType: "organization-directory.updated",
        operations: [{ kind: "put", previousRecord: current, record }],
        payload: { defaultRole },
        record,
      });
    },

    issueToken: async (administrator) => {
      const current = await configured(administrator.organizationId);
      if (current.data.tokens.length >= MAX_DIRECTORY_TOKENS) {
        throw new PersistenceError(
          "conflict",
          "directory_token_limit",
          `A directory holds at most ${MAX_DIRECTORY_TOKENS} tokens; revoke one first.`,
        );
      }
      const at = context.now().toISOString();
      const secret = `${DIRECTORY_TOKEN_PREFIX}${randomSecret()}`;
      const token: DirectoryToken = {
        createdAt: at,
        createdBy: administrator.principalId,
        id: context.generateId(),
        tokenHash: createHash("sha256").update(secret).digest("hex"),
        tokenPrefix: secret.slice(0, 16),
      };
      const record = replaced(
        current,
        { defaultRole: current.data.defaultRole, tokens: [...current.data.tokens, token] },
        at,
      );
      const settings = await write({
        administrator,
        eventType: "organization-directory.token-issued",
        operations: replaceWithClaims(current, record, at),
        payload: { tokenId: token.id, tokenPrefix: token.tokenPrefix },
        record,
      });
      return { secret, settings, token: summary(token) };
    },

    revokeToken: async (administrator, tokenId) => {
      const current = await configured(administrator.organizationId);
      const revoked = current.data.tokens.find((token) => token.id === tokenId);
      if (!revoked) {
        throw new PersistenceError(
          "not-found",
          "directory_token_not_found",
          "The directory token was not found.",
        );
      }
      const at = context.now().toISOString();
      const record = replaced(
        current,
        {
          defaultRole: current.data.defaultRole,
          tokens: current.data.tokens.filter((token) => token.id !== tokenId),
        },
        at,
      );
      return write({
        administrator,
        eventType: "organization-directory.token-revoked",
        operations: replaceWithClaims(current, record, at),
        payload: { tokenId, tokenPrefix: revoked.tokenPrefix },
        record,
      });
    },
  };
}
