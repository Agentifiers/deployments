import { Schema } from "effect";
import type {
  DynamoDatabaseService,
  QueryRecordsResult,
  TransactionOperation,
} from "../client-types.ts";
import { makeOrganizationCapacity, makeSlotClaims } from "../capacity/organization-capacity.ts";
import {
  dnsOwnershipProof,
  dnsOwnershipProven,
  dnsOwnershipToken,
  type ObserveTxt,
} from "../dns-ownership-proof.ts";
import { replaceWithClaims } from "../identity-federation/administration-context.ts";
import { createWithClaims, deleteWithClaims } from "../identity-federation/operations.ts";
import type { Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import type { DynamoValue } from "../record-schema.ts";
import {
  APP_DOMAIN_LIMIT,
  APP_DOMAIN_PROOF_LABEL,
  AppDomainRecord,
  isPublishedAppDomain,
  type AppDomainCertificateSearch,
  type AppDomainProblem,
  type AppHostname,
  type PublishedAppDomain,
} from "../records/app-domains.ts";
import type { AppLifecycleState, AppRecord } from "../records/apps.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";
import {
  takeCertificateRequest,
  type CertificateRequestGrant,
  type CertificateRequestLimits,
} from "./certificate-requests.ts";
import {
  APP_ID_CLAIM_NAMESPACE,
  VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE,
  appDomainHostnameClaimNamespace,
  appDomainSlotClaimNamespace,
} from "./claims.ts";
import { AppPersistenceError, commit, refuse } from "./errors.ts";
import { appChildPartition } from "./reads.ts";
import type { AppActor, AppErasureOwner, AppRevisions } from "./revision.ts";

export const ORGANIZATION_APP_DOMAIN_LIMIT = 50;

const APP_DOMAIN_CHANGE_STATES = {
  activate: ["provisioning", "active"],
  attach: ["provisioning", "active"],
  detach: ["provisioning", "failed", "active", "archived", "erasing"],
  verify: ["provisioning", "active"],
} as const satisfies Record<string, readonly AppLifecycleState[]>;

type AppDomainChange = keyof typeof APP_DOMAIN_CHANGE_STATES;

export interface AppDomainPersistence {
  readonly getDomain: (input: {
    readonly app: AppRecord;
    readonly domainId: Ulid;
  }) => Promise<AppDomainRecord | undefined>;
  readonly listDomains: (app: AppRecord) => Promise<readonly AppDomainRecord[]>;
  /** The verified or active domain that holds the hostname's global claim, in any app. */
  readonly domainForHostname: (hostname: AppHostname) => Promise<AppDomainRecord | undefined>;
  readonly attachDomain: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly hostname: AppHostname;
  }) => Promise<AppDomainRecord>;
  readonly verifyDomain: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly domain: AppDomainRecord;
    readonly observeTxt: ObserveTxt;
  }) => Promise<AppDomainRecord>;
  readonly detachDomain: (input: {
    readonly actor: AppActor;
    readonly app: AppRecord;
    readonly domain: AppDomainRecord;
    readonly erasureOwner?: AppErasureOwner;
  }) => Promise<void>;
}

export interface AppDomainReconciliation {
  readonly listPublishedDomains: () => Promise<readonly PublishedAppDomain[]>;
  readonly findDomain: (input: {
    readonly appId: Ulid;
    readonly domainId: Ulid;
    readonly organizationId: Ulid;
  }) => Promise<AppDomainRecord | undefined>;
  /** Resolves undefined when a concurrent change won; the next run sees the newer record. */
  readonly activateDomain: (domain: PublishedAppDomain) => Promise<AppDomainRecord | undefined>;
  readonly recordDomainProblem: (input: {
    readonly domain: PublishedAppDomain;
    readonly problem: AppDomainProblem | null;
  }) => Promise<AppDomainRecord | undefined>;
  /** Replaces the rejected creates whose certificate the reconciler still looks for. */
  readonly recordCertificateSearches: (input: {
    readonly certificateSearches: readonly AppDomainCertificateSearch[];
    readonly domain: PublishedAppDomain;
  }) => Promise<AppDomainRecord | undefined>;
  /** Spends one certificate request of the domain's organization and of the platform for today. */
  readonly takeCertificateRequest: (input: {
    readonly limits: CertificateRequestLimits;
    readonly organizationId: Ulid;
  }) => Promise<CertificateRequestGrant>;
}

const RECONCILER: AppActor = { type: "system" };
const PUBLISHED_DOMAIN_READ_CONCURRENCY = 16;

