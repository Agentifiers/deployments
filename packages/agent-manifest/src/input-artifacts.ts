import { Schema } from "effect";

export const INPUT_ARTIFACT_TYPE = "input";
export const MAX_INPUT_ARTIFACTS = 8;
export const MAX_INPUT_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_INPUT_MEDIA_BYTES = 20 * 1024 * 1024;

export const AgentInputArtifacts = Schema.Array(
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((value) =>
        /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value)
          ? undefined
          : "Input artifact IDs must be canonical ULIDs.",
      ),
    ),
  ),
).pipe(
  Schema.check(
    Schema.makeFilter<readonly string[]>((values) =>
      values.length > 0 &&
      values.length <= MAX_INPUT_ARTIFACTS &&
      new Set(values).size === values.length
        ? undefined
        : "Input artifacts must contain one to eight unique artifact IDs.",
    ),
  ),
);
