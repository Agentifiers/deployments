import { PlatformApiError } from "@agentifiers/deployments-sdk";
import { defineCommand } from "citty";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { resolveContext } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { renderOutput } from "./output.ts";
import {
  colorEnabled,
  commonArgs,
  effectiveContext,
  idempotencyKey,
  platformContext,
  readSecretFile,
  sdkFor,
  transformed,
  validateScope,
  value,
  type AnyCommand,
  type CliRuntime,
  type LooseArgs,
} from "./command-runtime.ts";

type SourceLanguage = "javascript" | "python" | "typescript";

const SOURCE_LANGUAGES: Readonly<Record<string, SourceLanguage>> = {
  ".cjs": "javascript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".mts": "typescript",
  ".py": "python",
  ".ts": "typescript",
};

const EXECUTION_OPTION_FIELDS = {
  entrypoint: "entrypoint",
  "memory-mib": "memoryMiB",
  network: "network",
  "timeout-ms": "timeoutMs",
} as const;

const toolUploadArgs = {
  ...commonArgs,
  file: { type: "positional", description: "Tool source file (.js, .mjs, .ts, .py)" },
  name: { type: "string", description: "Extension tool name", required: true },
  description: { type: "string", description: "Tool description (required when creating)" },
  effect: { type: "string", description: "read, write, or execute (default read on create)" },
  "default-action": {
    type: "string",
    description: "allow, require_approval, or deny (default allow on create)",
  },
  scopes: { type: "string", description: "Required scopes JSON array (default [] on create)" },
  language: { type: "string", description: "javascript, typescript, or python (from extension)" },
  entrypoint: { type: "string", description: "Exported handler name (default handler)" },
  "input-schema": { type: "string", description: "JSON input schema, inline or file path" },
  "output-schema": { type: "string", description: "JSON output schema, inline or file path" },
  "timeout-ms": { type: "string", description: "Execution timeout in milliseconds" },
  "memory-mib": { type: "string", description: "Execution memory in MiB" },
  network: { type: "string", description: "none or sandbox" },
  secret: {
    type: "string",
    description: "Secret NAME (from env NAME), NAME=env:VAR, or NAME=file:PATH; repeatable",
  },
} as const;

function optionalString(args: LooseArgs, name: string): string | undefined {
  const raw = value(args, name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CliError(`--${name} must not be empty.`, ExitCode.validation);
  }
  return raw;
}

export function sourceLanguage(filePath: string, explicit: string | undefined): SourceLanguage {
  if (explicit !== undefined) {
    if (explicit === "javascript" || explicit === "python" || explicit === "typescript") {
      return explicit;
    }
    throw new CliError("--language must be javascript, typescript, or python.", ExitCode.usage);
  }
  const inferred = SOURCE_LANGUAGES[extname(filePath).toLowerCase()];
  if (!inferred) {
    throw new CliError(
      `Cannot infer the language of ${filePath}; pass --language.`,
      ExitCode.validation,
    );
  }
  return inferred;
}

/** Accepts inline JSON or a path to a JSON file, matching the CLI inline-or-file convention. */
export async function jsonOrFile(argument: string, input: string): Promise<unknown> {
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return transformed(trimmed, "json");
  let contents: string;
  try {
    contents = await readFile(input, "utf8");
  } catch {
    throw new CliError(
      `--${argument} must be inline JSON or a readable JSON file: ${input}`,
      ExitCode.validation,
    );
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new CliError(`--${argument} file must contain JSON: ${input}`, ExitCode.validation);
  }
}

/** Secret values are only read from the environment or files so they never land in shell history. */
export async function resolveSecrets(
  specs: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const spec of specs) {
    const separator = spec.indexOf("=");
    const name = separator >= 0 ? spec.slice(0, separator) : spec;
    const source = separator >= 0 ? spec.slice(separator + 1) : `env:${name}`;
    if (!name) throw new CliError("--secret requires a NAME.", ExitCode.usage);
    if (Object.hasOwn(secrets, name)) {
      throw new CliError(`Secret ${name} was provided more than once.`, ExitCode.usage);
    }
    if (source.startsWith("env:")) {
      const variable = source.slice("env:".length);
      const secret = variable ? env[variable] : undefined;
      if (!secret) {
        throw new CliError(`Environment variable ${variable} is not set.`, ExitCode.validation);
      }
      secrets[name] = secret;
    } else if (source.startsWith("file:")) {
      secrets[name] = await readSecretFile(source.slice("file:".length));
    } else {
      throw new CliError(
        `--secret ${name} must use NAME, NAME=env:VAR, or NAME=file:PATH.`,
        ExitCode.usage,
      );
    }
  }
  return secrets;
}

/** citty keeps only the last value of a repeated option, so repeated flags are read from raw argv. */
export function repeatedOption(rawArgs: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]!;
    if (token === "--") break;
    if (token === `--${name}`) {
      const next = rawArgs[index + 1];
      if (next !== undefined) values.push(next);
      index += 1;
    } else if (token.startsWith(`--${name}=`)) {
      values.push(token.slice(name.length + 3));
    }
  }
  return values;
}

