import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  DatabaseError,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "../client-types.ts";
import {
  makeEmailPersistence,
  type EmailDomainInput,
  type EmailPersistenceEvent,
  type EmailScope,
  type EmailTenantInput,
} from "./persistence.ts";
import type { Ulid } from "../ids.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENV = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const TENANT = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const DOMAIN = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const NOW = "2026-09-16T00:00:00.000Z";
const scope: EmailScope = { organizationId: ORG, projectId: PROJECT, environmentId: ENV };

function tenant(id = TENANT, tenantScope = scope): EmailTenantInput {
  return {
    itemType: "email-tenant",
    data: {
      ...tenantScope,
      id,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      name: "Transactional email",
      status: "active",
      region: "us-east-2",
      providerName: `email-${id}`,
      configurationSetName: `email-${id}`,
      sendingStatus: "enabled",
      providerMetadata: {},
    },
  };
}

function domain(id = DOMAIN, tenantScope = scope): EmailDomainInput {
  return {
    itemType: "email-domain",
    data: {
      ...tenantScope,
      id,
      tenantId: TENANT,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
      domain: "mail.example.com",
      status: "pending",
      dnsRecords: [],
      mailFromDomain: "bounce.mail.example.com",
      providerMetadata: {},
    },
  };
}

function fixture(initial: readonly PlatformRecord[] = []) {
  const records = new Map(initial.map((record) => [`${record.pk}|${record.sk}`, record]));
  let eventSequence = 0;
  const event = (eventType: string): EmailPersistenceEvent => ({
    eventId: `01ARZ3NDEKTSV4RRFFQ69G5F${String(++eventSequence).padStart(2, "0")}` as Ulid,
    eventType,
    occurredAt: NOW,
  });
  const conflict = () =>
    new DatabaseError({
      cause: "ConditionalCheckFailedException",
      message: "Write conflict",
      operation: "transact-write",
      table: "control",
      reason: "conflict",
    });
  const service: DynamoDatabaseService = {
    getRecord: (_table, key) => Promise.resolve(records.get(`${key.pk}|${key.sk}`)),
    putRecord: () => Promise.reject("Use transactions"),
    deleteRecord: () => Promise.reject("Use transactions"),
    queryRecords: (_table, query) =>
      (async () => {
        const indexed = query.IndexName === "gsi1";
        const pk = indexed ? "gsi1pk" : "pk";
        const sk = indexed ? "gsi1sk" : "sk";
        const values = query.ExpressionAttributeValues!;
        const matches = [...records.values()].filter(
          (record) => record[pk] === values[":pk"] && record[sk]?.startsWith(values[":sk"]),
        );
        matches.sort((a, b) => a.sk.localeCompare(b.sk));
        const after = query.ExclusiveStartKey?.sk;
        const remaining = after ? matches.filter((record) => record.sk > after) : matches;
        const items = remaining.slice(0, query.Limit);
        const last = items.at(-1);
        return {
          items,
          ...(last && remaining.length > items.length
            ? {
                lastEvaluatedKey: {
                  pk: last.pk,
                  sk: last.sk,
                  ...(indexed ? { gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk } : {}),
                },
              }
            : {}),
        };
      })(),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      try {
        for (const operation of operations) {
          if (operation.kind === "condition-check") continue;
          const existing = records.get(`${operation.record.pk}|${operation.record.sk}`);
          if (
            operation.kind === "delete" &&
            operation.record.itemType === "unique-claim" &&
            (existing?.itemType !== "unique-claim" ||
              existing.data.ownerId !== operation.record.data.ownerId ||
              existing.data.ownerPk !== operation.record.data.ownerPk ||
              existing.data.ownerSk !== operation.record.data.ownerSk ||
              existing.data.ownerItemType !== operation.record.data.ownerItemType)
          )
            throw conflict();
          if (operation.kind === "put" && !operation.previousRecord && existing) throw conflict();
          if (
            operation.kind === "put" &&
            operation.previousRecord &&
            (!existing ||
              !("version" in existing.data) ||
              !("version" in operation.previousRecord.data) ||
              existing.data.version !== operation.previousRecord.data.version)
          )
            throw conflict();
        }
        for (const operation of operations) {
          if (operation.kind === "condition-check") continue;
          const identity = `${operation.record.pk}|${operation.record.sk}`;
          if (operation.kind === "delete") records.delete(identity);
          else records.set(identity, operation.record);
        }
      } catch (cause) {
        throw cause instanceof DatabaseError ? cause : conflict();
      }
    },
  };
  return { service, records, event, repository: makeEmailPersistence(service, scope) };
}

