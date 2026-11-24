import {
  DatabaseError,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeAdministrationPersistence,
  type AdministrationInvocation,
  type AdministrationPersistenceDependencies,
} from "./administration-persistence.ts";
import type { HostedCodeArtifactObjectInput } from "./hosted-code-artifact-administration.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const TYPESCRIPT_TOOL = `interface LookupInput {
  readonly orderId: string;
  readonly quantity?: number;
}

type LookupOutput = { readonly orderId: string; readonly total: number };

const unitPrice: number = 250;

export async function handler(input: LookupInput): Promise<LookupOutput> {
  const quantity = input.quantity ?? 1;
  return { orderId: input.orderId, total: (quantity * unitPrice) satisfies number };
}
`;

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function memoryDatabase(): DynamoDatabaseService {
  const records = new Map<string, PlatformRecord>();
  const storageKey = (table: string, key: { readonly pk: string; readonly sk: string }) =>
    `${table}\u0000${key.pk}\u0000${key.sk}`;
  return {
    deleteRecord: async () => {
      throw new Error("hosted code artifacts are never deleted");
    },
    getRecord: async (table, key) => structuredClone(records.get(storageKey(table, key))),
    putRecord: async () => {
      throw new Error("hosted code artifacts are written transactionally");
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const key = storageKey(tableForItemType(operation.record.itemType), operation.record);
        if (!operation.previousRecord && !operation.allowExisting && records.has(key)) {
          throw new DatabaseError({
            cause: new Error("exists"),
            message: "Conditional write failed.",
            operation: "create",
            reason: "conflict",
            table: "control",
          });
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") {
          records.set(
            storageKey(tableForItemType(operation.record.itemType), operation.record),
            structuredClone(operation.record),
          );
        }
      }
    },
  };
}

function fixture() {
  const puts: HostedCodeArtifactObjectInput[] = [];
  const dependencies = {
    database: memoryDatabase(),
    generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FB0",
    hostedCodeArtifacts: {
      put: async (input: HostedCodeArtifactObjectInput) => {
        puts.push(input);
        return { bucket: "platform-artifacts", versionId: `object-version-${puts.length}` };
      },
    },
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    resolveEnvironment: async () => ({
      id: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      status: "active",
    }),
  } as unknown as AdministrationPersistenceDependencies;
  const service = makeAdministrationPersistence(dependencies);
  const invocation = (body: unknown, params: Record<string, string> = {}) =>
    ({
      body,
      identity: {
        environmentIds: [ENVIRONMENT_ID],
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        projectIds: [PROJECT_ID],
        scopes: ["tools:write"],
      },
      idempotencyKey: "hosted-code-upload",
      params,
      query: {},
      scope: { environmentId: ENVIRONMENT_ID },
    }) as AdministrationInvocation;
  const upload = async (language: string, source: string) =>
    (await service.invoke("createHostedCodeArtifact", invocation({ language, source }))) as Record<
      string,
      unknown
    >;
  const show = async (contentHash: string) =>
    (await service.invoke(
      "getHostedCodeArtifact",
      invocation(undefined, { contentHash }),
    )) as Record<string, unknown>;
  return { puts, show, upload };
}

async function importModule(bytes: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "hosted-code-upload-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "tool.mjs");
  writeFileSync(path, bytes);
  // The compiled artifact only exists at a temporary path chosen at run time.
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

describe("hosted code artifact upload", () => {
  test("compiles TypeScript once at upload into runnable ES module JavaScript", async () => {
    const { puts, upload } = fixture();

    const artifact = await upload("typescript", TYPESCRIPT_TOOL);

    expect(puts).toHaveLength(1);
    const stored = puts[0]!;
    const hex = createHash("sha256").update(stored.bytes).digest("hex");
    expect(artifact).toEqual({
      byteSize: stored.bytes.byteLength,
      contentHash: `sha256:${hex}`,
      createdAt: "2026-07-26T12:00:00.000Z",
      language: "javascript",
      sourceByteSize: new TextEncoder().encode(TYPESCRIPT_TOOL).byteLength,
      sourceContentHash: `sha256:${createHash("sha256").update(TYPESCRIPT_TOOL).digest("hex")}`,
      sourceLanguage: "typescript",
    });
    expect(stored.key).toBe(
      `organizations/${ORGANIZATION_ID}/hosted-code-artifacts/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/${hex}.mjs`,
    );
    const compiled = new TextDecoder().decode(stored.bytes);
    expect(compiled).not.toContain("interface LookupInput");
    expect(compiled).not.toContain("satisfies");
    const loaded = await importModule(stored.bytes);
    const handler = loaded.handler as (input: unknown) => Promise<unknown>;
    expect(handler({ orderId: "ord_1", quantity: 3 })).resolves.toEqual({
      orderId: "ord_1",
      total: 750,
    });
  });

  test("re-uploading identical source returns the existing immutable artifact", async () => {
    const { puts, show, upload } = fixture();

    const first = await upload("typescript", TYPESCRIPT_TOOL);
    const second = await upload("typescript", TYPESCRIPT_TOOL);

    expect(second).toEqual(first);
    expect(puts).toHaveLength(1);
    expect(show(String(first.contentHash))).resolves.toEqual(first);
  });

  test("stores JavaScript and Python as uploaded, keyed by their runtime extension", async () => {
    const { puts, upload } = fixture();
    const javascript = "export const handler = (input) => ({ echo: input });\n";
    const python = "def handler(payload):\n    return {'echo': payload}\n";

    expect(upload("javascript", javascript)).resolves.toMatchObject({
      language: "javascript",
      sourceLanguage: "javascript",
    });
    expect(upload("python", python)).resolves.toMatchObject({
      language: "python",
      sourceLanguage: "python",
    });

    expect(new TextDecoder().decode(puts[0]!.bytes)).toBe(javascript);
    expect(puts[0]!.key.endsWith(".mjs")).toBe(true);
    expect(new TextDecoder().decode(puts[1]!.bytes)).toBe(python);
    expect(puts[1]!.key.endsWith(".py")).toBe(true);
  });

  test.each([
    ["javascript", "export function handler( {"],
    ["typescript", "export function handler(input: ): string {"],
  ])("rejects %s that does not compile before storing anything", async (language, source) => {
    const { puts, upload } = fixture();

    expect(upload(language, source)).rejects.toMatchObject({
      code: "hosted_code_compile_failed",
      kind: "unprocessable",
    });
    expect(puts).toHaveLength(0);
  });
});
