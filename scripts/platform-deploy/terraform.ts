import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, CommandFailure, type Environment, log } from "./process.ts";
import type { DeploymentTarget } from "./target.ts";

type TerraformVariables = Readonly<Record<string, unknown>>;
export type TerraformOutputs = Readonly<Record<string, unknown>>;

export interface TerraformApply {
  /** Names the saved plan file and progress messages. */
  readonly label: string;
  readonly targets?: readonly string[];
  readonly variables: TerraformVariables;
}

/** An OpenTofu root bound to one deployment target's backend. */
export interface TerraformRoot {
  /** Plans with the target var files plus generated variables, then applies that saved plan. */
  apply(input: TerraformApply): Promise<void>;
  init(): Promise<void>;
  /** `tofu output -json` with each output unwrapped to its value. */
  outputs(): Promise<TerraformOutputs>;
  stateResources(): Promise<readonly string[]>;
}

// The deployment root refreshes about 1,650 objects per plan. Raising the default of 10 cut a
// refresh of dev from 58s to 35s with no AWS API throttling.
const TERRAFORM_PARALLELISM = "-parallelism=30";

// A targeted plan that excludes pending `moved` blocks fails with an error that lists them.
// This address matches no resource, so the error lists every pending move.
const PENDING_MOVES_PROBE_TARGET = "terraform_data.pending_moves_probe";

export function movedResourceTargets(stderr: string): string[] {
  if (!stderr.includes("Error: Moved resource instances excluded by targeting")) return [];
  return Array.from(stderr.matchAll(/^\s+-target=(".+")$/gmu), (match) =>
    String(JSON.parse(match[1]!)),
  );
}

function terraformEnvironment(
  environment: Environment,
  workDirectory: string,
): Record<string, string | undefined> {
  return {
    ...environment,
    TF_DATA_DIR: join(workDirectory, "terraform-data"),
    TF_INPUT: "false",
    TF_IN_AUTOMATION: "true",
  };
}

export function createTerraformRoot(input: {
  readonly directory: string;
  readonly environment: Environment;
  readonly run: CommandRunner;
  readonly target: DeploymentTarget;
  readonly workDirectory: string;
}): TerraformRoot {
  const env = terraformEnvironment(input.environment, input.workDirectory);
  const terraform = ["tofu", `-chdir=${input.directory}`];
  const generatedVariables = join(input.workDirectory, "deployment.tfvars.json");
  const varFileOptions = [
    ...input.target.terraform.varFiles.map((path) => `-var-file=${path}`),
    `-var-file=${generatedVariables}`,
  ];
  async function plan(planPath: string, options: readonly string[]) {
    await input.run(
      [
        ...terraform,
        "plan",
        "-input=false",
        "-no-color",
        TERRAFORM_PARALLELISM,
        `-out=${planPath}`,
        ...options,
        ...varFileOptions,
      ],
      { env, stream: true },
    );
    await chmod(planPath, 0o600);
  }
  // OpenTofu checks the inputs of a saved-plan apply against the plan and still loads
  // *.auto.tfvars, so the apply passes the plan's var files to resolve the same values.
  async function applyPlan(planPath: string) {
    await input.run(
      [
        ...terraform,
        "apply",
        "-input=false",
        "-no-color",
        TERRAFORM_PARALLELISM,
        ...varFileOptions,
        planPath,
      ],
      { env, stream: true },
    );
  }
  async function pendingMoveTargets() {
    try {
      await input.run(
        [
          ...terraform,
          "plan",
          "-refresh-only",
          "-input=false",
          "-no-color",
          `-target=${PENDING_MOVES_PROBE_TARGET}`,
          ...varFileOptions,
        ],
        { env },
      );
      return [];
    } catch (error) {
      if (error instanceof CommandFailure) return movedResourceTargets(error.stderr);
      throw error;
    }
  }
  async function recordPendingMoves(label: string, moved: readonly string[]) {
    log(`tofu apply: recording pending moves (refresh-only) before ${label}`);
    const movesPath = join(input.workDirectory, `${label}-moves.tfplan`);
    await plan(movesPath, ["-refresh-only", ...moved.map((address) => `-target=${address}`)]);
    await applyPlan(movesPath);
  }
  return {
    async apply({ label, targets = [], variables }) {
      log(`tofu apply: ${label}`);
      await writeFile(generatedVariables, `${JSON.stringify(variables, null, 2)}\n`, {
        mode: 0o600,
      });
      const planPath = join(input.workDirectory, `${label}.tfplan`);
      const targetOptions = targets.map((address) => `-target=${address}`);
      try {
        await plan(planPath, targetOptions);
      } catch (error) {
        const moved = targets.length > 0 ? await pendingMoveTargets() : [];
        if (moved.length === 0) throw error;
        await recordPendingMoves(label, moved);
        await plan(planPath, targetOptions);
      }
      await applyPlan(planPath);
    },
    async init() {
      log(`tofu init: ${input.target.terraform.stateKey}`);
      await input.run(
        [
          ...terraform,
          "init",
          "-input=false",
          "-no-color",
          `-backend-config=bucket=${input.target.terraform.stateBucket}`,
          "-backend-config=encrypt=true",
          `-backend-config=key=${input.target.terraform.stateKey}`,
          `-backend-config=region=${input.target.aws.region}`,
          "-backend-config=use_lockfile=true",
        ],
        { env, stream: true },
      );
    },
    async outputs() {
      const decoded: unknown = JSON.parse(
        await input.run([...terraform, "output", "-json"], { env }),
      );
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("tofu output -json did not return an object.");
      }
      return Object.fromEntries(
        Object.entries(decoded).map(([name, output]: [string, unknown]) => [
          name,
          output !== null && typeof output === "object" && "value" in output
            ? (output.value ?? null)
            : null,
        ]),
      );
    },
    async stateResources() {
      let listed: string;
      try {
        listed = await input.run([...terraform, "state", "list"], { env });
      } catch (error) {
        // A new account has no state object yet; every other failure is fatal.
        if (error instanceof CommandFailure && error.stderr.includes("No state file was found")) {
          return [];
        }
        throw error;
      }
      return listed.split("\n").filter((line) => line.length > 0);
    },
  };
}
