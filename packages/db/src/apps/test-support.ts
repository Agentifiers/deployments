import { Schema } from "effect";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import { makeIdGenerator, Ulid } from "../ids.ts";
import { AppSlug, type AppRecord } from "../records/apps.ts";
import { makeAppPersistence, type CreateAppInput } from "./persistence.ts";

export const id = Schema.decodeUnknownSync(Ulid);
export const slug = Schema.decodeUnknownSync(AppSlug);

export const ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FA0");
export const OTHER_ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FA1");
export const PROJECT = id("01ARZ3NDEKTSV4RRFFQ69G5FA2");
export const ENVIRONMENT = id("01ARZ3NDEKTSV4RRFFQ69G5FA3");
export const WORKSPACE = id("01ARZ3NDEKTSV4RRFFQ69G5FA4");
export const AGENT = id("01ARZ3NDEKTSV4RRFFQ69G5FA5");
export const RUN = id("01ARZ3NDEKTSV4RRFFQ69G5FA6");
export const MEMBER = id("01ARZ3NDEKTSV4RRFFQ69G5FA7");
export const ADMIN = id("01ARZ3NDEKTSV4RRFFQ69G5FA8");
export const START = "2026-10-08T12:00:00.000Z";
export const BUNDLE_SHA256 = "a".repeat(64);

export function appHarness() {
  let clock = Date.parse(START);
  const memory = evaluationMemoryDatabase();
  const apps = makeAppPersistence({
    database: memory.database,
    generateId: makeIdGenerator().generate,
    now: () => new Date(clock),
  });

  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    apps,
    appInput: (overrides: Partial<CreateAppInput> = {}): CreateAppInput => {
      return {
        actor: { id: RUN, type: "agent" },
        agentDefinitionId: AGENT,
        clusterKey: "default",
        createdBy: { principalId: null, runId: RUN },
        databaseLayout: 1,
        environmentId: ENVIRONMENT,
        name: "Payroll",
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        slug: slug("payroll"),
        workspaceId: WORKSPACE,
        ...overrides,
      };
    },
    eventTypes: (app: AppRecord) => {
      return memory
        .all()
        .flatMap((record) =>
          record.itemType === "semantic-event" && record.data.aggregateId === app.data.id
            ? [record.data]
            : [],
        )
        .sort((left, right) => left.aggregateVersion - right.aggregateVersion)
        .map((event) => event.eventType);
    },
    eraseOrganization: (organizationId: Ulid) => {
      const storeKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
      for (const record of memory.all()) {
        if (
          record.itemType !== "governance-tenant-record" ||
          record.data.organizationId !== organizationId
        ) {
          continue;
        }
        memory.records.delete(
          storeKey(record.data.recordTable, record.data.recordPk, record.data.recordSk),
        );
        memory.records.delete(storeKey("control", record.pk, record.sk));
      }
    },
    memory,
  };
}
