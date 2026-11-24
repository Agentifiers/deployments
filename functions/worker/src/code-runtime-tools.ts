import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import type { SandboxManagerService, SandboxProviderName } from "@deployments-ai/sandbox-hosts";
import {
  CODE_EXECUTE_DEFAULT_TIMEOUT_MS,
  CODE_EXECUTE_MAX_SOURCE_BYTES,
  CODE_EXECUTE_MAX_TIMEOUT_MS,
  CODE_EXECUTE_TOOL_NAME,
} from "@deployments-ai/tools";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { optionalInteger, toolInput } from "./builtin-tool-support.ts";
import {
  codeOutputArtifact,
  executeInAgentSandbox,
  persistedCodeOutput,
  resultText,
  runSource,
  structuredOutput,
  summary,
  type CodeLanguage,
} from "./code-runtime-primitives.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export interface RuntimeCodeToolOptions {
  readonly manager: SandboxManagerService;
  readonly providerName: SandboxProviderName;
  readonly threadSandbox?: ThreadSandboxWorkspace;
}

function language(value: unknown): CodeLanguage {
  if (value === "bash" || value === "javascript" || value === "python") return value;
  throw new TypeError("language must be bash, javascript, or python.");
}

function sourceCode(input: Readonly<Record<string, unknown>>) {
  const value = input.code;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("code must be a non-empty string.");
  }
  if (new TextEncoder().encode(value).byteLength > CODE_EXECUTE_MAX_SOURCE_BYTES) {
    throw new TypeError("code is too long.");
  }
  return value;
}

/** Thread sandboxes run many calls per VM, so each thread call stages its own source file. */
function sourcePath(languageName: CodeLanguage, threadToolCallId?: string) {
  const extension = languageName === "javascript" ? "js" : languageName === "python" ? "py" : "sh";
  return threadToolCallId
    ? `/tmp/deployments-ai-code-${threadToolCallId}.${extension}`
    : `/tmp/deployments-ai-code.${extension}`;
}

const artifactNaming = { fileNamePrefix: "code-execute", label: "Sandboxed code output" } as const;

export function createRuntimeCodeBuiltinExecutors(
  options: RuntimeCodeToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const executeCode = async (
    request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  ): Promise<Awaited<ReturnType<ExecuteRuntimeBuiltinTool>>> => {
    const input = toolInput(request.input ?? {});
    const source = sourceCode(input);
    const languageName = language(input.language);
    const timeoutMs =
      optionalInteger(input, "timeoutMs", {
        maximum: CODE_EXECUTE_MAX_TIMEOUT_MS,
        minimum: 100,
      }) ?? CODE_EXECUTE_DEFAULT_TIMEOUT_MS;

    const result = await executeInAgentSandbox({
      manager: options.manager,
      providerName: options.providerName,
      request,
      run: (sandbox, placement) =>
        runSource(options.manager, {
          ...(placement.cwd ? { cwd: placement.cwd } : {}),
          languageName,
          path: sourcePath(languageName, placement.threadToolCallId),
          sandbox,
          ...(request.signal ? { signal: request.signal } : {}),
          source,
          timeoutMs,
        }),
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
      toolName: CODE_EXECUTE_TOOL_NAME,
    });
    const rendered = resultText(result);
    const output = structuredOutput(result);
    const artifact = codeOutputArtifact({
      ...artifactNaming,
      languageName,
      rendered,
      result,
      toolCallId: request.decision.toolCallId,
    });
    return {
      artifacts: [artifact],
      output,
      outputSummary: summary(
        `Sandboxed code exited ${result.exitCode} in ${result.durationMs} ms.`,
        rendered.artifact,
      ),
      status: "completed",
    };
  };
  return {
    [CODE_EXECUTE_TOOL_NAME]: Object.assign(executeCode, {
      mutationClaimResult: (result: RuntimeToolExecutionResult) => ({
        artifacts: [],
        ...(result.output ? { output: result.output } : {}),
        ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
        status: result.status,
      }),
      refreshReplay: async (
        request: Parameters<ExecuteRuntimeBuiltinTool>[0],
        _definition: Parameters<NonNullable<ExecuteRuntimeBuiltinTool["refreshReplay"]>>[1],
        persisted: RuntimeToolExecutionResult,
      ) => {
        const output = persistedCodeOutput(persisted.output);
        const input = toolInput(request.input ?? {});
        const languageName = language(input.language);
        const rendered = resultText(output);
        return {
          ...persisted,
          artifacts: [
            codeOutputArtifact({
              ...artifactNaming,
              languageName,
              rendered,
              result: output,
              toolCallId: request.decision.toolCallId,
            }),
          ],
          output,
        };
      },
    }),
  };
}
