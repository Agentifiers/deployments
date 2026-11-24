import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { MICROVM_LOG_GROUP } from "../scripts/lambda-microvm-image.ts";

type TerraformBlock = {
  readonly address: string;
  readonly body: string;
  readonly module: string;
  readonly name: string;
  readonly type: string;
};

const ENVIRONMENT_ROOTS = ["infrastructure/environments/customer"];
const MANAGED_POLICIES_THAT_CREATE_LOG_GROUPS = [
  "AWSLambdaBasicExecutionRole",
  "AWSLambdaVPCAccessExecutionRole",
  "CloudWatchAgentServerPolicy",
];

function terraformSource(directory: string) {
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".tf"))
    .map((fileName) => readFileSync(join(directory, fileName), "utf8"))
    .join("\n");
}

function moduleDirectories(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (!statSync(path).isDirectory()) return [];
    const nested = moduleDirectories(path);
    return readdirSync(path).some((fileName) => fileName.endsWith(".tf"))
      ? [path, ...nested]
      : nested;
  });
}

function terraformBlocks(directory: string, kind: "data" | "resource"): TerraformBlock[] {
  return Array.from(
    terraformSource(directory).matchAll(
      new RegExp(`^${kind} "([^"]+)" "([^"]+)" \\{\\n([\\s\\S]*?)^\\}$`, "gmu"),
    ),
    ([, type = "", name = "", body = ""]) => ({
      address: `${directory}:${kind === "data" ? "data." : ""}${type}.${name}`,
      body,
      module: directory,
      name,
      type,
    }),
  );
}

function composedModules(roots: readonly string[]) {
  const found = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const [, source = ""] of terraformSource(directory).matchAll(
      /^\s+source\s+= "(\.{1,2}\/[^"]+)"$/gmu,
    )) {
      const child = normalize(join(directory, source));
      if (!found.has(child)) {
        found.add(child);
        pending.push(child);
      }
    }
  }
  return [...found].toSorted();
}

const allModules = moduleDirectories("infrastructure/modules");
const platformModules = composedModules(ENVIRONMENT_ROOTS);

describe("CloudWatch log retention infrastructure", () => {
  test("composes the platform stack from the modules the environment roots reference", () => {
    expect(platformModules).toContain("infrastructure/modules/platform-identity");
    expect(platformModules).toContain("infrastructure/modules/sandbox-runtime");
    expect(platformModules).not.toContain("infrastructure/modules/vertical/lambda-function");
  });

  test("expires every OpenTofu-managed log group", () => {
    const groups = allModules.flatMap((directory) =>
      terraformBlocks(directory, "resource").filter(
        (block) => block.type === "aws_cloudwatch_log_group",
      ),
    );
    expect(groups.map((group) => group.address)).toContain(
      "infrastructure/modules/platform-identity:aws_cloudwatch_log_group.lambda",
    );
    expect(
      groups
        .filter((group) => !/^\s+retention_in_days\s+= \S/mu.test(group.body))
        .map((group) => group.address),
    ).toEqual([]);
  });

  test("gives every platform Lambda function a managed log group before it can log", () => {
    const functions = platformModules.flatMap((directory) => {
      const resources = terraformBlocks(directory, "resource");
      const lambdaLogGroups = new Set(
        resources
          .filter(
            (block) =>
              block.type === "aws_cloudwatch_log_group" &&
              /^\s+name\s+= "\/aws\/lambda\//mu.test(block.body),
          )
          .map((block) => block.name),
      );
      return resources
        .filter((block) => block.type === "aws_lambda_function")
        .map((block) => {
          const configured = /logging_config \{[^}]*\blog_group\s+= aws_cloudwatch_log_group\./u;
          const dependencies = /depends_on\s+= \[([^\]]*)\]/u.exec(block.body)?.[1] ?? "";
          const dependsOnGroup = Array.from(
            dependencies.matchAll(/aws_cloudwatch_log_group\.(\w+)/gu),
            ([, name = ""]) => name,
          ).some((name) => lambdaLogGroups.has(name));
          return { address: block.address, managed: configured.test(block.body) || dependsOnGroup };
        });
    });
    expect(functions).toContainEqual({
      address: "infrastructure/modules/platform-identity:aws_lambda_function.api",
      managed: true,
    });
    expect(functions.filter((fn) => !fn.managed).map((fn) => fn.address)).toEqual([]);
  });

  test("publishes MicroVM images into the OpenTofu-managed sandbox log group", () => {
    const group = terraformBlocks("infrastructure/modules/sandbox-runtime", "resource").find(
      (block) => block.type === "aws_cloudwatch_log_group" && block.name === "microvm",
    );
    expect(/^\s+name\s+= "([^"]+)"$/mu.exec(group?.body ?? "")?.[1]).toBe(MICROVM_LOG_GROUP);
  });

  test("never lets an OpenTofu-managed role create log groups", () => {
    const inlineGrants = allModules.filter((directory) =>
      /"logs:(\*|Create\*|CreateLogGroup)"/u.test(terraformSource(directory)),
    );
    expect(inlineGrants).toEqual([]);

    const managedGrants = platformModules.flatMap((directory) =>
      terraformBlocks(directory, "resource")
        .filter((block) => block.type === "aws_iam_role_policy_attachment")
        .filter((block) =>
          MANAGED_POLICIES_THAT_CREATE_LOG_GROUPS.some((policy) =>
            block.body.includes(`/${policy}"`),
          ),
        )
        .map((block) => block.address),
    );
    expect(managedGrants).toEqual([]);
  });
});
