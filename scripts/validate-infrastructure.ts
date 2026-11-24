import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roots: Record<string, { readonly customerAccount: boolean; readonly boundedRoles: boolean }> =
  {
    "infrastructure/bootstrap/customer": { customerAccount: true, boundedRoles: false },
    "infrastructure/environments/customer": { customerAccount: true, boundedRoles: true },
    "infrastructure/environments/local": { customerAccount: false, boundedRoles: false },
  };
// `tofu test` reads a module's *.tftest.hcl files from the module directory and its tests/.
const testedModules = [
  ...new Set(
    Array.from(
      new Bun.Glob("infrastructure/modules/**/*.tftest.hcl").scanSync({ cwd: repositoryRoot }),
      (file) => (basename(dirname(file)) === "tests" ? dirname(dirname(file)) : dirname(file)),
    ),
  ),
].sort();
const caseSensitiveVendorIdentity = {
  prodEnvironmentName: /(?<![a-z0-9])prod(?![a-z0-9])/u,
  productDomain: /deployments\.ai/u,
  repositoryTagKey: /Repository/u,
};

const validationDataRoot = join(repositoryRoot, ".artifacts/tofu-validation");
// One provider copy for every root and module instead of ~800 MB of AWS provider per init. OpenTofu
// locks the shared cache, so concurrent inits may fill it. CI points this at a cached directory.
const pluginCacheDirectory =
  process.env.TF_PLUGIN_CACHE_DIR ?? join(validationDataRoot, "plugin-cache");
await mkdir(pluginCacheDirectory, { recursive: true });

async function tofu(directory: string, args: readonly string[]) {
  // init -backend=false can still read an already configured backend's state.
  // Never reuse the operator's .terraform directory for credential-free checks.
  const child = Bun.spawn(["tofu", `-chdir=${join(repositoryRoot, directory)}`, ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TF_DATA_DIR: join(validationDataRoot, directory),
      TF_INPUT: "false",
      TF_PLUGIN_CACHE_DIR: pluginCacheDirectory,
    },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const failed = (await child.exited) !== 0;
  if (failed || !args.includes("-verbose")) process.stdout.write(output);
  if (failed) throw new Error(`tofu ${args[0]} failed for ${directory}.`);
  return output;
}

function testPermissionsBoundary(directory: string) {
  const variables: unknown = JSON.parse(
    readFileSync(join(repositoryRoot, directory, "tests/terraform.tfvars.json"), "utf8"),
  );
  if (
    typeof variables === "object" &&
    variables !== null &&
    "iam_permissions_boundary_arn" in variables &&
    typeof variables.iam_permissions_boundary_arn === "string"
  ) {
    return variables.iam_permissions_boundary_arn;
  }
  throw new Error(`${directory}/tests/terraform.tfvars.json sets no iam_permissions_boundary_arn.`);
}

function rolesOutsideBoundary(plan: string, boundary: string) {
  const roles = [
    ...plan.matchAll(
      /^ {2}# (\S+) will be created\n {2}\+ resource "aws_iam_role" .*\n([\s\S]*?)\n {4}\}$/gmu,
    ),
  ];
  if (roles.length === 0) throw new Error("The verbose test plans create no aws_iam_role.");
  return roles
    .filter(
      ([, , body = ""]) => /\+ permissions_boundary\s+= "([^"]*)"/u.exec(body)?.[1] !== boundary,
    )
    .map(([, address = ""]) => address);
}

async function validateRoot(
  directory: string,
  { customerAccount, boundedRoles }: (typeof roots)[string],
) {
  await tofu(directory, ["init", "-backend=false", "-input=false"]);
  await tofu(directory, ["validate"]);
  if (!existsSync(join(repositoryRoot, directory, "tests"))) return;
  const output = await tofu(directory, ["test", "-verbose", "-no-color"]);
  if (boundedRoles) {
    const boundary = testPermissionsBoundary(directory);
    const unbounded = rolesOutsideBoundary(output, boundary);
    if (unbounded.length > 0) {
      throw new Error(`${directory} plans roles without ${boundary}:\n${unbounded.join("\n")}`);
    }
  }
  if (!customerAccount) return;
  const leaks = output
    .split("\n")
    .filter((line) =>
      Object.values(caseSensitiveVendorIdentity).some((pattern) => pattern.test(line)),
    );
  if (leaks.length > 0) throw new Error(`${directory} plans vendor identity:\n${leaks.join("\n")}`);
}

async function testModule(directory: string) {
  await tofu(directory, ["init", "-backend=false", "-input=false"]);
  await tofu(directory, ["test"]);
}

// Roots first: the customer environment's verbose plans are the longest single check.
const checks = [
  ...Object.entries(roots).map(
    ([directory, root]) =>
      () =>
        validateRoot(directory, root),
  ),
  ...testedModules.map((directory) => () => testModule(directory)),
];
const failures: unknown[] = [];
const worker = async () => {
  for (let check = checks.shift(); check !== undefined; check = checks.shift()) {
    try {
      await check();
    } catch (error) {
      failures.push(error);
    }
  }
};
await Promise.all(Array.from({ length: Math.min(availableParallelism(), checks.length) }, worker));
if (failures.length > 0) {
  throw new AggregateError(failures, `${failures.length} infrastructure checks failed.`);
}
