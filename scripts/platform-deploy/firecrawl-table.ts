import { Schema } from "effect";
import type { ImageDeploymentMetadata } from "./image-metadata.ts";

const Name = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,255}$/u)));
const KeyNames = { hash_key: Name, range_key: Schema.optionalKey(Name) };

/**
 * Version 1 of the Firecrawl fork's `dynamodb-table.json`, which its image ships
 * at /app/dynamodb-table.json. Field names follow the `aws_dynamodb_table`
 * arguments; `modules/web-tools-runtime` renders the table from it.
 */
export const FirecrawlTableDefinition = Schema.Struct({
  version: Schema.Literal(1),
  billing_mode: Schema.Literal("PAY_PER_REQUEST"),
  ...KeyNames,
  attributes: Schema.Array(
    Schema.Struct({ name: Name, type: Schema.Literals(["S", "N", "B"]) }),
  ).pipe(Schema.check(Schema.isMinLength(1))),
  ttl_attribute: Name,
  global_secondary_indexes: Schema.Array(
    Schema.Struct({
      name: Name,
      ...KeyNames,
      projection_type: Schema.Literals(["ALL", "KEYS_ONLY", "INCLUDE"]),
      non_key_attributes: Schema.optionalKey(Schema.Array(Name)),
    }).pipe(
      Schema.check(
        Schema.makeFilter((index) =>
          (index.projection_type === "INCLUDE") === (index.non_key_attributes?.length ?? 0) > 0
            ? undefined
            : `index ${index.name} must list non_key_attributes exactly when its projection is INCLUDE.`,
        ),
      ),
    ),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((table) => {
      const declared = table.attributes.map((attribute) => attribute.name).toSorted();
      const keys = [table, ...table.global_secondary_indexes]
        .flatMap((keyed) => [keyed.hash_key, keyed.range_key ?? []])
        .flat();
      const used = [...new Set(keys)].toSorted();
      return declared.join(",") === used.join(",") && new Set(declared).size === declared.length
        ? undefined
        : `attributes (${declared.join(", ")}) must declare each table and index key exactly once (${used.join(", ")}).`;
    }),
  ),
);

export const firecrawlTableMetadata: ImageDeploymentMetadata = {
  decode: Schema.decodeUnknownSync(FirecrawlTableDefinition, { onExcessProperty: "error" }),
  file: "dynamodb-table.json",
  stage: "dynamodb-table",
  terraformVariable: "web_tools_firecrawl_table",
};
