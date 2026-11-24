import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { eventually } from "./eventually.ts";
import { log, repositoryRoot, runCommand, singleLine } from "./platform-deploy/process.ts";

const usage = `Usage: bun scripts/deploy-docs.ts --root <dir> --backend-config <file> [--skip-build] [--allow-replace]

Builds apps/docs, applies the docs-site OpenTofu root, publishes apps/docs/out to the site
bucket, invalidates CloudFront, and verifies the live site. Safe to rerun.

  --root <dir>              OpenTofu root that instantiates infrastructure/modules/docs-site.
  --backend-config <file>   Backend configuration file passed to \`tofu init\`.
  --skip-build              Publish the existing apps/docs/out instead of building it first.
  --allow-replace           Apply a plan that deletes or replaces resources; refused by default.

Relative paths resolve against the working directory. Credentials come from the standard AWS
chain and must belong to the account that owns the root's state and site.`;

export type Command =
  | { readonly kind: "help" }
  | {
      readonly allowReplace: boolean;
      readonly backendConfig: string;
      readonly build: boolean;
      readonly kind: "deploy";
      readonly root: string;
    };

export function parseArguments(argv: readonly string[], cwd = process.cwd()): Command {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "allow-replace": { type: "boolean" },
        "backend-config": { type: "string" },
        help: { short: "h", type: "boolean" },
        root: { type: "string" },
        "skip-build": { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    throw new Error(`${singleLine(error)} Run with --help for usage.`, { cause: error });
  }
  if (values.help) return { kind: "help" };
  const root = values.root?.trim();
  const backendConfig = values["backend-config"]?.trim();
  if (!root) throw new Error("--root <dir> is required. Run with --help for usage.");
  if (!backendConfig) {
    throw new Error("--backend-config <file> is required. Run with --help for usage.");
  }
  return {
    allowReplace: values["allow-replace"] ?? false,
    backendConfig: resolve(cwd, backendConfig),
    build: !values["skip-build"],
    kind: "deploy",
    root: resolve(cwd, root),
  };
}

const PlanDocument = Schema.Struct({
  resource_changes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        address: Schema.String,
        change: Schema.Struct({ actions: Schema.Array(Schema.String) }),
      }),
    ),
  ),
});
const decodePlan = Schema.decodeUnknownSync(PlanDocument);

export function destructiveChanges(plan: unknown): string[] {
  return (decodePlan(plan).resource_changes ?? [])
    .filter((resource) => resource.change.actions.includes("delete"))
    .map((resource) => resource.address);
}

const OutputValue = Schema.Struct({ value: Schema.String });
const decodeOutputs = Schema.decodeUnknownSync(
  Schema.Struct({
    bucket_name: OutputValue,
    bucket_region: OutputValue,
    distribution_id: OutputValue,
    site_url: OutputValue,
  }),
);

interface Site {
  readonly bucketName: string;
  readonly bucketRegion: string;
  readonly distributionId: string;
  readonly url: string;
}

const siteDirectory = join(repositoryRoot, "apps/docs/out");
const immutableCacheControl = "public, max-age=31536000, immutable";
const revalidateCacheControl = "public, max-age=0, s-maxage=86400, must-revalidate";
const verificationTimeoutMs = 300_000;

interface OpenTofuRoot {
  readonly backendConfig: string;
  readonly root: string;
}

function tofu(
  root: OpenTofuRoot,
  args: readonly string[],
  options: { readonly stream?: boolean } = {},
) {
  return runCommand(["tofu", `-chdir=${root.root}`, ...args], options);
}

async function builtNestedPage() {
  for (const file of ["index.html", "404.html"]) {
    if (!existsSync(join(siteDirectory, file))) {
      throw new Error(
        `apps/docs/out/${file} is missing. Build the site with \`bun run --cwd apps/docs build\` or rerun without --skip-build.`,
      );
    }
  }
  const pages = (await readdir(siteDirectory, { recursive: true })).filter((path) => {
    const segments = path.split(sep);
    return segments.length >= 3 && segments.at(-1) === "index.html";
  });
  const page = pages.toSorted((left, right) => left.localeCompare(right))[0];
  if (!page) throw new Error("apps/docs/out has no nested page to verify.");
  return `/${page.slice(0, -"index.html".length)}`;
}