export function appDomainDnsRecord(domain: Pick<AppDomainRecord["data"], "hostname" | "token">) {
  return dnsOwnershipProof(APP_DOMAIN_PROOF_LABEL, domain.hostname, domain.token);
}

const decodeDomain = Schema.decodeUnknownSync(AppDomainRecord);

function domainRecord(data: (typeof AppDomainRecord.Encoded)["data"]) {
  return decodeDomain(withCanonicalRecordKeys({ data, itemType: "app-domain" as const }));
}

function requireDomainChange(operation: string, app: AppRecord, change: AppDomainChange) {
  const allowed: readonly AppLifecycleState[] = APP_DOMAIN_CHANGE_STATES[change];
  if (!allowed.includes(app.data.lifecycle.state)) {
    refuse(
      operation,
      "illegal-state",
      `App ${app.data.id} is ${app.data.lifecycle.state}; ${operation} needs ${allowed.join(" or ")}.`,
    );
  }
}

export function appLifecycleCondition(
  app: Pick<AppRecord, "pk" | "sk">,
  change: AppDomainChange,
): TransactionOperation {
  const states = APP_DOMAIN_CHANGE_STATES[change];
  const placeholders = states.map((_, index) => `:state${index}`);
  return {
    conditionExpression: `#itemType = :itemType AND #data.#status IN (${placeholders.join(", ")})`,
    expressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#status": "status" },
    expressionAttributeValues: {
      ":itemType": "app",
      ...Object.fromEntries(states.map((state, index) => [`:state${index}`, state])),
    },
    key: { pk: app.pk, sk: app.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function makeAppDomainPersistence(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
  readonly transact: AppRevisions["transact"];
}): AppDomainPersistence & AppDomainReconciliation {
  const { database, generateId, now, transact } = dependencies;
  const slots = makeSlotClaims(database);
  const organizationCapacity = makeOrganizationCapacity(database);

  async function claimOwner(namespace: string, value: string) {
    const claim = await database.getRecord(
      "control",
      Keys.control.uniqueClaim(namespace, value),
      true,
    );
    if (claim?.itemType !== "unique-claim") return undefined;
    const owner = await database.getRecord(
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
    return owner?.itemType === "app-domain" ? owner : undefined;
  }

  async function getDomain({
    app,
    domainId,
  }: {
    readonly app: AppRecord;
    readonly domainId: Ulid;
  }) {
    const domain = await database.getRecord(
      "control",
      { pk: appChildPartition(app), sk: key("APP-DOMAIN", domainId) },
      true,
    );
    return domain?.itemType === "app-domain" ? domain : undefined;
  }

  async function write(
    operation: string,
    actor: AppActor,
    domain: AppDomainRecord,
    event: {
      readonly payload?: Readonly<Record<string, DynamoValue>>;
      readonly type: string;
      readonly version: number;
    },
    operations: readonly TransactionOperation[],
    erasureOwner?: AppErasureOwner,
  ) {
    const { data } = domain;
    const semanticEvent = makeSemanticEventRecord({
      actor,
      aggregateId: data.id,
      aggregateType: "app-domain",
      aggregateVersion: event.version,
      environmentId: data.environmentId,
      eventId: generateId(),
      eventType: event.type,
      occurredAt: now().toISOString(),
      organizationId: data.organizationId,
      payload: {
        ...event.payload,
        appId: data.appId,
        domainId: data.id,
        hostname: data.hostname,
      },
      projectId: data.projectId,
    });
    await commit(operation, transact(operations, [semanticEvent], erasureOwner));
  }

  async function refuseLostRace(
    operation: string,
    change: AppDomainChange,
    app: AppRecord,
    cause: unknown,
  ): Promise<never> {
    if (!(cause instanceof AppPersistenceError) || cause.reason !== "conflict") throw cause;
    const latest = await database.getRecord("control", { pk: app.pk, sk: app.sk }, true);
    if (latest?.itemType !== "app") refuse(operation, "not-found", `App ${app.data.id} is gone.`);
    requireDomainChange(operation, latest, change);
    throw cause;
  }

  async function reviseState(
    operation: string,
    domain: PublishedAppDomain,
    state: PublishedAppDomain["data"]["state"],
    event: {
      readonly payload?: Readonly<Record<string, DynamoValue>>;
      readonly type: string;
    },
    conditions: readonly TransactionOperation[],
  ) {
    const next = domainRecord({
      ...domain.data,
      state,
      updatedAt: now().toISOString(),
      version: domain.data.version + 1,
    });
    try {
      await write(operation, RECONCILER, next, { ...event, version: next.data.version }, [
        { kind: "put", previousRecord: domain, record: next },
        ...conditions,
      ]);
      return next;
    } catch (cause) {
      if (cause instanceof AppPersistenceError && cause.reason === "conflict") return undefined;
      throw cause;
    }
  }

  return {
    getDomain,

    domainForHostname: (hostname) => claimOwner(VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE, hostname),

    async listDomains(app) {
      const result = await database.queryRecords("control", {
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": appChildPartition(app),
          ":sk": `${key("APP-DOMAIN")}#`,
        },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      });
      return result.items.filter((record) => record.itemType === "app-domain");
    },

    async attachDomain({ actor, app, hostname }) {
      requireDomainChange("attach-domain", app, "attach");
      const hostnameClaim = appDomainHostnameClaimNamespace(app.data.id);
      const existing = await claimOwner(hostnameClaim, hostname);
      if (existing) return existing;
      const id = generateId();
      const token = dnsOwnershipToken();
      try {
        const attached = await slots.acquire(appDomainSlotClaimNamespace(app.data.id), {
          commit: async (appSlot) => {
            const at = now().toISOString();
            const domain = domainRecord({
              appId: app.data.id,
              appSlot,
              attachedBy: actor,
              createdAt: at,
              environmentId: app.data.environmentId,
              hostname,
              id,
              organizationId: app.data.organizationId,
              projectId: app.data.projectId,
              state: { kind: "unverified" },
              token,
              updatedAt: at,
              version: 1,
            });
            await write(
              "attach-domain",
              actor,
              domain,
              { type: "app.domain.attached", version: 1 },
              [...createWithClaims(domain, at), appLifecycleCondition(app, "attach")],
            );
            return domain;
          },
          holderId: id,
          limit: APP_DOMAIN_LIMIT,
        });
        if (attached.kind === "acquired") return attached.value;
      } catch (cause) {
        const winner = await claimOwner(hostnameClaim, hostname);
        if (winner) return winner;
        await refuseLostRace("attach-domain", "attach", app, cause);
      }
      return refuse(
        "attach-domain",
        "app-domain-limit",
        `App ${app.data.id} already has ${APP_DOMAIN_LIMIT} domains.`,
      );
    },

    async verifyDomain({ actor, app, domain, observeTxt }) {
      if (domain.data.state.kind !== "unverified") return domain;
      requireDomainChange("verify-domain", app, "verify");
      const proof = appDomainDnsRecord(domain.data);
      if (!(await dnsOwnershipProven(proof, observeTxt))) {
        refuse(
          "verify-domain",
          "txt-not-found",
          `No TXT record at ${proof.name} is ${proof.value}.`,
        );
      }
      const refuseIfClaimed = async () => {
        const owner = await claimOwner(VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE, domain.data.hostname);
        if (owner && owner.data.id !== domain.data.id) {
          refuse(
            "verify-domain",
            "domain-claimed",
            `${domain.data.hostname} is already verified for another app.`,
          );
        }
      };
      await refuseIfClaimed();
      try {
        const verified = await organizationCapacity.acquire({
          commit: async (slot) => {
            const at = now().toISOString();
            const next = domainRecord({
              ...domain.data,
              state: { kind: "verified", problem: null, slot, verifiedAt: at },
              updatedAt: at,
              version: domain.data.version + 1,
            });
            await write(
              "verify-domain",
              actor,
              next,
              { type: "app.domain.verified", version: next.data.version },
              [...replaceWithClaims(domain, next, at), appLifecycleCondition(app, "verify")],
            );
            return next;
          },
          holderId: domain.data.id,
          limit: ORGANIZATION_APP_DOMAIN_LIMIT,
          organizationId: domain.data.organizationId,
          resource: "app-domain",
        });
        if (verified.kind === "acquired") return verified.value;
      } catch (cause) {
        await refuseIfClaimed();
        const latest = await getDomain({ app, domainId: domain.data.id });
        if (!latest) refuse("verify-domain", "not-found", `Domain ${domain.data.id} was detached.`);
        if (latest.data.state.kind !== "unverified") return latest;
        await refuseLostRace("verify-domain", "verify", app, cause);
      }
      return refuse(
        "verify-domain",
        "organization-domain-limit",
        `The organization already has ${ORGANIZATION_APP_DOMAIN_LIMIT} verified domains.`,
      );
    },

    async detachDomain({ actor, app, domain, erasureOwner }) {
      requireDomainChange("detach-domain", app, "detach");
      try {
        await write(
          "detach-domain",
          actor,
          domain,
          { type: "app.domain.detached", version: domain.data.version + 1 },
          [...deleteWithClaims(domain), appLifecycleCondition(app, "detach")],
          erasureOwner,
        );
      } catch (cause) {
        const detached =
          cause instanceof AppPersistenceError &&
          cause.reason === "conflict" &&
          !(await getDomain({ app, domainId: domain.data.id }));
        if (detached) return;
        await refuseLostRace("detach-domain", "detach", app, cause);
      }
    },

    async listPublishedDomains() {
      const owners: { pk: string; sk: string }[] = [];
      let start: QueryRecordsResult["lastEvaluatedKey"];
      do {
        const page = await database.queryRecords("control", {
          ConsistentRead: true,
          ExpressionAttributeValues: {
            ":pk": key("UNIQUE", VERIFIED_APP_HOSTNAME_CLAIM_NAMESPACE),
          },
          KeyConditionExpression: "pk = :pk",
          ...(start ? { ExclusiveStartKey: start } : {}),
        });
        for (const claim of page.items) {
          if (claim.itemType === "unique-claim" && claim.data.ownerItemType === "app-domain") {
            owners.push({ pk: claim.data.ownerPk, sk: claim.data.ownerSk });
          }
        }
        start = page.lastEvaluatedKey;
      } while (start);
      const domains: PublishedAppDomain[] = [];
      for (let index = 0; index < owners.length; index += PUBLISHED_DOMAIN_READ_CONCURRENCY) {
        const records = await Promise.all(
          owners
            .slice(index, index + PUBLISHED_DOMAIN_READ_CONCURRENCY)
            .map((owner) => database.getRecord("control", owner, true)),
        );
        for (const record of records) {
          if (record?.itemType === "app-domain" && isPublishedAppDomain(record)) {
            domains.push(record);
          }
        }
      }
      return domains;
    },

    async findDomain({ appId, domainId, organizationId }) {
      const domain = await database.getRecord(
        "control",
        { pk: key("ORG", organizationId, "APP", appId), sk: key("APP-DOMAIN", domainId) },
        true,
      );
      return domain?.itemType === "app-domain" ? domain : undefined;
    },

    async activateDomain(domain) {
      const { state } = domain.data;
      if (state.kind === "active") return domain;
      const appClaim = await database.getRecord(
        "control",
        Keys.control.uniqueClaim(APP_ID_CLAIM_NAMESPACE, domain.data.appId),
        true,
      );
      if (appClaim?.itemType !== "unique-claim") return undefined;
      return reviseState(
        "activate-domain",
        domain,
        { ...state, activatedAt: now().toISOString(), kind: "active", problem: null },
        { type: "app.domain.activated" },
        [
          appLifecycleCondition(
            { pk: appClaim.data.ownerPk, sk: appClaim.data.ownerSk },
            "activate",
          ),
        ],
      );
    },

    async recordDomainProblem({ domain, problem }) {
      const recorded = domain.data.state.problem;
      if (
        recorded?.code === problem?.code &&
        recorded?.observedAt === problem?.observedAt &&
        recorded?.rejectedCreates?.count === problem?.rejectedCreates?.count &&
        recorded?.rejectedCreates?.latestAt === problem?.rejectedCreates?.latestAt
      ) {
        return domain;
      }
      return reviseState(
        "record-domain-problem",
        domain,
        { ...domain.data.state, problem },
        problem
          ? {
              payload: {
                problem: problem.code,
                ...(problem.rejectedCreates
                  ? { rejectedCreates: problem.rejectedCreates.count }
                  : {}),
              },
              type: "app.domain.problem_recorded",
            }
          : { type: "app.domain.problem_cleared" },
        [],
      );
    },

    async recordCertificateSearches({ certificateSearches, domain }) {
      const { certificateSearches: _previous, ...state } = domain.data.state;
      return reviseState(
        "record-certificate-searches",
        domain,
        certificateSearches.length > 0 ? { ...state, certificateSearches } : state,
        {
          payload: { certificateSearches: certificateSearches.length },
          type: "app.domain.certificate_searches_recorded",
        },
        [],
      );
    },

    takeCertificateRequest: (input) => takeCertificateRequest({ database, now }, input),
  };
}
