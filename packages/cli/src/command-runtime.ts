import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { TENANCY_PATHS } from "@deployments-ai/api-contract/routes";
import {
  createMockPlatformSdk,
  createPlatformSdk,
  emailEndUserId,
  MOCK_TENANCY_CONTEXT,
  type PlatformContext,
  type PlatformRequest,
  type PlatformSdk,
} from "@agentifiers/deployments-sdk";
import { defineCommand, type ArgsDef, type CommandDef } from "citty";
import pc from "picocolors";
import { resolveContext } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { renderOutput, renderStreamEvent } from "./output.ts";
import type {
  ActionSpec,
  CliIo,
  CommandArgument,
  ContextScope,
  ResolvedCliContext,
} from "./types.ts";
import { CLI_VERSION } from "./version.ts";
export interface CliRuntime {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
}

export function colorEnabled(args: LooseArgs, runtime: CliRuntime): boolean {
  return args.color !== false && !runtime.env.NO_COLOR;
}

export type AnyCommand = CommandDef<any>;
export type LooseArgs = Readonly<Record<string, unknown>>;

const TENANCY_PATH_PREFIXES = Object.values(TENANCY_PATHS);

export const commonArgs = {
  profile: {
    type: "string",
    description: "Configuration profile",
    valueHint: "name",
  },
  "api-url": {
    type: "string",
    description: "Platform API base URL",
    valueHint: "url",
  },
  "api-key": { type: "string", description: "Bearer token", valueHint: "key" },
  org: { type: "string", description: "Organization ID", valueHint: "id" },
  project: { type: "string", description: "Project ID", valueHint: "id" },
  env: { type: "string", description: "Environment ID", valueHint: "id" },
  workspace: { type: "string", description: "Workspace ID", valueHint: "id" },
  mock: { type: "boolean", description: "Use the local mock transport" },
  live: {
    type: "boolean",
    description: "Use the configured live API transport",
  },
  json: { type: "boolean", description: "Emit JSON output" },
  quiet: { type: "boolean", description: "Suppress successful output" },
  color: {
    type: "boolean",
    description: "Use ANSI color",
    default: true,
    negativeDescription: "Disable ANSI color",
  },
  reveal: { type: "boolean", description: "Reveal one-time secrets in output" },
  yes: {
    type: "boolean",
    description: "Skip destructive-action confirmation",
    alias: ["y"],
  },
  "idempotency-key": {
    type: "string",
    description: "Explicit idempotency key",
    valueHint: "key",
  },
} as const satisfies ArgsDef;

const paginationArgs = {
  cursor: {
    type: "string",
    description: "Pagination cursor",
    valueHint: "cursor",
  },
  "page-size": {
    type: "string",
    description: "Page size",
    valueHint: "number",
  },
} as const satisfies ArgsDef;

export function value(args: LooseArgs, name: string): unknown {
  return (
    args[name] ??
    args[name.replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())]
  );
}

function camelCase(name: string): string {
  return name.replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

export function transformed(input: unknown, transform: CommandArgument["transform"]): unknown {
  if (input === undefined || transform === undefined) return input;
  if (transform === "email-end-user-id") {
    if (typeof input !== "string" || input.trim() === "") {
      throw new CliError("Expected an email address.", ExitCode.validation);
    }
    return emailEndUserId(input);
  }
  if (transform === "csv") {
    if (typeof input !== "string") {
      throw new CliError("Expected a comma-separated value.", ExitCode.validation);
    }
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (transform === "number") {
    const parsed = Number(input);
    if (typeof input !== "string" || input.trim() === "" || !Number.isFinite(parsed)) {
      throw new CliError("Expected a finite numeric value.", ExitCode.validation);
    }
    return parsed;
  }
  if (transform === "negated-boolean") return false;
  if (transform === "null") return null;
  if (typeof input !== "string") {
    throw new CliError("Expected valid JSON input.", ExitCode.validation);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new CliError("Expected valid JSON input.", ExitCode.validation);
  }
}

function repeatedValues(name: string, raw: unknown): readonly string[] {
  return (Array.isArray(raw) ? raw : [raw]).map((entry: unknown) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new CliError(`--${name} must not be empty.`, ExitCode.validation);
    }
    return entry.trim();
  });
}