async function applyInfrastructure(root: OpenTofuRoot, allowReplace: boolean): Promise<Site> {
  await tofu(
    root,
    ["init", "-input=false", "-no-color", "-reconfigure", `-backend-config=${root.backendConfig}`],
    { stream: true },
  );
  const workDirectory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "docs-deploy-"));
  try {
    const planPath = join(workDirectory, "docs-site.tfplan");
    await tofu(root, ["plan", "-input=false", "-no-color", `-out=${planPath}`], { stream: true });
    const destructive = destructiveChanges(
      JSON.parse(await tofu(root, ["show", "-json", planPath])),
    );
    if (destructive.length > 0 && !allowReplace) {
      throw new Error(
        `The plan deletes or replaces ${destructive.join(", ")}. Review it and rerun with --allow-replace to apply.`,
      );
    }
    await tofu(root, ["apply", "-input=false", "-no-color", planPath], { stream: true });
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
  const outputs = decodeOutputs(JSON.parse(await tofu(root, ["output", "-json"])));
  return {
    bucketName: outputs.bucket_name.value,
    bucketRegion: outputs.bucket_region.value,
    distributionId: outputs.distribution_id.value,
    url: outputs.site_url.value,
  };
}

function aws(site: Site, args: readonly string[]) {
  return runCommand(["aws", ...args, "--region", site.bucketRegion]);
}

async function addHashedAssets(site: Site) {
  await aws(site, [
    "s3",
    "sync",
    join(siteDirectory, "_next/static"),
    `s3://${site.bucketName}/_next/static`,
    "--only-show-errors",
    "--cache-control",
    immutableCacheControl,
  ]);
}

async function replacePages(site: Site) {
  await aws(site, [
    "s3",
    "sync",
    siteDirectory,
    `s3://${site.bucketName}`,
    "--delete",
    "--exclude",
    "_next/static/*",
    "--only-show-errors",
    "--cache-control",
    revalidateCacheControl,
  ]);
}

async function invalidateCdn(site: Site) {
  const invalidation = (
    await aws(site, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      site.distributionId,
      "--paths",
      "/*",
      "--query",
      "Invalidation.Id",
      "--output",
      "text",
    ])
  ).trim();
  log(`waiting for CloudFront invalidation ${invalidation}`);
  await aws(site, [
    "cloudfront",
    "wait",
    "invalidation-completed",
    "--distribution-id",
    site.distributionId,
    "--id",
    invalidation,
  ]);
}

async function verifySite(url: string, nestedPage: string) {
  const expectations = [
    { path: "/", status: 200 },
    { path: nestedPage, status: 200 },
    { path: nestedPage.slice(0, -1), status: 200 },
    { path: "/deploy-verification-missing-page/", status: 404 },
    { path: "/errors/insufficient-scope", status: 301 },
  ];
  await Promise.all(
    expectations.map(({ path, status }) =>
      eventually(`GET ${url}${path} answering ${status}`, verificationTimeoutMs, async () => {
        const response = await fetch(`${url}${path}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        if (response.status !== status) throw new Error(`HTTP ${response.status}`);
        return true;
      }),
    ),
  );
  log(`verified ${url}`);
}

async function main() {
  const command = parseArguments(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  for (const [flag, path] of [
    ["--root", command.root],
    ["--backend-config", command.backendConfig],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${flag} ${path} does not exist.`);
  }
  if (command.build) {
    log("building apps/docs");
    await runCommand(["bun", "run", "--cwd", "apps/docs", "build"], {
      cwd: repositoryRoot,
      stream: true,
    });
  }
  const nestedPage = await builtNestedPage();
  const site = await applyInfrastructure(command, command.allowReplace);
  log(`publishing apps/docs/out to s3://${site.bucketName}`);
  await addHashedAssets(site);
  await replacePages(site);
  await invalidateCdn(site);
  await verifySite(site.url, nestedPage);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const cause =
      error instanceof Error && error.cause !== undefined ? `: ${singleLine(error.cause)}` : "";
    process.stderr.write(`${singleLine(error)}${cause}\n`);
    process.exitCode = 1;
  });
}
