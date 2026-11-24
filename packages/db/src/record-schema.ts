import { Schema, type SchemaAST } from "effect";
import { CaptureMode, SpanId, TraceId } from "@deployments-ai/observability";
import { Ulid } from "./ids.ts";

export const StringList = Schema.Array(Schema.String);

export const PersistedNumber = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite({ message: "Persisted numbers must be finite." }),
    Schema.makeFilter<number>((input) =>
      Number.isInteger(input) && !Number.isSafeInteger(input)
        ? "Persisted integers must be safely representable."
        : undefined,
    ),
  ),
);

export type DynamoValue =
  | null
  | boolean
  | number
  | string
  | readonly DynamoValue[]
  | { readonly [key: string]: DynamoValue };

export const DynamoValue: Schema.Codec<DynamoValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  PersistedNumber,
  Schema.Array(Schema.suspend((): Schema.Codec<DynamoValue> => DynamoValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<DynamoValue> => DynamoValue),
  ),
]);

export const MAX_DYNAMODB_ITEM_BYTES = 400 * 1_024;

const textEncoder = new TextEncoder();

function dynamoNumberByteSize(value: number) {
  if (value === 0) return 2;
  const coefficient = Math.abs(value).toString().toLowerCase().split("e", 1)[0] ?? "";
  const significantDigits = coefficient
    .replace(".", "")
    .replace(/^0+/u, "")
    .replace(/0+$/u, "").length;
  return Math.ceil(Math.max(1, significantDigits) / 2) + 1;
}

function dynamoValueByteSize(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "string") return textEncoder.encode(value).byteLength;
  if (typeof value === "number") return dynamoNumberByteSize(value);
  if (Array.isArray(value)) {
    return 3 + value.length + value.reduce((total, item) => total + dynamoValueByteSize(item), 0);
  }
  if (typeof value !== "object") return 0;
  const entries = Object.entries(value);
  return (
    3 +
    entries.length +
    entries.reduce(
      (total, [name, item]) =>
        total + textEncoder.encode(name).byteLength + dynamoValueByteSize(item),
      0,
    )
  );
}

export function dynamoItemByteSize(item: object) {
  return Object.entries(item).reduce(
    (total, [name, value]) =>
      total + textEncoder.encode(name).byteLength + dynamoValueByteSize(value),
    0,
  );
}

export const Metadata = Schema.Record(Schema.String, DynamoValue);
export const NumberMap = Schema.Record(Schema.String, PersistedNumber);

export const NonEmptyString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      input.trim().length > 0 ? undefined : "Expected a non-empty string.",
    ),
  ),
);

const INBOX_ADDRESS_PATTERN =
  /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export const InboxAddress = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      INBOX_ADDRESS_PATTERN.test(input)
        ? undefined
        : "Expected a normalized lowercase inbox email address.",
    ),
  ),
);

export const Timestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      const milliseconds = Date.parse(input);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input
        ? undefined
        : "Expected a canonical UTC timestamp with millisecond precision.";
    }),
  ),
);

export const BlobReference = Schema.Struct({
  bucket: Schema.String,
  byteSize: Schema.Number,
  contentType: Schema.String,
  etag: Schema.optional(Schema.String),
  fileName: Schema.optional(Schema.String),
  key: Schema.String,
  sha256: Schema.String,
  versionId: Schema.optional(Schema.String),
});

export const AwsSecretsManagerReference = Schema.Struct({
  arn: Schema.String,
  versionId: Schema.optional(Schema.String),
  versionStage: Schema.optional(Schema.String),
});

export const DynamoKmsCredentialReference = Schema.Struct({
  credentialId: Ulid,
  generation: PersistedNumber.pipe(
    Schema.check(
      Schema.isInt({ message: "Credential generations must be integers." }),
      Schema.isGreaterThanOrEqualTo(0, {
        message: "Credential generations must not be negative.",
      }),
    ),
  ),
  store: Schema.Literal("dynamodb-kms"),
});

