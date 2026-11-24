import {
  CreateExtensionToolRequest,
  TOOLING_API_SCHEMAS,
  UpdateExtensionToolRequest,
  type ExtensionToolResponse,
} from "@deployments-ai/api-contract/tooling";
import { Schema, SchemaIssue, Struct } from "effect";
import { canonicalManifestJson } from "../agents/manifest-diff.ts";

export const EXECUTION_TYPES = ["client", "hosted_code", "http_callback", "mcp"] as const;
export type ExecutionType = (typeof EXECUTION_TYPES)[number];
export const ACTIONS = ["allow", "require_approval", "deny"] as const;
export type Action = (typeof ACTIONS)[number];
export const EFFECTS = ["read", "write", "execute"] as const;
export type Effect = (typeof EFFECTS)[number];
export const SOURCE_LANGUAGES = ["typescript", "javascript", "python"] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];
export const NETWORK_MODES = ["none", "sandbox"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export type ExtensionTool = typeof ExtensionToolResponse.Type;
export type ArtifactUpload = typeof TOOLING_API_SCHEMAS.CreateHostedCodeArtifactRequest.Type;

const [mcpArm, callbackArm, clientArm, hostedArm] = CreateExtensionToolRequest.members;
const CREATE_ARMS = {
  client: clientArm,
  hosted_code: hostedArm,
  http_callback: callbackArm,
  mcp: mcpArm,
} satisfies {
  readonly [Type in ExecutionType]: {
    readonly fields: {
      readonly execution: { readonly fields: { readonly type: { readonly literal: Type } } };
    };
  };
};

const PendingHostedExecution = hostedArm.fields.execution.mapFields(Struct.omit(["contentHash"]));
const PendingHostedCreate = hostedArm.mapFields((fields) => ({
  ...fields,
  execution: PendingHostedExecution,
}));
const PendingHostedUpdate = UpdateExtensionToolRequest.mapFields((fields) => ({
  ...fields,
  execution: Schema.optional(PendingHostedExecution),
}));

export type CreateBody = typeof CreateExtensionToolRequest.Type;
export type UpdateBody = typeof UpdateExtensionToolRequest.Type;

/**
 * A hosted code write that uploads new source names no artifact yet: the server uploads it,
 * then fills `execution.contentHash` before it sends the body.
 */
export type CreateWrite =
  | { readonly artifact?: never; readonly body: CreateBody }
  | { readonly artifact: ArtifactUpload; readonly body: typeof PendingHostedCreate.Type };
export type UpdateWrite =
  | { readonly artifact?: never; readonly body: UpdateBody }
  | { readonly artifact: ArtifactUpload; readonly body: typeof PendingHostedUpdate.Type };

export type FieldKey =
  | "callbackSecret"
  | "defaultPolicyAction"
  | "description"
  | "effect"
  | "endpointOrigin"
  | "endpointPath"
  | "entrypoint"
  | "form"
  | "inputSchema"
  | "mcpServerId"
  | "memoryMiB"
  | "name"
  | "network"
  | "outputSchema"
  | "providerKey"
  | "remoteToolName"
  | "requiredScopes"
  | "secrets"
  | "source"
  | "timeoutMs"
  | "workspaceFiles";

export interface FieldIssue {
  readonly field: FieldKey;
  readonly message: string;
}

export type Planned<Write> =
  | { readonly ok: true; readonly write: Write }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/** `keep` leaves a stored write-only value alone; only an edit offers it. */
export type SecretDraft =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly value: string };

export interface SecretEntry {
  readonly name: string;
  readonly value: string;
}

/** Hosted code secrets replace the whole set, so an edit either keeps it or retypes every value. */
export type HostedSecretsDraft =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly entries: readonly SecretEntry[] };

export type SourceDraft =
  | { readonly kind: "keep"; readonly contentHash: string }
  | { readonly kind: "upload"; readonly language: SourceLanguage; readonly source: string };

/** The form as typed: free text stays text until `createWrite` or `updateWrite` reads it. */
interface CommonDraft {
  readonly defaultPolicyAction: Action;
  readonly description: string;
  readonly inputSchema: string;
  readonly name: string;
  readonly requiredScopes: string;
}

