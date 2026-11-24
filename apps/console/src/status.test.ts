import { describe, expect, test } from "bun:test";
import { PUBLIC_API_SCHEMAS } from "@deployments-ai/api-contract";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import type { PublicApiRouteContract } from "@deployments-ai/api-contract/route-contract";
import * as SchemaAST from "effect/SchemaAST";
import {
  GRANT_STATUSES,
  MEMORY_REVIEW_STATUSES,
  MEMORY_STATUSES,
  REVIEW_ITEM_STATUSES,
  SPACE_STATUSES,
} from "./memory/model.ts";
import { ENVIRONMENT_TYPE_COLORS, STATUS_COLORS, statusColor, statusLabel } from "./status.ts";

const BADGED_TAGS: ReadonlySet<PublicApiRouteContract["tag"]> = new Set([
  "Agent Email",
  "Brains",
  "Email",
  "Extensions",
  "Governance",
  "Managed Skills",
  "Models",
  "Providers",
  "Security",
  "Tools",
  "Workflows",
]);

const STATUS_KEY = /^(status|change)$|Status$/;

function collectStatuses(
  ast: SchemaAST.AST,
  key: string | undefined,
  found: Set<string>,
  visited: Set<SchemaAST.Suspend>,
) {
  if (SchemaAST.isLiteral(ast)) {
    if (key !== undefined && STATUS_KEY.test(key) && typeof ast.literal === "string") {
      found.add(ast.literal);
    }
  } else if (SchemaAST.isObjects(ast)) {
    for (const property of ast.propertySignatures) {
      collectStatuses(property.type, String(property.name), found, visited);
    }
  } else if (SchemaAST.isUnion(ast)) {
    for (const member of ast.types) collectStatuses(member, key, found, visited);
  } else if (SchemaAST.isArrays(ast)) {
    for (const element of [...ast.elements, ...ast.rest])
      collectStatuses(element, undefined, found, visited);
  } else if (SchemaAST.isSuspend(ast)) {
    if (visited.has(ast)) return;
    visited.add(ast);
    collectStatuses(ast.thunk(), key, found, visited);
  } else if (SchemaAST.isDeclaration(ast)) {
    for (const parameter of ast.typeParameters) collectStatuses(parameter, key, found, visited);
  }
}

describe("statusColor", () => {
  test("gives every status a badged contract area returns a deliberate color", () => {
    const routes: readonly PublicApiRouteContract[] = PUBLIC_API_ROUTES;
    const schemas: Readonly<Record<string, { readonly ast: SchemaAST.AST }>> = PUBLIC_API_SCHEMAS;
    const statuses = new Set<string>();
    for (const route of routes) {
      const schema = schemas[route.responseBody];
      if (BADGED_TAGS.has(route.tag) && schema !== undefined) {
        collectStatuses(schema.ast, undefined, statuses, new Set());
      }
    }
    expect(statuses.size).toBeGreaterThan(30);
    expect([...statuses].filter((status) => !Object.hasOwn(STATUS_COLORS, status))).toEqual([]);
  });

  test("gives every Memory status a deliberate color, since its contract publishes none", () => {
    expect(
      [
        ...SPACE_STATUSES,
        ...GRANT_STATUSES,
        ...MEMORY_STATUSES,
        ...MEMORY_REVIEW_STATUSES,
        ...REVIEW_ITEM_STATUSES,
      ].filter((status) => !Object.hasOwn(STATUS_COLORS, status)),
    ).toEqual([]);
  });

  test("colors wave 3 statuses by what they ask of the reader", () => {
    expect(
      ["pending_dns", "pending_approval", "bounced", "suspended", "sent", "scheduled", "draft"].map(
        statusColor,
      ),
    ).toEqual(["amber", "amber", "red", "red", "green", "blue", "zinc"]);
  });

  test("colors wave 4 statuses by what they ask of the reader", () => {
    expect(
      [
        "waiting-for-approval",
        "canceling",
        "open",
        "resolved",
        "erasing",
        "suppressed",
        "deleted",
        "a-status-nobody-declared",
        "waiting-for-a-new-reason",
      ].map(statusColor),
    ).toEqual(["amber", "blue", "amber", "green", "blue", "zinc", "zinc", "zinc", "amber"]);
  });

  test("labels API values as words, keeping acronyms and fixing grammar", () => {
    expect(
      [
        "reauthorization-required",
        "waiting-for-agent",
        "timed_out",
        "pending_dns",
        "ok",
        "require_approval",
      ].map(statusLabel),
    ).toEqual([
      "Reauthorization required",
      "Waiting for agent",
      "Timed out",
      "Pending DNS",
      "OK",
      "Requires approval",
    ]);
  });

  test("keeps red for failures, not for deliberate actions or the production environment", () => {
    expect(["revoked", "failed"].map(statusColor)).toEqual(["zinc", "red"]);
    expect(Object.values(ENVIRONMENT_TYPE_COLORS)).not.toContain("red");
  });

  test("colors custom domain states by what they ask of the reader", () => {
    expect(["unverified", "verified", "active"].map(statusColor)).toEqual([
      "amber",
      "green",
      "green",
    ]);
  });
});
