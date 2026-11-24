import { describe, expect, test } from "bun:test";
import {
  platformToolAdapterDefinitions,
  toolExecutionRoute,
  type ToolAdapterDefinition,
  type ToolExecutionRoute,
} from "@deployments-ai/tools";
import {
  executionPlan,
  HOSTED_CODE_EXECUTOR_KEY,
  type ExecuteRuntimeBuiltinTool,
  type RuntimeToolExecutionPlan,
} from "./runtime-tool-planning.ts";

const executor: ExecuteRuntimeBuiltinTool = async () => {
  throw new Error("Route classification never executes tools.");
};
const builtinExecutors: Readonly<Record<string, ExecuteRuntimeBuiltinTool>> = Object.fromEntries(
  [
    HOSTED_CODE_EXECUTOR_KEY,
    ...platformToolAdapterDefinitions.flatMap((definition) =>
      definition.execution?.type === "builtin" && definition.execution.adapterKey
        ? [definition.execution.adapterKey]
        : [],
    ),
  ].map((adapterKey) => [adapterKey, executor]),
);

const PLAN_ROUTES: Readonly<Record<RuntimeToolExecutionPlan["kind"], ToolExecutionRoute>> = {
  builtin: "builtin",
  client: "client",
  "hosted-code": "hosted_code",
  "http-callback": "http_callback",
  "mcp-mutation": "mcp",
  "mcp-read": "mcp",
  "provider-mutation": "provider_native",
  "provider-read": "provider_native",
};

function plannedRoute(definition: ToolAdapterDefinition): ToolExecutionRoute | undefined {
  let plan: RuntimeToolExecutionPlan;
  try {
    plan = executionPlan({ ...definition, status: "active" }, builtinExecutors);
  } catch {
    return undefined;
  }
  return "vendor" in plan && plan.vendor ? "vendor_mcp" : PLAN_ROUTES[plan.kind];
}

function extension(
  toolName: string,
  effect: ToolAdapterDefinition["effect"],
  execution: ToolAdapterDefinition["execution"],
): ToolAdapterDefinition {
  return {
    defaultPolicyAction: "require_approval",
    description: toolName,
    effect,
    ...(execution ? { execution } : {}),
    status: "active",
    toolName,
  };
}

const extensions = [
  extension("custom.mcp.read", "read", {
    mcpServerId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    remoteToolName: "search",
    type: "mcp",
  }),
  extension("custom.mcp.write", "write", {
    mcpServerId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    remoteToolName: "update",
    type: "mcp",
  }),
  extension("vendor.issues.create", "write", {
    providerKey: "linear",
    remoteToolName: "create_issue",
    toolHash: `sha256:${"a".repeat(64)}`,
    type: "vendor_mcp",
  }),
  extension("custom.client", "write", { type: "client" }),
  extension("custom.hosted", "execute", {
    artifact: { bucket: "artifacts", byteSize: 10, key: "code", versionId: "v1" },
    contentHash: `sha256:${"b".repeat(64)}`,
    entrypoint: "handler",
    language: "javascript",
    memoryMiB: 256,
    network: "none",
    secretNames: [],
    sourceLanguage: "javascript",
    timeoutMs: 1_000,
    type: "hosted_code",
  }),
  extension("custom.callback", "write", {
    completionMode: "sync",
    endpointOrigin: "https://hooks.example.test",
    endpointPath: "/tools",
    type: "http_callback",
  }),
  extension("custom.unbound", "read", { type: "builtin" }),
  extension("custom.unexecutable", "read", undefined),
];

describe("tool execution routes", () => {
  test("classify every catalog and extension definition exactly as the execution planner", () => {
    const mismatches = [...platformToolAdapterDefinitions, ...extensions].flatMap((definition) => {
      const planned = plannedRoute(definition);
      const classified = toolExecutionRoute(definition);
      return planned === classified ? [] : [`${definition.toolName}: ${planned} != ${classified}`];
    });
    expect(mismatches).toEqual([]);
    expect(extensions.map(toolExecutionRoute)).toEqual([
      "mcp",
      undefined,
      "vendor_mcp",
      "client",
      "hosted_code",
      "http_callback",
      undefined,
      undefined,
    ]);
  });
});