export type ExtensionDraft =
  | (CommonDraft & {
      readonly mcpServerId: string;
      readonly remoteToolName: string;
      readonly type: "mcp";
    })
  | (CommonDraft & {
      readonly callbackSecret: SecretDraft;
      readonly effect: Effect;
      readonly endpointOrigin: string;
      readonly endpointPath: string;
      readonly providerKey: string;
      readonly runContext: readonly "origin"[];
      readonly type: "http_callback";
      readonly workspaceFiles: string;
    })
  | (CommonDraft & {
      readonly effect: Effect;
      readonly outputSchema: string;
      readonly timeoutMs: string;
      readonly type: "client";
    })
  | (CommonDraft & {
      readonly effect: Effect;
      readonly entrypoint: string;
      readonly memoryMiB: string;
      readonly network: NetworkMode;
      readonly outputSchema: string;
      readonly secrets: HostedSecretsDraft;
      readonly source: SourceDraft;
      readonly timeoutMs: string;
      readonly type: "hosted_code";
    });

const CALLBACK_PROVIDER = "extension_callback";
const OBJECT_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}';
const SAMPLE_SOURCE = "export async function handler(input) {\n  return { ok: true };\n}\n";

export interface NewDraftPrefill {
  readonly remote?: string;
  readonly server?: string;
}

/** A new extension of one type; `common` carries the shared fields across a type switch. */
export function blankDraft(
  type: ExecutionType,
  prefill: NewDraftPrefill = {},
  common: CommonDraft = {
    defaultPolicyAction: "allow",
    description: "",
    inputSchema: OBJECT_SCHEMA,
    name: prefill.remote ?? "",
    requiredScopes: "",
  },
): ExtensionDraft {
  switch (type) {
    case "mcp":
      return {
        ...common,
        mcpServerId: prefill.server ?? "",
        remoteToolName: prefill.remote ?? "",
        type,
      };
    case "http_callback":
      return {
        ...common,
        callbackSecret: { kind: "replace", value: "" },
        effect: "read",
        endpointOrigin: "",
        endpointPath: "",
        providerKey: CALLBACK_PROVIDER,
        runContext: [],
        type,
        workspaceFiles: "",
      };
    case "client":
      return { ...common, effect: "read", outputSchema: "", timeoutMs: "", type };
    case "hosted_code":
      return {
        ...common,
        effect: "read",
        entrypoint: "",
        memoryMiB: "",
        network: "none",
        outputSchema: OBJECT_SCHEMA,
        secrets: { kind: "replace", entries: [] },
        source: { kind: "upload", language: "typescript", source: SAMPLE_SOURCE },
        timeoutMs: "",
        type,
      };
  }
}