describe("generic email persistence", () => {
  it("isolates reads, name lookups, writes, and pagination by the entire scope", async () => {
    const state = fixture();
    const created = await state.repository.createTenant(
      tenant(),
      state.event("email.tenant-created"),
    );
    await state.repository.createTenant(tenant(OTHER), state.event("email.tenant-created"));
    await state.repository.createDomain(domain(), state.event("email.domain-created"));
    const page = await state.repository.listTenants({ limit: 1 });
    expect(page.items.map((item) => item.data.id)).toEqual([TENANT]);
    expect(
      (await state.repository.listTenants({ cursor: page.nextCursor, limit: 1 })).items.map(
        (item) => item.data.id,
      ),
    ).toEqual([OTHER]);
    for (const otherScope of [
      { ...scope, environmentId: OTHER },
      { ...scope, projectId: OTHER },
      { ...scope, organizationId: OTHER },
    ]) {
      const other = makeEmailPersistence(state.service, otherScope);
      expect(await other.getTenant(TENANT)).toBeUndefined();
      expect(await other.getDomain(DOMAIN)).toBeUndefined();
      expect(await other.findDomainByName("MAIL.EXAMPLE.COM.")).toBeUndefined();
      expect((await other.listTenants()).items).toEqual([]);
      expect(other.listTenants({ cursor: page.nextCursor })).rejects.toMatchObject({
        reason: "validation",
      });
      expect(
        other.updateTenant(created, state.event("email.tenant-updated")),
      ).rejects.toMatchObject({ reason: "validation" });
    }
  });

  it("rejects stale updates without overwriting state or appending an event", async () => {
    const state = fixture();
    const created = await state.repository.createTenant(
      tenant(),
      state.event("email.tenant-created"),
    );
    await state.repository.updateTenant(
      { ...created, data: { ...created.data, status: "paused" } },
      state.event("email.tenant-updated"),
    );
    expect(
      state.repository.updateTenant(
        { ...created, data: { ...created.data, name: "Stale name" } },
        state.event("email.tenant-updated"),
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await state.repository.getTenant(TENANT))?.data).toMatchObject({
      version: 2,
      status: "paused",
      name: "Transactional email",
    });
    const events = [...state.records.values()].filter(
      (record) => record.itemType === "semantic-event",
    );
    expect(events.map((record) => record.data.aggregateVersion)).toEqual([1, 2]);
  });

  it("does not let an unverified registration block another scope's proven ownership", async () => {
    const state = fixture();
    await state.repository.createTenant(tenant(), state.event("email.tenant-created"));
    const pending = await state.repository.createDomain(
      domain(),
      state.event("email.domain-created"),
    );
    expect(await state.repository.findDomainByName("mail.example.com")).toBeUndefined();
    const otherScope = { ...scope, environmentId: OTHER };
    const other = makeEmailPersistence(state.service, otherScope);
    await other.createTenant(tenant(OTHER, otherScope), state.event("email.tenant-created"));
    const otherInput = domain(OTHER, otherScope);
    const otherPending = await other.createDomain(
      { ...otherInput, data: { ...otherInput.data, tenantId: OTHER } },
      state.event("email.domain-created"),
    );
    await other.updateDomain(
      { ...otherPending, data: { ...otherPending.data, status: "verified", verifiedAt: NOW } },
      state.event("email.domain-updated"),
    );
    expect((await other.findDomainByName("mail.example.com"))?.data.id).toBe(OTHER);
    expect(
      state.repository.updateDomain(
        { ...pending, data: { ...pending.data, status: "verified", verifiedAt: NOW } },
        state.event("email.domain-updated"),
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await state.repository.getDomain(DOMAIN))?.data.status).toBe("pending");
  });

  it("holds verified ownership during failed cleanup and permits re-registration after completed cleanup", async () => {
    const state = fixture();
    await state.repository.createTenant(tenant(), state.event("email.tenant-created"));
    const pending = await state.repository.createDomain(
      domain(),
      state.event("email.domain-created"),
    );
    const verified = (await state.repository.updateDomain(
      { ...pending, data: { ...pending.data, status: "verified", verifiedAt: NOW } },
      state.event("email.domain-updated"),
    ))!;
    const revoked = (await state.repository.updateDomain(
      { ...verified, data: { ...verified.data, status: "revoked" } },
      state.event("email.domain-updated"),
    ))!;
    const otherScope = { ...scope, environmentId: OTHER };
    const other = makeEmailPersistence(state.service, otherScope);
    await other.createTenant(tenant(OTHER, otherScope), state.event("email.tenant-created"));
    const otherInput = domain(OTHER, otherScope);
    const otherPending = await other.createDomain(
      { ...otherInput, data: { ...otherInput.data, tenantId: OTHER } },
      state.event("email.domain-created"),
    );
    const otherVerified = {
      ...otherPending,
      data: { ...otherPending.data, status: "verified" as const, verifiedAt: NOW },
    };
    expect(
      other.updateDomain(otherVerified, state.event("email.domain-updated")),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await state.repository.findDomainByName("mail.example.com"))?.data.status).toBe(
      "revoked",
    );
    await state.repository.completeDomainRevocation(revoked, state.event("email.domain-updated"));
    expect(await state.repository.findDomainByName("mail.example.com")).toBeUndefined();
    await other.updateDomain(otherVerified, state.event("email.domain-updated"));
    expect((await other.findDomainByName("mail.example.com"))?.data.id).toBe(OTHER);
    const completed = (await state.repository.getDomain(DOMAIN))!;
    await state.repository.completeDomainRevocation(completed, state.event("email.domain-updated"));
    expect((await other.findDomainByName("mail.example.com"))?.data.id).toBe(OTHER);
    expect(
      state.repository.updateDomain(
        { ...completed, data: { ...completed.data, status: "verified" } },
        state.event("email.domain-updated"),
      ),
    ).rejects.toMatchObject({ reason: "validation" });
  });

  it("cannot claim a domain already owned by an inbox", async () => {
    const inboxDomain = withCanonicalRecordKeys({
      itemType: "inbox-domain" as const,
      data: {
        ...scope,
        id: OTHER,
        domain: "mail.example.com",
        createdAt: NOW,
        updatedAt: NOW,
        version: 1,
        status: "verified" as const,
        verifiedAt: NOW,
        dnsRecords: [],
        mailFromDomain: "bounce.mail.example.com",
        providerManaged: false,
        providerMetadata: {},
      },
    });
    const claim = uniqueClaimRequirements(inboxDomain).find(
      (requirement) => requirement.namespace === "inbox-domain",
    )!;
    const state = fixture([
      inboxDomain,
      Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(claim, NOW)),
    ]);
    await state.repository.createTenant(tenant(), state.event("email.tenant-created"));
    const pending = await state.repository.createDomain(
      domain(),
      state.event("email.domain-created"),
    );
    expect(
      state.repository.updateDomain(
        { ...pending, data: { ...pending.data, status: "verified", verifiedAt: NOW } },
        state.event("email.domain-updated"),
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await state.repository.getDomain(DOMAIN))?.data.status).toBe("pending");
    expect(await state.repository.findDomainByName("mail.example.com")).toBeUndefined();
  });

  it("paginates domains inside one tenant without filtering away another tenant's rows", async () => {
    const state = fixture();
    await state.repository.createTenant(tenant(), state.event("email.tenant-created"));
    await state.repository.createTenant(tenant(OTHER), state.event("email.tenant-created"));
    await state.repository.createDomain(domain(), state.event("email.domain-created"));
    const second = domain(OTHER);
    await state.repository.createDomain(
      { ...second, data: { ...second.data, domain: "second.example.com" } },
      state.event("email.domain-created"),
    );
    const foreign = domain(ENV);
    await state.repository.createDomain(
      { ...foreign, data: { ...foreign.data, tenantId: OTHER, domain: "other.example.com" } },
      state.event("email.domain-created"),
    );
    const first = await state.repository.listDomains(TENANT, { limit: 1 });
    expect(first.items.map((item) => item.data.id)).toEqual([DOMAIN]);
    const secondPage = await state.repository.listDomains(TENANT, {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(secondPage.items.map((item) => item.data.id)).toEqual([OTHER]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(state.repository.listDomains(OTHER, { cursor: first.nextCursor })).rejects.toMatchObject(
      { reason: "validation" },
    );
  });
});
