import { Schema } from "effect";
import { canonicalJson, sha256Hex } from "./canonical-hash.ts";
import { CaseExpectations, EvaluationCaseMaterial } from "./config.ts";

export const CASE_MATERIAL_CONTENT_TYPE = "application/json";
const INPUT_PREVIEW_LENGTH = 200;

/** Expectation keys that map to built-in evaluators; other keys become opaque constraints. */
const EVALUATOR_EXPECTATION_KEYS = [
  "jsonSchema",
  "matches",
  "mustInclude",
  "mustNot",
  "mustNotUseTools",
  "mustUseTools",
] as const;

export interface PreparedCaseMaterial {
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly expectationKinds: readonly (keyof CaseExpectations)[];
  readonly inputPreview: string;
  readonly material: EvaluationCaseMaterial;
}

/** Canonical, content-addressed case material: identical cases hash identically. */
export function prepareCaseMaterial(input: {
  readonly content: string;
  readonly expectations: CaseExpectations;
}): PreparedCaseMaterial {
  const material = Schema.decodeUnknownSync(EvaluationCaseMaterial)({
    expectations: input.expectations,
    input: { content: input.content },
    schemaVersion: 1,
  });
  const json = canonicalJson(material);
  const normalizedPreview = material.input.content.replaceAll(/\s+/gu, " ").trim();
  return {
    bytes: new TextEncoder().encode(json),
    contentSha256: sha256Hex(json),
    expectationKinds: (Object.keys(material.expectations) as (keyof CaseExpectations)[]).sort(),
    inputPreview:
      normalizedPreview.length > INPUT_PREVIEW_LENGTH
        ? `${normalizedPreview.slice(0, INPUT_PREVIEW_LENGTH - 1)}…`
        : normalizedPreview || material.input.content.slice(0, INPUT_PREVIEW_LENGTH),
    material,
  };
}

/** Decodes stored case material and verifies it matches its recorded content hash. */
export function parseCaseMaterial(
  bytes: Uint8Array,
  expectedSha256: string,
): EvaluationCaseMaterial {
  const json = new TextDecoder().decode(bytes);
  if (sha256Hex(json) !== expectedSha256) {
    throw new Error("Dataset case material does not match its content hash.");
  }
  return Schema.decodeUnknownSync(EvaluationCaseMaterial)(JSON.parse(json));
}

export function caseMaterialObjectKey(
  organizationId: string,
  datasetId: string,
  contentSha256: string,
) {
  return `organizations/${organizationId}/evaluation-cases/${datasetId}/${contentSha256}.json`;
}

export function comparisonReportObjectKey(
  organizationId: string,
  releaseComparisonId: string,
  format: "json" | "md",
) {
  return `organizations/${organizationId}/evaluation-reports/${releaseComparisonId}/report.${format}`;
}

/**
 * Maps a case-file `expected` object onto case expectations. Known evaluator keys are validated
 * as expectations; every other key (and any extra top-level case field) is preserved as an
 * opaque expected constraint that scorers never interpret.
 */
export function expectationsFromCaseFile(
  expected: Readonly<Record<string, unknown>> | undefined,
  extraFields: Readonly<Record<string, unknown>> = {},
): CaseExpectations {
  const known: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = { ...extraFields };
  for (const [key, value] of Object.entries(expected ?? {})) {
    if ((EVALUATOR_EXPECTATION_KEYS as readonly string[]).includes(key)) known[key] = value;
    else constraints[key] = value;
  }
  return Schema.decodeUnknownSync(CaseExpectations)({
    ...known,
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
  });
}