export function commonDraft(draft: ExtensionDraft): CommonDraft {
  const { defaultPolicyAction, description, inputSchema, name, requiredScopes } = draft;
  return { defaultPolicyAction, description, inputSchema, name, requiredScopes };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** The edit form for a stored extension; vendor MCP tools are synced, never edited. */
export function editDraft(tool: ExtensionTool): ExtensionDraft | undefined {
  const common: CommonDraft = {
    defaultPolicyAction: tool.defaultPolicyAction,
    description: tool.description,
    inputSchema: formatJson(tool.inputSchema),
    name: tool.name,
    requiredScopes: tool.requiredScopes.join(" "),
  };
  const outputSchema = tool.outputSchema === undefined ? "" : formatJson(tool.outputSchema);
  const { execution } = tool;
  switch (execution.type) {
    case "vendor_mcp":
      return undefined;
    case "mcp":
      return {
        ...common,
        mcpServerId: execution.mcpServerId,
        remoteToolName: execution.remoteToolName,
        type: "mcp",
      };
    case "http_callback":
      return {
        ...common,
        callbackSecret: { kind: "keep" },
        effect: tool.effect,
        endpointOrigin: execution.endpointOrigin,
        endpointPath: execution.endpointPath,
        providerKey: tool.providerKey ?? "",
        runContext: execution.runContext ?? [],
        type: "http_callback",
        workspaceFiles: (execution.workspaceFiles?.include ?? []).join("\n"),
      };
    case "client":
      return {
        ...common,
        effect: tool.effect,
        outputSchema,
        timeoutMs: execution.timeoutMs === undefined ? "" : String(execution.timeoutMs),
        type: "client",
      };
    case "hosted_code":
      return {
        ...common,
        effect: tool.effect,
        entrypoint: execution.entrypoint,
        memoryMiB: String(execution.memoryMiB),
        network: execution.network,
        outputSchema,
        secrets: { kind: "keep" },
        source: { contentHash: execution.contentHash, kind: "keep" },
        timeoutMs: String(execution.timeoutMs),
        type: "hosted_code",
      };
  }
}

/** Collects every problem in one pass, so the form names all of them at once. */
class Reader {
  readonly issues: FieldIssue[] = [];

  json(field: FieldKey, text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      this.issues.push({ field, message: "Enter valid JSON." });
      return text;
    }
  }

  integer(field: FieldKey, text: string): number | undefined {
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    if (/^\d+$/u.test(trimmed)) return Number(trimmed);
    this.issues.push({ field, message: "Enter a whole number." });
    return Number.NaN;
  }

  secrets(entries: readonly SecretEntry[]): Record<string, string> {
    const record: Record<string, string> = {};
    for (const { name, value } of entries) {
      const key = name.trim();
      if (Object.hasOwn(record, key)) {
        this.issues.push({ field: "secrets", message: `Secret ${key} appears more than once.` });
      }
      record[key] = value;
    }
    return record;
  }

  decode<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    value: unknown,
    field?: FieldKey,
  ): S["Type"] | undefined {
    try {
      return Schema.decodeUnknownSync(schema)(value, { errors: "all" });
    } catch (cause) {
      if (!Schema.isSchemaError(cause)) throw cause;
      for (const issue of formatIssues(cause.issue).issues) {
        const at = field ?? fieldAt(issue.path ?? []);
        this.issues.push({
          field: at,
          message:
            at === "callbackSecret"
              ? "Enter a callback secret of at most 4,096 characters without leading or trailing spaces."
              : issue.message,
        });
      }
      return undefined;
    }
  }

  planned<Write>(write: Write | undefined): Planned<Write> {
    if (write !== undefined && this.issues.length === 0) return { ok: true, write };
    const seen = new Set<FieldKey>();
    const issues = this.issues.filter(({ field }) => !seen.has(field) && seen.add(field));
    return { issues, ok: false };
  }
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const EXECUTION_FIELDS: Partial<Record<FieldKey, true>> = {
  endpointOrigin: true,
  endpointPath: true,
  entrypoint: true,
  mcpServerId: true,
  memoryMiB: true,
  network: true,
  remoteToolName: true,
  timeoutMs: true,
  workspaceFiles: true,
};
const BODY_FIELDS: Partial<Record<FieldKey, true>> = {
  callbackSecret: true,
  defaultPolicyAction: true,
  description: true,
  effect: true,
  inputSchema: true,
  name: true,
  outputSchema: true,
  providerKey: true,
  requiredScopes: true,
  secrets: true,
};

function isFieldOf(fields: Partial<Record<FieldKey, true>>, value: unknown): value is FieldKey {
  return typeof value === "string" && Object.hasOwn(fields, value);
}

/** The form field a contract issue path points at; the contract's messages may quote values. */
function fieldAt(path: readonly unknown[]): FieldKey {
  const [first, second] = path.map((segment) =>
    typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment,
  );
  if (first === "execution") return isFieldOf(EXECUTION_FIELDS, second) ? second : "form";
  return isFieldOf(BODY_FIELDS, first) ? first : "form";
}

function scopeList(text: string): readonly string[] {
  return text.split(/[\s,]+/u).filter((scope) => scope !== "");
}