/** citty keeps only the last occurrence of a flag; recover every value of repeatable flags. */
function withRepeatedArguments(
  spec: ActionSpec,
  args: LooseArgs,
  rawArgs: readonly string[],
): LooseArgs {
  const names = Object.entries(spec.args ?? {}).flatMap(([name, argument]) =>
    argument.repeatable ? [name] : [],
  );
  if (names.length === 0) return args;
  const collected: Record<string, string[]> = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]!;
    if (token === "--") break;
    const separator = token.indexOf("=");
    const option = separator >= 0 ? token.slice(0, separator) : token;
    const name = names.find(
      (candidate) => option === `--${candidate}` || option === `--${camelCase(candidate)}`,
    );
    if (!name) continue;
    const entry = separator >= 0 ? token.slice(separator + 1) : rawArgs[(index += 1)];
    if (entry !== undefined) (collected[name] ??= []).push(entry);
  }
  return Object.keys(collected).length === 0 ? args : { ...args, ...collected };
}

export async function readSecretFile(path: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new CliError(`Unable to read secret file: ${path}`, ExitCode.validation);
  }
  const secret = contents.replace(/\r?\n$/u, "");
  if (!secret) throw new CliError(`Secret file is empty: ${path}`, ExitCode.validation);
  return secret;
}

function parseJsonFile(contents: string, path: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    const lines = contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      throw new CliError(`Import file is empty: ${path}`, ExitCode.validation);
    }
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      throw new CliError(`Import file must contain JSON or NDJSON: ${path}`, ExitCode.validation);
    }
  }
}

async function resolveSpecialInputs(
  spec: ActionSpec,
  args: LooseArgs,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  for (const secretInput of spec.secretInputs ?? []) {
    const direct = value(args, secretInput.directArgument);
    const environmentName = value(args, secretInput.environmentArgument);
    const filePath = value(args, secretInput.fileArgument);
    const selected = [direct, environmentName, filePath].filter(
      (candidate) => typeof candidate === "string" && candidate.length > 0,
    );
    if (selected.length > 1) {
      throw new CliError(
        `Choose one of --${secretInput.directArgument}, --${secretInput.environmentArgument}, or --${secretInput.fileArgument}.`,
        ExitCode.usage,
      );
    }
    let secret: string | undefined;
    if (typeof direct === "string" && direct.length > 0) secret = direct;
    if (typeof environmentName === "string" && environmentName.length > 0) {
      secret = env[environmentName];
      if (!secret) {
        throw new CliError(
          `Environment variable ${environmentName} is not set.`,
          ExitCode.validation,
        );
      }
    }
    if (typeof filePath === "string" && filePath.length > 0)
      secret = await readSecretFile(filePath);
    const conditionallyOptional =
      secretInput.optionalWhen !== undefined &&
      value(args, secretInput.optionalWhen.argument) === secretInput.optionalWhen.equals;
    if (!secret && secretInput.required && !conditionallyOptional) {
      throw new CliError(
        `Provide --${secretInput.environmentArgument} or --${secretInput.fileArgument}.`,
        ExitCode.validation,
      );
    }
    if (secret) {
      if (secretInput.format === "json" || secretInput.format === "json-or-text") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(secret);
        } catch {
          if (secretInput.format === "json-or-text") {
            body[secretInput.bodyField] = secret;
            continue;
          }
          throw new CliError(
            `--${secretInput.directArgument} must contain a JSON credential object.`,
            ExitCode.validation,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          if (secretInput.format === "json-or-text") {
            body[secretInput.bodyField] = secret;
            continue;
          }
          throw new CliError(
            `--${secretInput.directArgument} must contain a JSON credential object.`,
            ExitCode.validation,
          );
        }
        body[secretInput.bodyField] = parsed;
      } else {
        body[secretInput.bodyField] = secret;
      }
    }
  }

  for (const fileInput of spec.fileInputs ?? []) {
    const filePath = value(args, fileInput.argument);
    const hasInline = fileInput.exclusiveWith
      ? value(args, fileInput.exclusiveWith) !== undefined
      : false;
    if (typeof filePath === "string" && filePath.length > 0 && hasInline) {
      throw new CliError(
        `Choose either --${fileInput.argument} or --${fileInput.exclusiveWith}.`,
        ExitCode.usage,
      );
    }
    if (typeof filePath === "string" && filePath.length > 0) {
      let contents: string;
      try {
        contents = await readFile(filePath, "utf8");
      } catch {
        throw new CliError(`Unable to read import file: ${filePath}`, ExitCode.validation);
      }
      body[fileInput.bodyField] =
        fileInput.format === "text" ? contents : parseJsonFile(contents, filePath);
    } else if (fileInput.required && !hasInline) {
      throw new CliError(
        `Provide --${fileInput.argument} or --${fileInput.exclusiveWith}.`,
        ExitCode.validation,
      );
    }
  }
}

