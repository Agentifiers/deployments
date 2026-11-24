import { Schema } from "effect";

export const PUBLIC_ID_PATTERN_SOURCE = "^[0-7][0-9A-HJKMNP-TV-Z]{25}$";
export const PUBLIC_ID_PATTERN = new RegExp(PUBLIC_ID_PATTERN_SOURCE, "u");

export const PublicId = Schema.String.pipe(
  Schema.check(
    Schema.isULID({ message: "Expected a 26-character ULID." }),
    Schema.isPattern(PUBLIC_ID_PATTERN, {
      message: "Public IDs must use canonical uppercase Crockford base32 ULIDs.",
    }),
  ),
  Schema.brand("PublicId"),
);
export type PublicId = typeof PublicId.Type;

const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const Timestamp = Schema.String.annotate({ format: "date-time" }).pipe(
  Schema.check(
    Schema.isPattern(CANONICAL_TIMESTAMP_PATTERN, {
      message: "Timestamps must use canonical UTC millisecond precision.",
    }),
    Schema.makeFilter<string>((input) => {
      const milliseconds = Date.parse(input);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
        ? undefined
        : "Expected a canonical UTC timestamp with millisecond precision.";
    }),
  ),
);

export const ResourceName = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Resource names must not contain surrounding whitespace." }),
    Schema.isMinLength(1, { message: "Resource names must not be empty." }),
    Schema.isMaxLength(120, { message: "Resource names must not exceed 120 characters." }),
  ),
);

export const ResourceDescription = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(2_000, { message: "Descriptions must not exceed 2000 characters." }),
  ),
);

export const EmailAddress = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Email addresses must not contain surrounding whitespace." }),
    Schema.isMaxLength(254, { message: "Email addresses must not exceed 254 characters." }),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, {
      message: "Expected a valid email address.",
    }),
    Schema.makeFilter<string>((input) =>
      input === input.toLowerCase() ? undefined : "Email addresses must use lowercase characters.",
    ),
  ),
);
export type EmailAddress = typeof EmailAddress.Type;

export const Slug = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, {
      message:
        "Slugs must be 1 to 63 lowercase ASCII letters, numbers, or hyphens without edge hyphens.",
    }),
  ),
  Schema.brand("Slug"),
);
export type Slug = typeof Slug.Type;

export const ScopeName = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Scopes must not be empty." }),
    Schema.isMaxLength(128, { message: "Scopes must not exceed 128 characters." }),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:[.:/_-][a-z0-9*]+)*$/u, {
      message: "Scopes must use lowercase capability segments without whitespace.",
    }),
  ),
);

export const ScopeList = Schema.Array(ScopeName).pipe(
  Schema.check(Schema.isUnique({ message: "Scopes must not contain duplicates." })),
);

export const Cursor = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Cursors must not be empty." }),
    Schema.isMaxLength(4_096, { message: "Cursors must not exceed 4096 characters." }),
  ),
);

export const PageLimit = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Page limits must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "Page limits must be at least 1." }),
    Schema.isLessThanOrEqualTo(100, { message: "Page limits must not exceed 100." }),
  ),
);

export const ListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});
export type ListQuery = typeof ListQuery.Type;

export const IdempotencyKey = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Idempotency keys must not be empty." }),
    Schema.isMaxLength(512, { message: "Idempotency keys must not exceed 512 characters." }),
  ),
);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValue: Schema.Codec<JsonValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number.pipe(Schema.check(Schema.isFinite())),
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<JsonValue> => JsonValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<JsonValue> => JsonValue),
  ),
]);

export const Metadata = Schema.Record(Schema.String, JsonValue);

export const ProblemDetails = Schema.Struct({
  code: Schema.optional(
    Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^[a-z][a-z0-9_]*$/u, {
          message: "Problem codes must use lowercase snake_case.",
        }),
      ),
    ),
  ),
  detail: Schema.optional(Schema.String),
  instance: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  status: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(400),
      Schema.isLessThanOrEqualTo(599),
    ),
  ),
  title: Schema.String,
  type: Schema.optional(Schema.String),
});
export type ProblemDetails = typeof ProblemDetails.Type;

export function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

export function resolveSlug(input: { readonly name: string; readonly slug?: string }): Slug {
  const candidate = normalizeSlug(input.slug ?? input.name);
  return Schema.decodeUnknownSync(Slug)(candidate);
}
