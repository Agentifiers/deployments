import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailure, singleLine } from "./process.ts";
import { rootProfiles } from "./profiles.ts";
import { createTerraformRoot, movedResourceTargets } from "./terraform.ts";

// OpenTofu 1.13.1 wording for `plan -target=...` with pending `moved` blocks; it lists the
// `from` and `to` address of every pending move.
const movesRefused = `
Error: Moved resource instances excluded by targeting

Resource instances in your current state have moved to new addresses in the
latest configuration. OpenTofu must include those resource instances while
planning in order to ensure a correct result, but your -target=... options do
not fully cover all of those resource instances.

To create a valid plan, either remove your -target=... options altogether or
add the following additional target options:
  -target="module.platform.module.platform_api[0].aws_cloudwatch_metric_alarm.lambda_errors"
  -target="module.platform.module.platform_api[0].aws_lambda_function.api"
  -target="module.vertical[\\"acme corp\\"].aws_kms_key.alerts"

Note that adding these options may include further additional resource
instances in your plan, in order to respect object dependencies.
`;

async function applyStage(failure: "pending moves" | "other") {
  const workDirectory = await mkdtemp(join(tmpdir(), "terraform-root-"));
  const commands: string[] = [];
  let movesPending = failure === "pending moves";
  try {
    const root = createTerraformRoot({
      directory: "infrastructure/environments/acme",
      environment: {},
      run: async (command) => {
        commands.push(command.slice(2).join(" ").replaceAll(workDirectory, "<work>"));
        const refreshOnly = command.includes("-refresh-only");
        const out = command.find((argument) => argument.startsWith("-out="));
        if (command[2] === "plan" && !out) {
          if (movesPending) throw new CommandFailure(movesRefused, command);
          return "";
        }
        if (command[2] === "plan" && !refreshOnly && (movesPending || failure === "other")) {
          throw new CommandFailure("exit 1", command);
        }
        if (out) await writeFile(out.slice("-out=".length), "plan");
        if (command[2] === "apply" && command.at(-1)?.endsWith("-moves.tfplan")) {
          movesPending = false;
        }
        return "";
      },
      target: {
        aws: { accountId: "123456789012", region: "us-east-2" },
        ecrRepositories: {
          "agent-worker": "agent-worker",
          "app-gateway": "app-gateway",
          bifrost: "bifrost",
          "durable-streams": "durable-streams",
          firecrawl: "firecrawl",
          "model-gateway": "model-gateway",
          "observability-hot-plane": "observability-hot-plane",
          "stream-gateway": "stream-gateway",
          "web-tools-proxy": "web-tools-proxy",
        },
        lambdaMicrovmImage: "sandbox",
        name: "acme",
        profile: rootProfiles["platform-customer"],
        profileName: "platform-customer",
        terraform: {
          root: "infrastructure/environments/acme",
          stateBucket: "state",
          stateKey: "acme.tfstate",
          varFiles: [],
        },
      },
      workDirectory,
    });
    const outcome = await root
      .apply({
        label: "prerequisites",
        targets: ["module.platform.module.sandbox_runtime[0]"],
        variables: { aws_account_id: "123456789012" },
      })
      .then(
        () => "applied",
        (error: unknown) => singleLine(error),
      );
    return { commands, outcome };
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

describe("OpenTofu root moved blocks", () => {
  test("reads the resource addresses OpenTofu asks to target for pending moves", () => {
    expect(movedResourceTargets(movesRefused)).toEqual([
      "module.platform.module.platform_api[0].aws_cloudwatch_metric_alarm.lambda_errors",
      "module.platform.module.platform_api[0].aws_lambda_function.api",
      'module.vertical["acme corp"].aws_kms_key.alerts',
    ]);
    expect(
      movedResourceTargets(`Error: Invalid target address\n  -target="module.platform"\n`),
    ).toEqual([]);
  });

  test("records pending moves with a refresh-only apply, then plans and applies the stage", async () => {
    const { commands, outcome } = await applyStage("pending moves");

    expect(outcome).toBe("applied");
    expect(commands).toEqual([
      "plan -input=false -no-color -parallelism=30 -out=<work>/prerequisites.tfplan -target=module.platform.module.sandbox_runtime[0] -var-file=<work>/deployment.tfvars.json",
      "plan -refresh-only -input=false -no-color -target=terraform_data.pending_moves_probe -var-file=<work>/deployment.tfvars.json",
      'plan -input=false -no-color -parallelism=30 -out=<work>/prerequisites-moves.tfplan -refresh-only -target=module.platform.module.platform_api[0].aws_cloudwatch_metric_alarm.lambda_errors -target=module.platform.module.platform_api[0].aws_lambda_function.api -target=module.vertical["acme corp"].aws_kms_key.alerts -var-file=<work>/deployment.tfvars.json',
      "apply -input=false -no-color -parallelism=30 -var-file=<work>/deployment.tfvars.json <work>/prerequisites-moves.tfplan",
      "plan -input=false -no-color -parallelism=30 -out=<work>/prerequisites.tfplan -target=module.platform.module.sandbox_runtime[0] -var-file=<work>/deployment.tfvars.json",
      "apply -input=false -no-color -parallelism=30 -var-file=<work>/deployment.tfvars.json <work>/prerequisites.tfplan",
    ]);
  });

  test("fails a targeted plan that pending moves do not explain without applying anything", async () => {
    const { commands, outcome } = await applyStage("other");

    expect(outcome).toBe("tofu -chdir=infrastructure/environments/acme plan failed: exit 1");
    expect(commands).toEqual([
      "plan -input=false -no-color -parallelism=30 -out=<work>/prerequisites.tfplan -target=module.platform.module.sandbox_runtime[0] -var-file=<work>/deployment.tfvars.json",
      "plan -refresh-only -input=false -no-color -target=terraform_data.pending_moves_probe -var-file=<work>/deployment.tfvars.json",
    ]);
  });
});