export function effectiveContext(context: ResolvedCliContext): ResolvedCliContext {
  if (!context.mock) return context;
  return {
    ...context,
    organizationId: context.organizationId ?? MOCK_TENANCY_CONTEXT.organizationId,
    projectId: context.projectId ?? MOCK_TENANCY_CONTEXT.projectId,
    environmentId: context.environmentId ?? MOCK_TENANCY_CONTEXT.environmentId,
  };
}

export function validateScope(scope: ContextScope, context: ResolvedCliContext) {
  let missing: "environment" | "organization" | "project" | undefined;
  if ((scope === "organization" || scope === "tenant") && !context.organizationId) {
    missing = "organization";
  } else if ((scope === "project" || scope === "tenant") && !context.projectId) {
    missing = "project";
  } else if ((scope === "environment" || scope === "tenant") && !context.environmentId) {
    missing = "environment";
  }
  if (missing) {
    throw new CliError(
      `No ${missing} context is configured. Pass --${missing === "organization" ? "org" : missing === "environment" ? "env" : "project"} or run deployments context set.`,
      ExitCode.validation,
    );
  }
}

export function sdkFor(
  context: ResolvedCliContext,
  options: { readonly signal?: AbortSignal } = {},
): PlatformSdk {
  if (context.mock) return createMockPlatformSdk();
  return createPlatformSdk({
    baseUrl: context.apiUrl,
    ...(context.apiKey ? { apiKey: context.apiKey } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    userAgent: `@agentifiers/deployments-cli/${CLI_VERSION}`,
  });
}

export function platformContext(context: ResolvedCliContext): PlatformContext {
  return {
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.environmentId ? { environmentId: context.environmentId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
  };
}

function tenancyRequestContext(
  path: string,
  scope: ContextScope,
  context: ResolvedCliContext,
): PlatformContext {
  const resolved = platformContext(context);
  if (!TENANCY_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return resolved;
  }
  const scoped: PlatformContext =
    scope === "tenant"
      ? {
          ...(resolved.organizationId ? { organizationId: resolved.organizationId } : {}),
          ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
          ...(resolved.environmentId ? { environmentId: resolved.environmentId } : {}),
        }
      : scope === "organization" && resolved.organizationId
        ? { organizationId: resolved.organizationId }
        : scope === "project" && resolved.projectId
          ? { projectId: resolved.projectId }
          : scope === "environment" && resolved.environmentId
            ? { environmentId: resolved.environmentId }
            : {};
  for (const [field, value] of Object.entries(scoped)) {
    if (value && !PUBLIC_ID_PATTERN.test(value)) {
      throw new CliError(
        `${field} must be a canonical ULID for tenancy commands.`,
        ExitCode.validation,
      );
    }
  }
  return scoped;
}

async function confirmDestructiveAction(
  runtime: CliRuntime,
  args: LooseArgs,
  context: ResolvedCliContext,
) {
  if (args.yes === true || context.mock) return;
  if (!runtime.io.isInteractive || args.json === true) {
    throw new CliError(
      "Destructive live commands require --yes in non-interactive or JSON mode.",
      ExitCode.usage,
    );
  }
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({
    message: "Continue with this destructive live operation?",
  });
  if (prompts.isCancel(answer) || answer !== true)
    throw new CliError("Operation canceled.", ExitCode.canceled);
}

export async function buildRequest(
  spec: ActionSpec,
  args: LooseArgs,
  context: ResolvedCliContext,
  env: NodeJS.ProcessEnv,
): Promise<PlatformRequest> {
  let path = spec.path;
  const body: Record<string, unknown> = { ...spec.fixedBody };
  const query: Record<string, boolean | number | string | undefined> = {};
  for (const [name, argument] of Object.entries(spec.args ?? {})) {
    const raw = value(args, name);
    if (raw === undefined) continue;
    if (
      argument.definition.required === true &&
      typeof raw === "string" &&
      raw.trim().length === 0
    ) {
      throw new CliError(`--${name} must not be empty.`, ExitCode.validation);
    }
    const parsed = argument.repeatable
      ? repeatedValues(name, raw)
      : transformed(raw, argument.transform);
    const field = camelCase(argument.field ?? name);
    if (argument.target === "path") {
      const segment = String(parsed);
      if (segment.trim().length === 0 || segment === "." || segment === "..") {
        throw new CliError(`Path argument --${name} must not be empty.`, ExitCode.validation);
      }
      path = path.replace(`:${field}`, encodeURIComponent(segment));
    } else if (argument.target === "query") {
      if (typeof parsed === "boolean" || typeof parsed === "number" || typeof parsed === "string") {
        query[field] = parsed;
      } else if (parsed !== undefined) {
        query[field] = JSON.stringify(parsed);
      }
    } else if (argument.target === "body") {
      const bodyField = argument.bodyField ?? field;
      if (Object.hasOwn(body, bodyField)) {
        throw new CliError(
          `Conflicting values were provided for ${bodyField}.`,
          ExitCode.validation,
        );
      }
      body[bodyField] = parsed;
    }
  }
  await resolveSpecialInputs(spec, args, body, env);
  let rawBody: Uint8Array | undefined;
  let rawContentType: string | undefined;
  if (spec.rawFileInput) {
    const filePath = value(args, spec.rawFileInput.argument);
    const contentType = value(args, spec.rawFileInput.contentTypeArgument);
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new CliError(`Provide --${spec.rawFileInput.argument}.`, ExitCode.validation);
    }
    if (typeof contentType !== "string" || contentType.trim().length === 0) {
      throw new CliError(
        `Provide --${spec.rawFileInput.contentTypeArgument}.`,
        ExitCode.validation,
      );
    }
    try {
      rawBody = new Uint8Array(await readFile(filePath));
    } catch {
      throw new CliError(`Unable to read upload file: ${filePath}`, ExitCode.validation);
    }
    if (rawBody.byteLength < 1 || rawBody.byteLength > spec.rawFileInput.maximumBytes) {
      throw new CliError(
        `Upload file must contain between 1 and ${spec.rawFileInput.maximumBytes} bytes.`,
        ExitCode.validation,
      );
    }
    if (Object.keys(body).length > 0) {
      throw new CliError(
        "Raw upload commands cannot also contain JSON fields.",
        ExitCode.validation,
      );
    }
    rawContentType = contentType;
  }
  if (path.includes(":")) {
    throw new CliError(`Missing required path argument for ${path}.`, ExitCode.validation);
  }
  if (spec.pagination !== false && (spec.output === "list" || spec.pagination)) {
    const cursor = value(args, "cursor");
    const pageSize = value(args, "page-size");
    const pagination = spec.pagination ?? {
      limitField: "pageSize",
      target: "query" as const,
    };
    const maxLimit = pagination.maxLimit ?? 200;
    const paginationValues = pagination.target === "body" ? body : query;
    if (typeof cursor === "string") paginationValues.cursor = cursor;
    if (typeof pageSize === "string") {
      if (!/^\d+$/u.test(pageSize)) {
        throw new CliError(
          `--page-size must be an integer between 1 and ${maxLimit}.`,
          ExitCode.validation,
        );
      }
      const parsed = Number(pageSize);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxLimit) {
        throw new CliError(
          `--page-size must be an integer between 1 and ${maxLimit}.`,
          ExitCode.validation,
        );
      }
      paginationValues[pagination.limitField] = parsed;
    }
  }
  const requestContext = tenancyRequestContext(path, spec.scope, context);
  const requestBody = spec.shapeBody ? spec.shapeBody(body) : body;
  return {
    method: spec.method,
    path,
    context: requestContext,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(requestBody).length > 0 ? { body: requestBody } : {}),
    ...(rawBody ? { contentType: rawContentType!, rawBody } : {}),
    ...(spec.idempotent
      ? {
          idempotencyKey: idempotencyKey(args, spec.requiresExplicitIdempotencyKey ?? false),
        }
      : {}),
  };
}

