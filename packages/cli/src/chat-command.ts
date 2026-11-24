import {
  INPUT_ARTIFACT_TYPE,
  INPUT_FILE_PROBLEMS,
  MAX_INPUT_ARTIFACT_BYTES,
  MAX_INPUT_ARTIFACTS,
  MAX_TOTAL_INPUT_MEDIA_BYTES,
  inputFileHint,
  type InputFileMediaType,
} from "@deployments-ai/agent-manifest";
import { validatedIdempotencyKey } from "@agentifiers/deployments-sdk";
import { defineCommand } from "citty";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolveContext } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { renderOutput } from "./output.ts";
import {
  colorEnabled,
  commonArgs,
  effectiveContext,
  idempotencyKey,
  platformContext,
  sdkFor,
  validateScope,
  value,
  type AnyCommand,
  type CliRuntime,
} from "./command-runtime.ts";
import { repeatedOption } from "./hosted-code-tool-command.ts";

const CHAT_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const UNHINTED_CONTENT_TYPE = "application/octet-stream";

interface ChatFile {
  readonly bytes: Uint8Array;
  readonly contentType: InputFileMediaType | typeof UNHINTED_CONTENT_TYPE;
  readonly fileName: string;
}

function cannotAttach(name: string, copy: string) {
  return new CliError(`${name} can't be attached: ${copy}`, ExitCode.validation);
}

async function readChatFiles(paths: readonly string[]): Promise<readonly ChatFile[]> {
  if (paths.length > MAX_INPUT_ARTIFACTS) {
    throw new CliError(`Chat accepts at most ${MAX_INPUT_ARTIFACTS} files.`, ExitCode.validation);
  }
  const files: ChatFile[] = [];
  let mediaBytes = 0;
  for (const path of paths) {
    const file = await stat(path).catch(() => undefined);
    if (!file?.isFile()) throw new CliError(`Unable to read file: ${path}`, ExitCode.validation);
    if (file.size > MAX_INPUT_ARTIFACT_BYTES) {
      throw cannotAttach(path, INPUT_FILE_PROBLEMS.too_large.copy);
    }
    const fileName = basename(path);
    const hint = inputFileHint({ fileName });
    if (hint?.kind === "unsupported") {
      throw cannotAttach(path, INPUT_FILE_PROBLEMS[hint.reason].copy);
    }
    if (hint?.kind === "image" || hint?.kind === "audio") mediaBytes += file.size;
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) throw new CliError(`Unable to read file: ${path}`, ExitCode.validation);
    files.push({ bytes, contentType: hint?.mediaType ?? UNHINTED_CONTENT_TYPE, fileName });
  }
  if (mediaBytes > MAX_TOTAL_INPUT_MEDIA_BYTES) {
    throw new CliError(
      `The attached images and audio total more than ${MAX_TOTAL_INPUT_MEDIA_BYTES / MIB} MiB.`,
      ExitCode.validation,
    );
  }
  return files;
}

export function chatCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: { name: "chat", description: "Send a chat message to an agent deployment" },
    args: {
      ...commonArgs,
      message: { type: "string", description: "Message content", required: true },
      thread: { type: "string", description: "Existing thread ID" },
      agent: { type: "string", description: "Agent deployment ID" },
      file: {
        type: "string",
        description: `File to attach: PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown, JSON, HTML, ZIP, or a JPEG, PNG, or WebP image (repeatable, at most ${MAX_INPUT_ARTIFACTS})`,
        valueHint: "path",
      },
    },
    async run({ args, rawArgs }) {
      const context = effectiveContext(
        await resolveContext(args, runtime.env, { refreshDeviceCredential: true }),
      );
      validateScope("environment", context);
      const message = value(args, "message");
      if (typeof message !== "string" || message.trim().length === 0) {
        throw new CliError(
          "Chat requires a non-empty --message in non-interactive command mode.",
          ExitCode.validation,
        );
      }
      const agent = value(args, "agent");
      if (typeof agent !== "string" || agent.trim().length === 0) {
        throw new CliError("Chat requires a non-empty --agent.", ExitCode.validation);
      }
      const key = validatedIdempotencyKey(idempotencyKey(args), "Agent run submission");
      const files = await readChatFiles(repeatedOption(rawArgs, "file"));
      const runtimeSdk = sdkFor(context).runtime(platformContext(context));
      const thread = value(args, "thread");
      let threadId = typeof thread === "string" ? thread : undefined;
      const workspace = context.workspaceId ? { workspaceId: context.workspaceId } : {};
      const inputArtifacts: string[] = [];
      if (files.length > 0) {
        threadId ??= (await runtimeSdk.threads.create({ agentDeploymentId: agent, ...workspace }))
          .data.id;
        const retentionExpiresAt = new Date(Date.now() + CHAT_FILE_RETENTION_MS).toISOString();
        for (const file of files) {
          const uploaded = await runtimeSdk.artifacts.uploadBytes({
            ...file,
            name: file.fileName,
            retentionExpiresAt,
            threadId,
            type: INPUT_ARTIFACT_TYPE,
          });
          const input = uploaded.data.input;
          if (input?.kind === "unusable") throw cannotAttach(file.fileName, input.message);
          inputArtifacts.push(uploaded.data.artifactId);
        }
      }
      const response = await runtimeSdk.runs.submit(
        agent,
        {
          content: message,
          ...(threadId === undefined ? {} : { threadId }),
          ...(inputArtifacts.length > 0 ? { inputArtifacts } : {}),
          ...workspace,
        },
        { idempotencyKey: key },
      );
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