export const SecretReference = Schema.Union([
  AwsSecretsManagerReference,
  DynamoKmsCredentialReference,
]);

export const ActorReference = Schema.Struct({
  id: Schema.optional(Ulid),
  /** Set when a platform administrator acted under this operator access grant. */
  operatorAccessGrantId: Schema.optional(Ulid),
  type: Schema.Literals([
    "agent",
    "directory-token",
    "principal",
    "service-account",
    "system",
    "worker",
  ]),
});

export const DNS_HOST_NAME_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const Money = Schema.Struct({
  amountMinor: Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: "Minor-unit amounts must be integers." }),
      Schema.isGreaterThanOrEqualTo(Number.MIN_SAFE_INTEGER, {
        message: "Minor-unit amounts must be safe integers.",
      }),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
        message: "Minor-unit amounts must be safe integers.",
      }),
    ),
  ),
  currency: Schema.String,
});

export const SafeInteger = Money.fields.amountMinor;

export const NonNegativeSafeInteger = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Resource versions must be integers." }),
    Schema.isGreaterThanOrEqualTo(0, { message: "Resource versions must not be negative." }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
      message: "Resource versions must be safe integers.",
    }),
  ),
);

export const QueuePriority = NonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isLessThanOrEqualTo(99_999_999, {
      message: "Queue priorities must fit the eight-digit sort-key encoding.",
    }),
  ),
);

export const mutableResourceFields = {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: NonNegativeSafeInteger,
} as const;

export const stateVersionFields = {
  version: NonNegativeSafeInteger,
} as const;

export const tenantScopeFields = {
  environmentId: Ulid,
  organizationId: Ulid,
  projectId: Ulid,
} as const;

export const workspaceScopeFields = {
  ...tenantScopeFields,
  workspaceId: Schema.optional(Ulid),
} as const;

export const ObservabilitySourceContext = Schema.Struct({
  captureMode: CaptureMode,
  parentSpanId: Schema.optional(SpanId),
  runSpanId: SpanId,
  sessionId: Ulid,
  traceId: TraceId,
  workspaceId: Schema.optional(Ulid),
});
export type ObservabilitySourceContext = typeof ObservabilitySourceContext.Type;

export interface RecordSchemaOptions {
  readonly expiresAtField?: string;
  readonly expiresAtFields?: readonly string[];
  readonly expiresAtRequired?: boolean;
  readonly expiresAtTtlRequired?: boolean;
  /** `ttl` is a retention deadline the database sets from the tenant's policy (`retention-ttl.ts`). */
  readonly retentionTtl?: true;
  /** When present, `ttl` equals this epoch-seconds data field. */
  readonly ttlField?: string;
}

function isDynamoCompatible(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (Array.isArray(value)) return value.every(isDynamoCompatible);
  if (typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isDynamoCompatible);
}

interface RecordEnvelope {
  readonly data: unknown;
  readonly gsi1pk?: string | undefined;
  readonly gsi1sk?: string | undefined;
  readonly gsi2pk?: string | undefined;
  readonly gsi2sk?: string | undefined;
  readonly pk: string;
  readonly sk: string;
  readonly ttl?: number | undefined;
}