function fileList(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function common(draft: ExtensionDraft, read: Reader) {
  return {
    defaultPolicyAction: draft.defaultPolicyAction,
    description: draft.description.trim(),
    inputSchema: read.json("inputSchema", draft.inputSchema),
    name: draft.name.trim(),
    requiredScopes: scopeList(draft.requiredScopes),
  };
}

function execution(draft: ExtensionDraft, read: Reader) {
  switch (draft.type) {
    case "mcp":
      return {
        mcpServerId: draft.mcpServerId.trim(),
        remoteToolName: draft.remoteToolName.trim(),
        type: draft.type,
      };
    case "http_callback": {
      const include = fileList(draft.workspaceFiles);
      return {
        endpointOrigin: draft.endpointOrigin.trim(),
        endpointPath: draft.endpointPath.trim(),
        ...(draft.runContext.length === 0 ? {} : { runContext: draft.runContext }),
        type: draft.type,
        ...(include.length === 0 ? {} : { workspaceFiles: { include } }),
      };
    }
    case "client": {
      const timeoutMs = read.integer("timeoutMs", draft.timeoutMs);
      return { type: draft.type, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    }
    case "hosted_code": {
      const entrypoint = draft.entrypoint.trim();
      const memoryMiB = read.integer("memoryMiB", draft.memoryMiB);
      const timeoutMs = read.integer("timeoutMs", draft.timeoutMs);
      return {
        type: draft.type,
        ...(draft.source.kind === "keep" ? { contentHash: draft.source.contentHash } : {}),
        ...(entrypoint === "" ? {} : { entrypoint }),
        ...(memoryMiB === undefined ? {} : { memoryMiB }),
        network: draft.network,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
  }
}

function upload(draft: ExtensionDraft, read: Reader): ArtifactUpload | undefined {
  if (draft.type !== "hosted_code" || draft.source.kind !== "upload") return undefined;
  const { language, source } = draft.source;
  return read.decode(
    TOOLING_API_SCHEMAS.CreateHostedCodeArtifactRequest,
    { language, source },
    "source",
  );
}

function createBody(draft: ExtensionDraft, read: Reader): Record<string, unknown> {
  const base = { ...common(draft, read), execution: execution(draft, read) };
  switch (draft.type) {
    case "mcp":
      return { ...base, effect: "read" };
    case "http_callback":
      return {
        ...base,
        effect: draft.effect,
        providerKey: draft.providerKey.trim(),
        ...(draft.callbackSecret.kind === "replace"
          ? { callbackSecret: draft.callbackSecret.value }
          : {}),
      };
    case "client":
      return {
        ...base,
        effect: draft.effect,
        ...(draft.outputSchema.trim() === ""
          ? {}
          : { outputSchema: read.json("outputSchema", draft.outputSchema) }),
      };
    case "hosted_code":
      return {
        ...base,
        effect: draft.effect,
        outputSchema: read.json("outputSchema", draft.outputSchema),
        ...(draft.secrets.kind === "replace" && draft.secrets.entries.length > 0
          ? { secrets: read.secrets(draft.secrets.entries) }
          : {}),
      };
  }
}

/** The create request for a draft, decoded against the contract arm of its execution type. */
export function createWrite(draft: ExtensionDraft): Planned<CreateWrite> {
  const read = new Reader();
  const body = createBody(draft, read);
  const artifact = upload(draft, read);
  if (draft.type === "hosted_code" && draft.source.kind === "upload") {
    const pending = read.decode(PendingHostedCreate, body);
    return read.planned(artifact && pending ? { artifact, body: pending } : undefined);
  }
  const decoded = read.decode(CREATE_ARMS[draft.type], body);
  return read.planned(decoded ? { body: decoded } : undefined);
}

/**
 * The smallest update that turns `before` into `draft`. The execution type cannot change, and an
 * HTTP callback that moves to a new target needs a new secret (`callback_auth_replacement_required`).
 */
export function updateWrite(before: ExtensionTool, draft: ExtensionDraft): Planned<UpdateWrite> {
  const read = new Reader();
  const base = editDraft(before);
  if (base === undefined || base.type !== draft.type) {
    read.issues.push({
      field: "form",
      message: "The execution type of an extension cannot change.",
    });
    return read.planned<UpdateWrite>(undefined);
  }
  const ignored = new Reader();
  const now = sentFields(draft);
  const was = sentFields(base);
  const differs = (field: FieldKey) => now[field] !== was[field];
  const changes: Record<string, unknown> = {};
  if (differs("description")) changes.description = draft.description.trim();
  if (differs("defaultPolicyAction")) changes.defaultPolicyAction = draft.defaultPolicyAction;
  if (differs("inputSchema")) changes.inputSchema = read.json("inputSchema", draft.inputSchema);
  if (differs("requiredScopes")) changes.requiredScopes = scopeList(draft.requiredScopes);
  if ("effect" in draft && differs("effect")) changes.effect = draft.effect;
  if ("outputSchema" in draft && differs("outputSchema")) {
    if (draft.outputSchema.trim() === "") {
      read.issues.push({ field: "outputSchema", message: "An output schema cannot be removed." });
    } else {
      changes.outputSchema = read.json("outputSchema", draft.outputSchema);
    }
  }
  const next = execution(draft, read);
  const executionChanged =
    JSON.stringify(next) !== JSON.stringify(execution(base, ignored)) ||
    (draft.type === "hosted_code" && draft.source.kind === "upload");
  if (executionChanged) changes.execution = next;
  if (draft.type === "http_callback") {
    if (differs("providerKey")) changes.providerKey = draft.providerKey.trim();
    const moved = differs("endpointOrigin") || differs("endpointPath");
    if (draft.callbackSecret.kind === "replace") {
      changes.callbackSecret = draft.callbackSecret.value;
    } else if (moved && before.hasCallbackAuth) {
      read.issues.push({
        field: "callbackSecret",
        message: "A new callback endpoint needs a new callback secret.",
      });
    }
  }
  if (draft.type === "hosted_code" && draft.secrets.kind === "replace") {
    changes.secrets = read.secrets(draft.secrets.entries);
  }
  const artifact = upload(draft, read);
  if (Object.keys(changes).length === 0) {
    if (read.issues.length === 0) {
      read.issues.push({ field: "form", message: "Nothing to save. Change a field first." });
    }
    return read.planned<UpdateWrite>(undefined);
  }
  const body = { ...changes, expectedVersion: before.version };
  if (draft.type === "hosted_code" && draft.source.kind === "upload") {
    const pending = read.decode(PendingHostedUpdate, body);
    return read.planned(artifact && pending ? { artifact, body: pending } : undefined);
  }
  const decoded = read.decode(UpdateExtensionToolRequest, body);
  return read.planned(decoded ? { body: decoded } : undefined);
}

const trim = (text: string) => text.trim();

/** What a save sends for each free-text field, so a difference only in typing is not an edit. */
const SENT: Readonly<Partial<Record<string, (text: string) => unknown>>> = {
  description: trim,
  endpointOrigin: trim,
  endpointPath: trim,
  entrypoint: trim,
  inputSchema: parsedJson,
  mcpServerId: trim,
  memoryMiB: wholeNumber,
  name: trim,
  outputSchema: parsedJson,
  providerKey: trim,
  remoteToolName: trim,
  requiredScopes: scopeList,
  timeoutMs: wholeNumber,
  workspaceFiles: fileList,
} satisfies Partial<Record<FieldKey, (text: string) => unknown>>;

function parsedJson(text: string): unknown {
  try {
    return { json: canonicalManifestJson(JSON.parse(text)) };
  } catch {
    return { text: text.trim() };
  }
}

function wholeNumber(text: string): number | string {
  const trimmed = text.trim();
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : trimmed;
}

/** Fields that name one target together; a rebase keeps either writer's group whole. */
const COUPLED: readonly (readonly string[])[] = [
  ["callbackSecret", "endpointOrigin", "endpointPath"],
  ["entrypoint", "source"],
  ["mcpServerId", "remoteToolName"],
] satisfies readonly (readonly FieldKey[])[];

function sentFields(draft: ExtensionDraft): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(draft).map(([field, value]: [string, unknown]) => {
      const as = SENT[field];
      const sent = as !== undefined && typeof value === "string" ? as(value) : value;
      return [field, JSON.stringify(sent)];
    }),
  );
}

/**
 * The operator's edits since `loaded`, laid over `latest`. A field they left alone takes the newer
 * version's value, so a save after a concurrent write sends only their own changes.
 */
export function rebaseDraft<Draft extends ExtensionDraft>(
  loaded: Draft,
  latest: Draft,
  draft: Draft,
): Draft {
  const before = sentFields(loaded);
  const after = sentFields(draft);
  let rebased = latest;
  for (const field in draft) {
    const group = COUPLED.find((members) => members.includes(field)) ?? [field];
    if (group.some((member) => after[member] !== before[member])) {
      rebased = { ...rebased, [field]: draft[field] };
    }
  }
  return rebased;
}
