import { describe, expect, test } from "bun:test";
import { ExtensionToolResponse } from "@deployments-ai/api-contract/tooling";
import { Schema } from "effect";
import type { ExtensionTool } from "../extensions/extension-draft.ts";
import { extensionDetail } from "./extension-data.ts";
import { extensionSummary } from "./tool-directory.ts";

function tool(id: string, name: string, status = "active"): ExtensionTool {
  return Schema.decodeUnknownSync(ExtensionToolResponse)({
    createdAt: "2026-10-07T00:00:00.000Z",
    defaultPolicyAction: "allow",
    description: "Looks up an order.",
    effect: "read",
    execution: { timeoutMs: 30_000, type: "client" },
    hasCallbackAuth: false,
    id,
    inputSchema: { type: "object" },
    name,
    outputSchema: { type: "object" },
    requiredScopes: [],
    status,
    updatedAt: "2026-10-07T00:00:00.000Z",
    version: 3,
  });
}

const LISTED = tool("01K0000000000000000000000D", "orders.lookup");
const ARCHIVED = tool("01K0000000000000000000000E", "orders.old", "archived");
const BEYOND = tool("01K0000000000000000000000F", "orders.refund");

function reader(...tools: readonly ExtensionTool[]) {
  const reads: string[] = [];
  return {
    read: (name: string) => {
      reads.push(name);
      return Promise.resolve(tools.find((candidate) => candidate.name === name));
    },
    reads,
  };
}

const directory = (complete: boolean) => ({
  complete,
  extensions: [extensionSummary(LISTED), extensionSummary(ARCHIVED)],
});

describe("extensionDetail", () => {
  test("a listed active extension reads its tool by name", async () => {
    const tools = reader(LISTED);
    expect(await extensionDetail(directory(true), { extensionId: LISTED.id }, tools.read)).toEqual({
      kind: "found",
      summary: extensionSummary(LISTED),
      tool: LISTED,
    });
    expect(tools.reads).toEqual(["orders.lookup"]);
  });

  test("a listed archived extension shows its summary without a read", async () => {
    const tools = reader();
    expect(
      await extensionDetail(directory(false), { extensionId: ARCHIVED.id }, tools.read),
    ).toEqual({ kind: "found", summary: extensionSummary(ARCHIVED) });
    expect(tools.reads).toEqual([]);
  });

  test("a miss resolves through the tool's name, because the directory index lags a create", async () => {
    const results = await Promise.all(
      [true, false].map((complete) =>
        extensionDetail(
          directory(complete),
          { extensionId: BEYOND.id, name: BEYOND.name },
          reader(BEYOND).read,
        ),
      ),
    );
    const found = { kind: "found" as const, summary: extensionSummary(BEYOND), tool: BEYOND };
    expect(results).toEqual([found, found]);
  });

  test("a complete miss without a matching name is missing, not a failed load", async () => {
    const reused = tool("01K0000000000000000000000G", BEYOND.name);
    const results = await Promise.all([
      extensionDetail(directory(true), { extensionId: BEYOND.id }, reader(BEYOND).read),
      extensionDetail(
        directory(true),
        { extensionId: BEYOND.id, name: BEYOND.name },
        reader(reused).read,
      ),
    ]);
    expect(results).toEqual([{ kind: "missing" }, { kind: "missing" }]);
  });

  test("a capped miss without a matching name is unlisted, not absent", async () => {
    const reused = tool("01K0000000000000000000000G", BEYOND.name);
    const results = await Promise.all([
      extensionDetail(directory(false), { extensionId: BEYOND.id }, reader(BEYOND).read),
      extensionDetail(
        directory(false),
        { extensionId: BEYOND.id, name: BEYOND.name },
        reader(reused).read,
      ),
      extensionDetail(
        directory(false),
        { extensionId: BEYOND.id, name: BEYOND.name },
        reader().read,
      ),
    ]);
    expect(results).toEqual([
      { cappedAt: 2, kind: "unlisted" },
      { cappedAt: 2, kind: "unlisted" },
      { cappedAt: 2, kind: "unlisted" },
    ]);
  });
});
