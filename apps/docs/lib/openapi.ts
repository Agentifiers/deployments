import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Document, OperationItem } from "fumadocs-openapi";

let publicDocument: Document | undefined;

function isDocument(value: unknown): value is Document {
  return (
    typeof value === "object" &&
    value !== null &&
    "openapi" in value &&
    "paths" in value &&
    typeof value.paths === "object" &&
    value.paths !== null
  );
}

function loadPublicDocument(): Document {
  if (publicDocument) return publicDocument;
  const path = join(process.cwd(), "generated", "openapi.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isDocument(parsed)) throw new Error(`${path} is not an OpenAPI document.`);
  publicDocument = parsed;
  return parsed;
}

function schemaReferences(node: unknown, into: Set<string>) {
  if (Array.isArray(node)) {
    for (const item of node) schemaReferences(item, into);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/components/schemas/")) {
      into.add(value.slice("#/components/schemas/".length));
    } else {
      schemaReferences(value, into);
    }
  }
}

export function operationDocument(operations: readonly OperationItem[]): Document {
  const document = loadPublicDocument();
  const paths: NonNullable<Document["paths"]> = {};
  for (const { path, method } of operations) {
    const pathItem = document.paths?.[path];
    const operation = pathItem?.[method];
    if (!operation) throw new Error(`The public document has no ${method.toUpperCase()} ${path}.`);
    paths[path] = { ...paths[path], [method]: operation };
  }
  const allSchemas = document.components?.schemas ?? {};
  const reachable = new Set<string>();
  schemaReferences(paths, reachable);
  for (const name of reachable) schemaReferences(allSchemas[name], reachable);
  return {
    ...document,
    paths,
    components: {
      ...document.components,
      schemas: Object.fromEntries(
        Object.entries(allSchemas).filter(([name]) => reachable.has(name)),
      ),
    },
  };
}