async function existingTool(
  request: (path: string) => Promise<Record<string, unknown>>,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await request(path);
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return undefined;
    throw error;
  }
}

/** `tool upload`; merged into the catalog-driven `tool` command. */
export function toolUploadCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: {
      description: "Upload hosted code and create or update its extension tool",
    },
    args: toolUploadArgs,
    async run({ args, rawArgs }) {
      const context = effectiveContext(
        await resolveContext(args, runtime.env, { refreshDeviceCredential: true }),
      );
      validateScope("environment", context);
      const filePath = optionalString(args, "file");
      if (!filePath) throw new CliError("Provide the tool source file.", ExitCode.usage);
      const toolName = optionalString(args, "name")!;
      const language = sourceLanguage(filePath, optionalString(args, "language"));
      let source: string;
      try {
        source = await readFile(filePath, "utf8");
      } catch {
        throw new CliError(`Unable to read tool source: ${filePath}`, ExitCode.validation);
      }

      const options: Record<string, unknown> = {};
      for (const [argument, field] of Object.entries(EXECUTION_OPTION_FIELDS)) {
        const raw = optionalString(args, argument);
        if (raw === undefined) continue;
        options[field] =
          field === "memoryMiB" || field === "timeoutMs" ? transformed(raw, "number") : raw;
      }
      const body: Record<string, unknown> = {};
      for (const [argument, field] of [
        ["input-schema", "inputSchema"],
        ["output-schema", "outputSchema"],
      ] as const) {
        const raw = optionalString(args, argument);
        if (raw !== undefined) body[field] = await jsonOrFile(argument, raw);
      }
      const secretSpecs = repeatedOption(rawArgs, "secret");
      if (secretSpecs.length > 0) {
        body.secrets = await resolveSecrets(secretSpecs, runtime.env);
      }
      const description = optionalString(args, "description");
      if (description !== undefined) body.description = description;
      const effect = optionalString(args, "effect");
      if (effect !== undefined) body.effect = effect;
      const defaultAction = optionalString(args, "default-action");
      if (defaultAction !== undefined) body.defaultPolicyAction = defaultAction;
      const scopes = optionalString(args, "scopes");
      if (scopes !== undefined) body.requiredScopes = transformed(scopes, "json");

      const sdk = sdkFor(context);
      const requestContext = platformContext(context);
      const key = idempotencyKey(args);
      const artifact = await sdk.request<Record<string, unknown>>({
        method: "POST",
        path: "/v1/hosted-code-artifacts",
        context: requestContext,
        body: { language, source },
        idempotencyKey: `${key}-artifact`,
      });
      const toolPath = `/v1/extensions/${encodeURIComponent(toolName)}`;
      const existing = await existingTool(
        async (path) =>
          (
            await sdk.request<Record<string, unknown>>({
              method: "GET",
              path,
              context: requestContext,
            })
          ).data,
        toolPath,
      );

      let response;
      if (existing) {
        const current = existing.execution as Record<string, unknown> | undefined;
        if (current?.type !== "hosted_code") {
          throw new CliError(
            `Extension tool ${toolName} is not a hosted code tool.`,
            ExitCode.validation,
          );
        }
        response = await sdk.request({
          method: "PATCH",
          path: toolPath,
          context: requestContext,
          idempotencyKey: `${key}-extension`,
          body: {
            ...body,
            expectedVersion: existing.version,
            execution: {
              entrypoint: current.entrypoint,
              memoryMiB: current.memoryMiB,
              network: current.network,
              timeoutMs: current.timeoutMs,
              ...options,
              contentHash: artifact.data.contentHash,
              type: "hosted_code",
            },
          },
        });
      } else {
        for (const [field, flag] of [
          ["description", "description"],
          ["inputSchema", "input-schema"],
          ["outputSchema", "output-schema"],
        ] as const) {
          if (body[field] === undefined) {
            throw new CliError(
              `--${flag} is required when creating ${toolName}.`,
              ExitCode.validation,
            );
          }
        }
        response = await sdk.request({
          method: "POST",
          path: "/v1/extensions",
          context: requestContext,
          idempotencyKey: `${key}-extension`,
          body: {
            defaultPolicyAction: "allow",
            effect: "read",
            requiredScopes: [],
            ...body,
            name: toolName,
            execution: {
              ...options,
              contentHash: artifact.data.contentHash,
              type: "hosted_code",
            },
          },
        });
      }
      renderOutput({
        data: response.data,
        io: runtime.io,
        json: args.json === true,
        quiet: args.quiet === true,
        color: colorEnabled(args, runtime),
        reveal: args.reveal === true,
        kind: "detail",
        requestId: response.requestId,
        context,
      });
    },
  });
}
