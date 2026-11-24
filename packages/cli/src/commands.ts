import { type PlatformRequest } from "@agentifiers/deployments-sdk";
import { defineCommand, type SubCommandsDef } from "citty";
import pc from "picocolors";
import { commandCatalog, commandNamespaces } from "./catalog.ts";
import { resolveContext } from "./config.ts";
import { CliError, ExitCode } from "./errors.ts";
import { renderOutput, renderStreamEvent } from "./output.ts";
import type { ActionSpec } from "./types.ts";
import { CLI_VERSION } from "./version.ts";
import { readRunStream, TERMINAL_RUN_EVENT_TYPES } from "./run-stream.ts";
import { devCommand } from "./dev/command.ts";

import type { CliRuntime, AnyCommand } from "./command-runtime.ts";
import {
  colorEnabled,
  commonArgs,
  value,
  effectiveContext,
  validateScope,
  sdkFor,
  platformContext,
  actionCommand,
  commandArgs,
} from "./command-runtime.ts";
import { chatCommand } from "./chat-command.ts";
import { authCommand, contextCommand } from "./profile-commands.ts";
import { toolUploadCommand } from "./hosted-code-tool-command.ts";

export type { CliRuntime } from "./command-runtime.ts";

function resourceCommands(runtime: CliRuntime): SubCommandsDef {
  const actionCommands = (resourceName: string, actions: Readonly<Record<string, ActionSpec>>) =>
    Object.fromEntries(
      Object.entries(actions).map(([actionName, spec]) => [
        actionName,
        resourceName === "run" && actionName === "tail"
          ? runTailCommand(spec, runtime)
          : actionCommand(spec, runtime),
      ]),
    );
  const namespaced: Record<string, Record<string, AnyCommand>> = {};
  for (const [resourceName, resource] of Object.entries(commandCatalog)) {
    if (!resource.namespace) continue;
    const group = (namespaced[resource.namespace.name] ??= {});
    group[resource.namespace.command] = defineCommand({
      meta: { description: resource.summary },
      subCommands: actionCommands(resourceName, resource.actions),
    });
  }
  const topLevel: Record<string, AnyCommand> = {};
  for (const [resourceName, resource] of Object.entries(commandCatalog)) {
    if (resource.namespace) continue;
    const nested = namespaced[resourceName] ?? {};
    const clash = Object.keys(nested).find((command) => Object.hasOwn(resource.actions, command));
    if (clash) {
      throw new Error(`Command ${resourceName} ${clash} is both an action and a resource.`);
    }
    topLevel[resourceName] = defineCommand({
      meta: { description: resource.summary },
      subCommands: {
        ...actionCommands(resourceName, resource.actions),
        ...nested,
        ...(resourceName === "tool" ? { upload: toolUploadCommand(runtime) } : {}),
      },
    });
  }
  for (const [name, resources] of Object.entries(namespaced)) {
    if (Object.hasOwn(topLevel, name)) continue;
    const description = commandNamespaces[name];
    if (!description) {
      throw new Error(`Command namespace ${name} needs a summary.`);
    }
    topLevel[name] = defineCommand({ meta: { description }, subCommands: resources });
  }
  return topLevel;
}

function runTailCommand(spec: ActionSpec, runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: { description: spec.summary },
    args: commandArgs(spec),
    async run({ args }) {
      const context = effectiveContext(
        await resolveContext(args, runtime.env, { refreshDeviceCredential: true }),
      );
      validateScope(spec.scope, context);
      const runId = value(args, "id");
      const threadId = value(args, "thread");
      if (typeof runId !== "string" || !runId.trim()) {
        throw new CliError("Run ID must not be empty.", ExitCode.validation);
      }
      if (typeof threadId !== "string" || !threadId.trim()) {
        throw new CliError("--thread must not be empty.", ExitCode.validation);
      }
      const runtimeSdk = sdkFor(context).runtime(platformContext(context));
      await runtimeSdk.runs.get(threadId, runId);
      const cursor = value(args, "cursor");
      const offset = value(args, "offset");
      await readRunStream({
        runtime: runtimeSdk,
        threadId,
        runId,
        follow: value(args, "follow") === true,
        position: {
          ...(typeof cursor === "string" ? { cursor } : {}),
          offset: typeof offset === "string" ? offset : "-1",
        },
        onEvent: (event) => {
          renderStreamEvent({
            data: event,
            io: runtime.io,
            json: args.json === true,
            quiet: args.quiet === true,
            color: colorEnabled(args, runtime),
            reveal: args.reveal === true,
            context,
          });
          return TERMINAL_RUN_EVENT_TYPES[String(event.eventType)] === true;
        },
      });
    },
  });
}

