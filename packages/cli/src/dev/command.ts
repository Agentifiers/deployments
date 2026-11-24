import * as prompts from "@clack/prompts";
import type { RunResponse } from "@deployments-ai/api-contract/runtime";
import { defineCommand } from "citty";
import {
  colorEnabled,
  effectiveContext,
  platformContext,
  sdkFor,
  validateScope,
  type AnyCommand,
  type CliRuntime,
} from "../command-runtime.ts";
import { resolveContext } from "../config.ts";
import { CliError, errorMessage, ExitCode } from "../errors.ts";
import { sanitizeTerminalText } from "../output.ts";
import { devArgs, parseDevOptions, type DevRuntimeConfigSource } from "./args.ts";
import { loadManifest, loadRuntimeConfig } from "./manifest.ts";
import { clackInteraction, promptMessage } from "./prompts.ts";
import { DevRenderer } from "./render.ts";
import { PreviewSession, type PreviewSessionOptions } from "./session.ts";
import { runTurn, unsuccessfulRunMessage } from "./turn.ts";

async function previewConfiguration(
  source: DevRuntimeConfigSource,
): Promise<PreviewSessionOptions["configuration"]> {
  if (source.type === "file") return { runtimeConfig: await loadRuntimeConfig(source.path) };
  if (source.type === "deployment") return { fromAgentDeploymentId: source.agentDeploymentId };
  return {};
}

export function devCommand(runtime: CliRuntime): AnyCommand {
  return defineCommand({
    meta: {
      name: "dev",
      description: "Chat with a local agent manifest through a temporary preview",
    },
    args: devArgs,
    async run({ args }) {
      const options = parseDevOptions(args);
      const context = effectiveContext(
        await resolveContext(args, runtime.env, { refreshDeviceCredential: true }),
      );
      validateScope("environment", context);
      if (options.message === undefined && !runtime.io.isInteractive) {
        throw new CliError(
          "Interactive dev sessions need a terminal; pass --message for one-shot mode.",
          ExitCode.usage,
        );
      }
      const renderer = new DevRenderer(runtime.io, colorEnabled(args, runtime));
      const interrupt = new AbortController();
      // Preview lifecycle requests stay outside the interrupt so Ctrl-C can still expire it.
      const previews = sdkFor(context).runtime(platformContext(context)).previews;
      const turnRuntime = sdkFor(context, { signal: interrupt.signal }).runtime(
        platformContext(context),
      );
      const session = new PreviewSession({
        previews,
        manifestPath: options.manifestPath,
        loadManifest,
        configuration: await previewConfiguration(options.runtimeConfig),
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
        notify: (message) => renderer.notice(message),
      });
      const interaction = runtime.io.isInteractive ? clackInteraction : undefined;
      const turn = async (content: string): Promise<RunResponse> => {
        const submitted = await session.submitTurn(content);
        return runTurn({
          runtime: turnRuntime,
          threadId: submitted.thread.id,
          runId: submitted.run.id,
          renderer,
          interaction,
        });
      };
      const onInterrupt = () => interrupt.abort();
      process.once("SIGINT", onInterrupt);
      try {
        const preview = await session.start();
        renderer.notice(
          `Preview ${preview.id} (${sanitizeTerminalText(preview.agentName)}) expires ${preview.expiresAt}.`,
        );
        if (options.message !== undefined) {
          const run = await turn(options.message);
          const failure = unsuccessfulRunMessage(run);
          if (failure) {
            throw new CliError(
              failure,
              run.status === "canceled" ? ExitCode.canceled : ExitCode.unexpected,
            );
          }
          return;
        }
        prompts.intro(`deployments dev · ${sanitizeTerminalText(preview.agentName)}`);
        while (true) {
          const message = await promptMessage();
          if (message === undefined) break;
          try {
            const failure = unsuccessfulRunMessage(await turn(message));
            if (failure) renderer.warning(failure);
          } catch (error) {
            if (interrupt.signal.aborted) throw error;
            if (error instanceof CliError && error.exitCode === ExitCode.canceled) throw error;
            renderer.warning(`Turn failed: ${errorMessage(error)}`);
          }
        }
        prompts.outro("Session ended.");
      } catch (error) {
        if (interrupt.signal.aborted) throw new CliError("Operation canceled.", ExitCode.canceled);
        throw error;
      } finally {
        process.off("SIGINT", onInterrupt);
        const preview = session.preview;
        try {
          await session.close();
          if (preview) renderer.notice(`Preview ${preview.id} expired.`);
        } catch (error) {
          renderer.warning(`Could not expire preview ${preview?.id}: ${errorMessage(error)}`);
        }
      }
    },
  });
}
