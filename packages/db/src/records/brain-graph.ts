import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonEmptyString,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { BrainReviewStatus } from "./brains.ts";

export const BrainEntityRecord = makeRecordSchema("brain-entity", {
  ...mutableResourceFields,
  brainId: Ulid,
  canonicalName: NonEmptyString,
  externalIdentifiers: Metadata,
  id: Ulid,
  kind: Schema.Literals(["company", "concept", "person", "project"]),
  mergedIntoEntityId: Schema.optional(Ulid),
  normalizedAliases: Schema.Array(NonEmptyString),
  organizationId: Ulid,
  reviewStatus: BrainReviewStatus,
  status: Schema.Literals(["active", "archived", "merged"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const aliases = record.data.normalizedAliases;
      if (aliases.length === 0 || new Set(aliases).size !== aliases.length) {
        return "Brain entities require at least one unique normalized alias.";
      }
      return (record.data.status === "merged") === (record.data.mergedIntoEntityId !== undefined)
        ? undefined
        : "Merged Brain entities require one replacement and other entities forbid it.";
    }),
  ),
);

const BrainGraphEndpoint = Schema.Struct({
  id: Ulid,
  kind: Schema.Literals(["document", "entity"]),
});

export const BrainEdgeRecord = makeRecordSchema("brain-edge", {
  ...mutableResourceFields,
  brainId: Ulid,
  confidence: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ),
  documentVersionId: Ulid,
  evidence: Metadata,
  extractionMethod: Schema.Literals(["deterministic", "model", "trusted-hint"]),
  from: BrainGraphEndpoint,
  id: Ulid,
  lifecycle: Schema.Literals(["active", "archived", "deleted"]),
  organizationId: Ulid,
  renditionId: Ulid,
  reviewStatus: BrainReviewStatus,
  relation: NonEmptyString,
  to: BrainGraphEndpoint,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) =>
      record.data.from.kind === record.data.to.kind && record.data.from.id === record.data.to.id
        ? "Brain edges cannot connect an endpoint to itself."
        : undefined,
    ),
  ),
);