function simpleRequestCommand(
  runtime: CliRuntime,
  name: string,
  description: string,
  request: PlatformRequest,
  refreshDeviceCredential = true,
): AnyCommand {
  return defineCommand({
    meta: { name, description },
    args: commonArgs,
    async run({ args }) {
      const context = effectiveContext(
        await resolveContext(args, runtime.env, { refreshDeviceCredential }),
      );
      const response = await sdkFor(context).request({
        ...request,
        context: platformContext(context),
      });
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

function catalogCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: { description: "Print the complete public CLI command catalog" },
    args: { json: commonArgs.json, quiet: commonArgs.quiet, color: commonArgs.color },
    run({ args }) {
      if (args.quiet === true) return;
      const rows = [
        { command: "deployments auth login", summary: "Log in to a CLI profile" },
        { command: "deployments auth logout", summary: "Remove profile credentials" },
        { command: "deployments context show", summary: "Show the active CLI context" },
        { command: "deployments context set", summary: "Set persistent CLI context" },
        { command: "deployments context clear", summary: "Clear persistent resource context" },
        { command: "deployments whoami", summary: "Show the authenticated identity" },
        { command: "deployments chat", summary: "Send a chat message to an agent deployment" },
        {
          command: "deployments dev",
          summary: "Chat with a local agent manifest through a temporary preview",
        },
        { command: "deployments health", summary: "Check public API health" },
        { command: "deployments openapi", summary: "Fetch the public OpenAPI document" },
        { command: "deployments catalog", summary: "Print the complete CLI command catalog" },
        {
          command: "deployments tool upload",
          summary: "Upload hosted code and create or update its extension tool",
        },
        ...Object.entries(commandCatalog).flatMap(([resource, definition]) =>
          Object.entries(definition.actions).map(([command, actionDefinition]) => ({
            command: `deployments ${
              definition.namespace
                ? `${definition.namespace.name} ${definition.namespace.command}`
                : resource
            } ${command}`,
            summary: actionDefinition.summary,
          })),
        ),
      ];
      if (args.json === true) {
        runtime.io.stdout(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        runtime.io.stdout(
          `${colorEnabled(args, runtime) ? pc.cyan(row.command) : row.command}\n  ${row.summary}`,
        );
      }
    },
  });
}

export function createRootCommand(runtime: CliRuntime): AnyCommand {
  const subCommands: SubCommandsDef = {
    auth: authCommand(runtime),
    context: contextCommand(runtime),
    whoami: simpleRequestCommand(runtime, "whoami", "Show the authenticated identity", {
      method: "GET",
      path: "/v1/whoami",
    }),
    dev: devCommand(runtime),
    chat: chatCommand(runtime),
    health: simpleRequestCommand(
      runtime,
      "health",
      "Check public API health",
      {
        method: "GET",
        path: "/health",
      },
      false,
    ),
    openapi: simpleRequestCommand(
      runtime,
      "openapi",
      "Fetch the public OpenAPI document",
      {
        method: "GET",
        path: "/v1/openapi.json",
      },
      false,
    ),
    catalog: catalogCommand(runtime),
    ...resourceCommands(runtime),
  };
  return defineCommand({
    meta: {
      name: "deployments",
      version: CLI_VERSION,
      description: "Deployments.ai platform control plane",
    },
    subCommands,
  });
}