export function commandArgs(spec: ActionSpec): ArgsDef {
  const actionArgs = Object.fromEntries(
    Object.entries(spec.args ?? {}).map(([name, argument]) => [name, argument.definition]),
  ) as ArgsDef;
  return {
    ...commonArgs,
    ...(spec.pagination !== false && (spec.output === "list" || spec.pagination)
      ? paginationArgs
      : {}),
    ...actionArgs,
  };
}

export function idempotencyKey(args: LooseArgs, required = false): string {
  const configured = value(args, "idempotency-key");
  if (configured === undefined) {
    if (required) {
      throw new CliError(
        "--idempotency-key is required for this multi-phase operation.",
        ExitCode.validation,
      );
    }
    return randomUUID();
  }
  if (typeof configured !== "string" || configured.trim().length === 0) {
    throw new CliError("--idempotency-key must not be empty.", ExitCode.validation);
  }
  return configured;
}

export function actionCommand(spec: ActionSpec, runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: {
      description: spec.summary,
      ...(spec.aliases ? { alias: [...spec.aliases] } : {}),
    },
    args: commandArgs(spec),
    async run({ args, rawArgs }) {
      const context = effectiveContext(
        await resolveContext(args, runtime.env, {
          refreshDeviceCredential: true,
        }),
      );
      validateScope(spec.scope, context);
      if (spec.destructive) await confirmDestructiveAction(runtime, args, context);
      const request = await buildRequest(
        spec,
        withRepeatedArguments(spec, args, rawArgs),
        context,
        runtime.env,
      );
      const sdk = sdkFor(context);
      if (spec.output === "stream") {
        if (context.mock && args.json !== true && args.quiet !== true) {
          runtime.io.stdout(
            colorEnabled(args, runtime) ? pc.bgYellow(pc.black(" MOCK ")) : "[MOCK]",
          );
        }
        for await (const event of sdk.stream(request)) {
          renderStreamEvent({
            data: event,
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: args.reveal === true,
            context,
            ...(spec.sensitiveOutput ? { sensitive: true } : {}),
            ...(spec.sensitiveOutputFields ? { sensitiveFields: spec.sensitiveOutputFields } : {}),
          });
        }
        return;
      }
      const response = spec.send ? await spec.send(sdk, request) : await sdk.request(request);
      renderOutput({
        data: response.data,
        io: runtime.io,
        json: args.json === true,
        quiet: args.quiet === true,
        color: colorEnabled(args, runtime),
        reveal: args.reveal === true,
        kind: spec.output,
        ...(spec.listField ? { listField: spec.listField } : {}),
        ...(spec.columns ? { columns: spec.columns } : {}),
        requestId: response.requestId,
        context,
        ...(spec.sensitiveOutput ? { sensitive: true } : {}),
        ...(spec.sensitiveOutputFields ? { sensitiveFields: spec.sensitiveOutputFields } : {}),
      });
    },
  });
}