function isValidRecordEnvelope(record: RecordEnvelope, options: RecordSchemaOptions) {
  if (
    record.pk.trim().length === 0 ||
    record.sk.trim().length === 0 ||
    !isDynamoCompatible(record.data) ||
    (record.gsi1pk === undefined) !== (record.gsi1sk === undefined) ||
    (record.gsi2pk === undefined) !== (record.gsi2sk === undefined) ||
    (record.ttl !== undefined && (!Number.isInteger(record.ttl) || record.ttl < 0))
  ) {
    return false;
  }

  if (options.retentionTtl) return true;
  if (options.ttlField !== undefined) {
    return (
      record.ttl === undefined ||
      record.ttl === (record.data as Readonly<Record<string, unknown>>)[options.ttlField]
    );
  }
  const expiresAtFields =
    options.expiresAtFields ??
    (options.expiresAtField === undefined ? [] : [options.expiresAtField]);
  if (expiresAtFields.length === 0) return record.ttl === undefined;
  const expirationValues = expiresAtFields
    .map((field) => (record.data as Readonly<Record<string, unknown>>)[field])
    .filter((value) => value !== undefined);
  if (expirationValues.length === 0 && options.expiresAtRequired === false) {
    return record.ttl === undefined;
  }
  if (expirationValues.length === 0) return false;
  const expirationMilliseconds = expirationValues.map((expiresAt) =>
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN,
  );
  const expiresAtMilliseconds = Math.max(...expirationMilliseconds);

  return (
    expirationMilliseconds.every(Number.isFinite) &&
    (record.ttl === Math.floor(expiresAtMilliseconds / 1_000) ||
      (record.ttl === undefined && options.expiresAtTtlRequired === false))
  );
}

function recordEnvelopeAnnotations(itemType: string) {
  return {
    identifier: `${itemType}RecordEnvelope`,
    message:
      "Record keys must be non-empty, GSI partition/sort keys must be paired, and ttl must match required logical expiration.",
  };
}

function recordEnvelopeFields<const ItemType extends string>(itemType: ItemType) {
  return {
    gsi1pk: Schema.optional(Schema.String),
    gsi1sk: Schema.optional(Schema.String),
    gsi2pk: Schema.optional(Schema.String),
    gsi2sk: Schema.optional(Schema.String),
    itemType: Schema.Literal(itemType),
    pk: Schema.String,
    sk: Schema.String,
    ttl: Schema.optional(Schema.Number),
  };
}

export function makeRecordSchema<
  const ItemType extends string,
  const Fields extends Schema.Struct.Fields,
>(itemType: ItemType, fields: Fields, options: RecordSchemaOptions = {}) {
  return Schema.Struct({ data: Schema.Struct(fields), ...recordEnvelopeFields(itemType) }).pipe(
    Schema.refine(
      (record): record is typeof record => isValidRecordEnvelope(record, options),
      recordEnvelopeAnnotations(itemType),
    ),
  );
}

/**
 * A record whose `data` is exactly one of `arms`. Decoded with `onExcessProperty: "error"`, a row
 * mixing fields of two arms matches neither. Every arm carries the fields its keys derive from.
 */
export function makeUnionRecordSchema<
  const ItemType extends string,
  const Arms extends readonly [Schema.Constraint, Schema.Constraint, ...Schema.Constraint[]],
>(itemType: ItemType, arms: Arms, options: RecordSchemaOptions = {}) {
  return Schema.Struct({ data: Schema.Union(arms), ...recordEnvelopeFields(itemType) }).pipe(
    Schema.refine(
      (record): record is typeof record => isValidRecordEnvelope(record, options),
      recordEnvelopeAnnotations(itemType),
    ),
  );
}

function unionArms(ast: SchemaAST.AST): readonly SchemaAST.AST[] {
  return ast._tag === "Union" ? ast.types.flatMap(unionArms) : [ast];
}

/** The `data` fields a record schema declares in every one of its union arms. */
export function recordDataFields(schema: { readonly ast: SchemaAST.AST }): readonly string[] {
  const [first = [], ...rest] = unionArms(schema.ast).flatMap((envelope) => {
    const data =
      envelope._tag === "Objects"
        ? envelope.propertySignatures.find(({ name }) => name === "data")
        : undefined;
    if (!data) return [[]];
    return unionArms(data.type).map((arm) =>
      arm._tag === "Objects" ? arm.propertySignatures.map(({ name }) => String(name)) : [],
    );
  });
  return first.filter((field) => rest.every((fields) => fields.includes(field)));
}
