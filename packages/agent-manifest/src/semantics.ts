import { Schema } from "effect";
import {
  type AgentDeploymentConfigV1,
  AgentManifestV1,
  MAX_AGENT_MANIFEST_UTF8_BYTES,
  MAX_AGENT_SKILL_COUNT,
  MAX_AGENT_TOOL_INPUT_DEPTH,
  MAX_AGENT_TOOL_INPUT_UTF8_BYTES,
  type JsonValue,
} from "./schema.ts";
import { ATTACHMENT_READ_TOOL } from "./input-files.ts";
import { jsonValueDepthExceeds } from "./json.ts";
import { responseFormatSemanticIssues } from "./response-format-semantics.ts";
import { agentBindingSemanticIssues, subAgentSemanticIssues } from "./sub-agent-semantics.ts";

export interface AgentManifestSemanticIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const textEncoder = new TextEncoder();

// Mirrors SANDBOX_FILE_TOOL_NAMES and COMPUTER_TOOL_NAMES in @deployments-ai/tools; the manifest
// package has no workspace dependencies, so the names are restated here. The computer tools drive
// one desktop that must outlive each call, so they need a thread-persistent sandbox too.
const THREAD_SANDBOX_FILE_TOOL_NAMES: Readonly<Record<string, true>> = {
  "computer.action": true,
  "computer.screenshot": true,
  "sandbox.files.list": true,
  "sandbox.files.read": true,
  "sandbox.files.write": true,
};

// Mirrors the sandboxed browser executors in functions/worker; these tools run Chromium inside
// the agent's Lambda MicroVM sandbox.
const SANDBOX_BROWSER_TOOL_NAMES: Readonly<Record<string, true>> = {
  "browser.capture_screenshot": true,
  "browser.screenshot.capture": true,
  "browser.session.execute": true,
};

