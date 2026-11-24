import { Schema } from "effect";
import { Timestamp } from "./primitives.ts";

export const HOSTED_CODE_MAX_SOURCE_BYTES = 1024 * 1024;
export const HOSTED_CODE_DEFAULT_ENTRYPOINT = "handler";
export const HOSTED_CODE_DEFAULT_TIMEOUT_MS = 30_000;
export const HOSTED_CODE_MIN_TIMEOUT_MS = 100;
export const HOSTED_CODE_MAX_TIMEOUT_MS = 50_000;
export const HOSTED_CODE_DEFAULT_MEMORY_MIB = 256;
export const HOSTED_CODE_MIN_MEMORY_MIB = 128;
export const HOSTED_CODE_MAX_MEMORY_MIB = 2_048;
export const HOSTED_CODE_MAX_SECRETS = 16;
export const HOSTED_CODE_MAX_SECRET_VALUE_BYTES = 4_096;
export const HOSTED_CODE_CONTENT_HASH_PATTERN_SOURCE = "^sha256:[a-f0-9]{64}$";
export const HOSTED_CODE_SECRET_NAME_PATTERN_SOURCE = "^[A-Z][A-Z0-9_]{0,63}$";

/** Environment names the sandbox runtime owns; secrets can never shadow them. */
const RESERVED_SECRET_NAMES: Readonly<Record<string, true>> = {
  HOME: true,
  LANG: true,
  PATH: true,
  PWD: true,
  SHELL: true,
  TMPDIR: true,
  TZ: true,
  USER: true,
};
const RESERVED_SECRET_NAME_PREFIXES = [
  "AWS_",
  "DEPLOYMENTS_AI_",
  "LD_",
  "NODE_",
  "PYTHON",
] as const;

export function isReservedHostedCodeSecretName(name: string) {
  return (
    Object.hasOwn(RESERVED_SECRET_NAMES, name) ||
    RESERVED_SECRET_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const integerBetween = (minimum: number, maximum: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum, maximum })));

export const HostedCodeContentHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(HOSTED_CODE_CONTENT_HASH_PATTERN_SOURCE, "u"))),
);
export const HostedCodeSourceLanguage = Schema.Literals(["javascript", "python", "typescript"]);
export const HostedCodeRuntimeLanguage = Schema.Literals(["javascript", "python"]);
export const HostedCodeNetworkMode = Schema.Literals(["none", "sandbox"]);
const HostedCodeEntrypoint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u)),
);
const HostedCodeSecretName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(new RegExp(HOSTED_CODE_SECRET_NAME_PATTERN_SOURCE, "u")),
    Schema.makeFilter<string>((name) =>
      isReservedHostedCodeSecretName(name)
        ? `Secret name ${name} is reserved by the sandbox runtime.`
        : undefined,
    ),
  ),
);
const HostedCodeSecretValue = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.makeFilter<string>((value) =>
      utf8Bytes(value) > HOSTED_CODE_MAX_SECRET_VALUE_BYTES || value.includes("\u0000")
        ? `Secret values must be at most ${HOSTED_CODE_MAX_SECRET_VALUE_BYTES} UTF-8 bytes without NUL characters.`
        : undefined,
    ),
  ),
);

/** Write-only secret values injected as environment variables into each execution. */
export const HostedCodeSecrets = Schema.Record(HostedCodeSecretName, HostedCodeSecretValue).pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, string>>>((secrets) => {
      const count = Object.keys(secrets).length;
      return count >= 1 && count <= HOSTED_CODE_MAX_SECRETS
        ? undefined
        : `Hosted code tools declare between 1 and ${HOSTED_CODE_MAX_SECRETS} secrets.`;
    }),
  ),
);

export const CreateHostedCodeArtifactRequest = Schema.Struct({
  language: HostedCodeSourceLanguage,
  source: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.makeFilter<string>((source) =>
        utf8Bytes(source) > HOSTED_CODE_MAX_SOURCE_BYTES
          ? `Hosted code source must be at most ${HOSTED_CODE_MAX_SOURCE_BYTES} UTF-8 bytes.`
          : undefined,
      ),
    ),
  ),
});

export const HostedCodeArtifactResponse = Schema.Struct({
  byteSize: Schema.Number,
  contentHash: HostedCodeContentHash,
  createdAt: Timestamp,
  language: HostedCodeRuntimeLanguage,
  sourceByteSize: Schema.Number,
  sourceContentHash: HostedCodeContentHash,
  sourceLanguage: HostedCodeSourceLanguage,
});

export const HostedCodeToolExecution = Schema.Struct({
  contentHash: HostedCodeContentHash,
  entrypoint: Schema.optional(HostedCodeEntrypoint),
  memoryMiB: Schema.optional(
    integerBetween(HOSTED_CODE_MIN_MEMORY_MIB, HOSTED_CODE_MAX_MEMORY_MIB),
  ),
  network: Schema.optional(HostedCodeNetworkMode),
  timeoutMs: Schema.optional(
    integerBetween(HOSTED_CODE_MIN_TIMEOUT_MS, HOSTED_CODE_MAX_TIMEOUT_MS),
  ),
  type: Schema.Literal("hosted_code"),
});

/** Normalized hosted code execution returned by the extension API; secret values never appear. */
export const HostedCodeToolExecutionView = Schema.Struct({
  contentHash: HostedCodeContentHash,
  entrypoint: HostedCodeEntrypoint,
  language: HostedCodeRuntimeLanguage,
  memoryMiB: Schema.Number,
  network: HostedCodeNetworkMode,
  secretNames: Schema.Array(Schema.String),
  sourceLanguage: HostedCodeSourceLanguage,
  timeoutMs: Schema.Number,
  type: Schema.Literal("hosted_code"),
});

export const HOSTED_CODE_TOOL_API_SCHEMAS = {
  CreateHostedCodeArtifactRequest,
  HostedCodeArtifactResponse,
  HostedCodeToolExecution,
  HostedCodeToolExecutionView,
} as const;
