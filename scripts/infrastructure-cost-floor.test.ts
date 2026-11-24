import { describe, expect, test } from "bun:test";

const infrastructureRoot = new URL("../infrastructure/", import.meta.url);

async function infrastructureFile(path: string) {
  return Bun.file(new URL(path, infrastructureRoot)).text();
}

describe("development infrastructure cost floor", () => {
  test("routes Durable Streams through a dedicated port on the shared model ALB", async () => {
    const stack = await infrastructureFile("modules/platform/agent-runtime.tf");
    const main = await infrastructureFile("modules/durable-streams/main.tf");
    const outputs = await infrastructureFile("modules/durable-streams/outputs.tf");

    expect(stack).toContain(
      "arn               = module.model_runtime[0].internal_load_balancer.arn",
    );
    expect(main).toContain("count = local.uses_shared_load_balancer ? 0 : 1");
    expect(main).toContain('resource "aws_lb_listener" "shared"');
    expect(main).toMatch(/resource "aws_lb_listener" "shared"[\s\S]*?port\s*= 4437/u);
    expect(main).not.toContain('resource "aws_lb_listener_rule" "shared"');
    expect(outputs).toContain('"http://${var.shared_load_balancer.dns_name}:4437"');
  });

  test("keeps AWS-native search enabled for memory and Brain", async () => {
    const stackAgentRuntime = await infrastructureFile("modules/platform/agent-runtime.tf");
    const stackMemoryAndBrain = await infrastructureFile("modules/platform/memory-and-brain.tf");

    expect(stackMemoryAndBrain.match(/aws_native_enabled\s*= true/gu)).toHaveLength(2);
    expect(stackAgentRuntime).toMatch(
      /runtime_policy_arns = merge\(\s*var\.memory_runtime_enabled \? \{\s*memory_aws_native/u,
    );
    expect(stackAgentRuntime).not.toContain(
      "try(module.memory_runtime[0].worker_aws_native_policy_arn, null) != null",
    );
  });
});