function jsonByteSize(value: JsonValue): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function recordValue(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : undefined;
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function agentDeploymentConfigSemanticIssues(
  config: AgentDeploymentConfigV1,
  manifest: AgentManifestV1,
): AgentManifestSemanticIssue[] {
  const issues: AgentManifestSemanticIssue[] = [];
  const capabilities = new Map(
    (manifest.spec.capabilities?.tools ?? []).map((capability) => [capability.name, capability]),
  );
  const bindings = config.toolAuthorizations ?? {};
  for (const toolName of Object.keys(bindings)) {
    const path = `/toolAuthorizations/${jsonPointerSegment(toolName)}`;
    const capability = capabilities.get(toolName);
    if (!capability) {
      issues.push({
        code: "undeclared_tool_authorization",
        message: `Deployment configuration binds undeclared tool capability ${toolName}.`,
        path,
      });
    } else if (capability.authorization !== "workspace") {
      issues.push({
        code: "tool_authorization_not_allowed",
        message: `Tool capability ${toolName} does not permit a workspace authorization binding.`,
        path,
      });
    }
  }
  for (const capability of capabilities.values()) {
    if (
      capability.required &&
      capability.authorization === "workspace" &&
      !Object.hasOwn(bindings, capability.name)
    ) {
      issues.push({
        code: "missing_tool_authorization",
        message: `Deployment configuration must bind workspace authorization for ${capability.name}.`,
        path: `/toolAuthorizations/${jsonPointerSegment(capability.name)}`,
      });
    }
  }
  issues.push(...agentBindingSemanticIssues(config, manifest));
  return issues;
}

export function agentManifestDepthIssue(input: unknown): AgentManifestSemanticIssue | undefined {
  try {
    const spec = recordValue(recordValue(input)?.spec);
    const runtime = recordValue(spec?.runtime);
    const requests = runtime?.toolRequests;
    if (Array.isArray(requests)) {
      for (const [index, requestInput] of requests.entries()) {
        const request = recordValue(requestInput);
        if (
          request?.input !== undefined &&
          jsonValueDepthExceeds(request.input, MAX_AGENT_TOOL_INPUT_DEPTH)
        ) {
          return {
            code: "tool_request_input_too_deep",
            message: `Tool request input must not exceed ${MAX_AGENT_TOOL_INPUT_DEPTH} nested levels.`,
            path: `/spec/runtime/toolRequests/${index}/input`,
          };
        }
      }
    }
    if (jsonValueDepthExceeds(input, 64)) {
      return {
        code: "invalid_agent_manifest",
        message: "Agent manifest nesting exceeds the validation limit.",
        path: "/",
      };
    }
    return undefined;
  } catch {
    return {
      code: "invalid_agent_manifest",
      message: "Agent manifest could not be inspected safely.",
      path: "/",
    };
  }
}

export function agentManifestSemanticIssues(
  manifest: AgentManifestV1,
): AgentManifestSemanticIssue[] {
  const issues: AgentManifestSemanticIssue[] = [];
  if (manifest.spec.memory?.mode === "off" && manifest.spec.memory.reviewMode === "auto-approve") {
    issues.push({
      code: "memory_review_without_memory",
      message: "Automatic memory review requires an enabled memory mode.",
      path: "/spec/memory/reviewMode",
    });
  }
  let serializationDepthIsSafe = true;
  const tools = manifest.spec.capabilities?.tools ?? [];
  const toolNames = new Set<string>();
  const capabilitiesByName = new Map<string, (typeof tools)[number]>();
  for (const [index, tool] of tools.entries()) {
    if (toolNames.has(tool.name)) {
      issues.push({
        code: "duplicate_tool_capability",
        message: `Tool capability ${tool.name} is declared more than once.`,
        path: `/spec/capabilities/tools/${index}/name`,
      });
    }
    toolNames.add(tool.name);
    capabilitiesByName.set(tool.name, tool);
  }

  for (const [index, toolName] of (manifest.spec.runtime?.modelTools ?? []).entries()) {
    if (!toolNames.has(toolName)) {
      issues.push({
        code: "undeclared_model_tool",
        message: `Model-native tool ${toolName} is not declared as a capability.`,
        path: `/spec/runtime/modelTools/${index}`,
      });
    }
  }

  for (const [toolName, path] of [
    ...tools.map((tool, index) => [tool.name, `/spec/capabilities/tools/${index}/name`] as const),
    ...(manifest.spec.runtime?.modelTools ?? []).map(
      (name, index) => [name, `/spec/runtime/modelTools/${index}`] as const,
    ),
  ]) {
    if (toolName === ATTACHMENT_READ_TOOL) {
      issues.push({
        code: "platform_managed_tool",
        message: `${ATTACHMENT_READ_TOOL} is added by the platform when a run has a readable document.`,
        path,
      });
    }
  }

  const requestKeys = new Set<string>();
  for (const [index, request] of (manifest.spec.runtime?.toolRequests ?? []).entries()) {
    if (!toolNames.has(request.toolName)) {
      issues.push({
        code: "undeclared_tool_request",
        message: `Preconfigured tool request ${request.toolName} is not declared as a capability.`,
        path: `/spec/runtime/toolRequests/${index}/toolName`,
      });
    }
    const capability = capabilitiesByName.get(request.toolName);
    if (
      capability &&
      capability.requiredScopes.some((scope) => !request.requiredScopes.includes(scope))
    ) {
      issues.push({
        code: "tool_request_missing_capability_scope",
        message: `Preconfigured tool request ${request.toolName} omits a capability-required scope.`,
        path: `/spec/runtime/toolRequests/${index}/requiredScopes`,
      });
    }
    if (requestKeys.has(request.idempotencyKey)) {
      issues.push({
        code: "duplicate_tool_request_idempotency_key",
        message: `Tool request idempotency key ${request.idempotencyKey} is duplicated.`,
        path: `/spec/runtime/toolRequests/${index}/idempotencyKey`,
      });
    }
    requestKeys.add(request.idempotencyKey);

    if (request.input) {
      if (jsonValueDepthExceeds(request.input, MAX_AGENT_TOOL_INPUT_DEPTH)) {
        serializationDepthIsSafe = false;
        issues.push({
          code: "tool_request_input_too_deep",
          message: `Tool request input must not exceed ${MAX_AGENT_TOOL_INPUT_DEPTH} nested levels.`,
          path: `/spec/runtime/toolRequests/${index}/input`,
        });
      } else if (jsonByteSize(request.input) > MAX_AGENT_TOOL_INPUT_UTF8_BYTES) {
        issues.push({
          code: "tool_request_input_too_large",
          message: `Tool request input must not exceed ${MAX_AGENT_TOOL_INPUT_UTF8_BYTES} UTF-8 bytes.`,
          path: `/spec/runtime/toolRequests/${index}/input`,
        });
      }
    }
  }

  const skillCount =
    (manifest.spec.platformSkills?.length ?? 0) + (manifest.spec.skills?.length ?? 0);
  if (skillCount > MAX_AGENT_SKILL_COUNT) {
    issues.push({
      code: "too_many_skills",
      message: `Platform and pinned skills together must not exceed ${MAX_AGENT_SKILL_COUNT}.`,
      path: "/spec/skills",
    });
  }

  if (manifest.spec.model.fallbackIds?.includes(manifest.spec.model.id)) {
    issues.push({
      code: "primary_model_repeated_as_fallback",
      message: "The primary model cannot also be a fallback model.",
      path: "/spec/model/fallbackIds",
    });
  }

  if (manifest.spec.sandbox.mode === "none") {
    for (const field of [
      "accessPolicyRef",
      "imageRef",
      "minMemoryMiB",
      "minVcpu",
      "poolKey",
    ] as const) {
      if (manifest.spec.sandbox[field] !== undefined) {
        issues.push({
          code: "sandbox_setting_without_sandbox",
          message: `Sandbox field ${field} cannot be set when sandbox mode is none.`,
          path: `/spec/sandbox/${field}`,
        });
      }
    }
  }

  if (manifest.spec.sandbox.mode !== "thread-persistent") {
    for (const [index, tool] of tools.entries()) {
      if (Object.hasOwn(THREAD_SANDBOX_FILE_TOOL_NAMES, tool.name)) {
        issues.push({
          code: "sandbox_file_tool_without_thread_sandbox",
          message: `Tool capability ${tool.name} requires sandbox mode thread-persistent.`,
          path: `/spec/capabilities/tools/${index}/name`,
        });
      }
    }
  }

  if (manifest.spec.sandbox.mode === "none") {
    for (const [index, tool] of tools.entries()) {
      if (Object.hasOwn(SANDBOX_BROWSER_TOOL_NAMES, tool.name)) {
        issues.push({
          code: "browser_tool_without_sandbox",
          message: `Tool capability ${tool.name} requires a run-ephemeral or thread-persistent sandbox.`,
          path: `/spec/capabilities/tools/${index}/name`,
        });
      }
    }
  }

  issues.push(...subAgentSemanticIssues(manifest), ...responseFormatSemanticIssues(manifest));

  if (
    serializationDepthIsSafe &&
    jsonByteSize(manifest as JsonValue) > MAX_AGENT_MANIFEST_UTF8_BYTES
  ) {
    issues.push({
      code: "agent_manifest_too_large",
      message: `Agent manifests must not exceed ${MAX_AGENT_MANIFEST_UTF8_BYTES} UTF-8 bytes.`,
      path: "/",
    });
  }

  return issues;
}

export const ValidatedAgentManifestV1 = AgentManifestV1.pipe(
  Schema.check(
    Schema.makeFilter<AgentManifestV1>((manifest) => {
      const issues = agentManifestSemanticIssues(manifest);
      return issues.length === 0
        ? undefined
        : issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
    }),
  ),
);

export function agentManifestAllowsTrigger(manifest: AgentManifestV1, trigger: string): boolean {
  const allowed = manifest.spec.triggers;
  return allowed === undefined || allowed.includes(trigger as (typeof allowed)[number]);
}
