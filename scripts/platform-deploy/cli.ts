import { normalizeEmail } from "@deployments-ai/identity";
import { deploymentArtifactDirectory } from "../build-deployment-artifacts.ts";
import { rootProfileNames, type RootProfileName } from "./profiles.ts";

export const usage = `Usage: bun run deploy -- <command> [flags]

Commands:
  release build [--bundle <dir>]
      Build Lambda archives and platform images from HEAD into a release bundle.
      DEPLOYMENTS_AI_CONSOLE_OUTPUT_DIR=<nitro .output dir> ships that build as the console.
  release publish --bundle <dir> --bucket <name> [--ci-run-id <n>] [--deployer-image <ref@sha256:…>]
  release fetch --bucket <name> --release <digest> --bundle <dir> [--profile <name>]
  release retain --bucket <name> --release <digest>
  release verify --bundle <dir> | --bucket <name> --release <digest>
  release compat --from <commit> --to <commit>
  release rollback-check --bucket <name> --from <digest> --to <digest>
      Release registry commands. Releases live under releases/<digest>/ in the bucket,
      where <digest> is the SHA-256 of release.json.
  release share-ami --ami <ami id> --account <account id> --region <region>
      Let a customer account launch and copy an AMI this account owns, such as the
      ClickHouse hot-plane AMI.
  deploy --target <file> [--bundle <dir>] [--result <file>] [--events <file>]
      Deploy a verified release bundle into the target account. --events appends one JSON
      line per run and stage event.
  secrets sync model-runtime --target <file> [--prepare-empty]
  identity bootstrap --target <file>
  admin bootstrap --target <file> --email <email>
  lambdas deploy --target <file> [--bundle <dir>] [--dry-run]
  verify --target <file>
      Operator commands against an already deployed target.

The bundle defaults to .artifacts/deployment. Credentials come from the standard
AWS chain and must belong to the target's aws.accountId. See
apps/docs/content/docs/operate/deployment.mdx.`;

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly bundle: string; readonly kind: "release-build" }
  | {
      readonly account: string;
      readonly ami: string;
      readonly kind: "release-share-ami";
      readonly region: string;
    }
  | {
      readonly bundle: string;
      readonly events: string | undefined;
      readonly kind: "deploy";
      readonly result: string | undefined;
      readonly target: string;
    }
  | {
      readonly kind: "secrets-sync";
      readonly prepareEmpty: boolean;
      readonly secret: "model-runtime";
      readonly target: string;
    }
  | { readonly kind: "identity-bootstrap"; readonly target: string }
  | { readonly email: string; readonly kind: "admin-bootstrap"; readonly target: string }
  | {
      readonly bundle: string;
      readonly dryRun: boolean;
      readonly kind: "lambdas-deploy";
      readonly target: string;
    }
  | { readonly kind: "verify"; readonly target: string }
  | RegistryCommand;

export type RegistryCommand =
  | {
      readonly bucket: string;
      readonly bundle: string;
      readonly ciRunId: number | null;
      readonly deployerImage: string | null;
      readonly kind: "release-publish";
    }
  | {
      readonly bucket: string;
      readonly bundle: string;
      readonly kind: "release-fetch";
      readonly profile: RootProfileName | undefined;
      readonly release: string;
    }
  | { readonly bucket: string; readonly kind: "release-retain"; readonly release: string }
  | {
      readonly kind: "release-verify";
      readonly source:
        | { readonly bundle: string; readonly kind: "bundle" }
        | { readonly bucket: string; readonly kind: "registry"; readonly release: string };
    }
  | { readonly from: string; readonly kind: "release-compat"; readonly to: string }
  | {
      readonly bucket: string;
      readonly from: string;
      readonly kind: "release-rollback-check";
      readonly to: string;
    };

const registryCommandKinds: Record<RegistryCommand["kind"], true> = {
  "release-compat": true,
  "release-fetch": true,
  "release-publish": true,
  "release-retain": true,
  "release-rollback-check": true,
  "release-verify": true,
};

export function isRegistryCommand(command: CliCommand): command is RegistryCommand {
  return Object.hasOwn(registryCommandKinds, command.kind);
}

const valueFlags = [
  "--account",
  "--ami",
  "--bucket",
  "--bundle",
  "--ci-run-id",
  "--deployer-image",
  "--email",
  "--events",
  "--from",
  "--profile",
  "--release",
  "--region",
  "--result",
  "--target",
  "--to",
] as const;
const booleanFlags = ["--dry-run", "--prepare-empty"] as const;
type ValueFlag = (typeof valueFlags)[number];
type BooleanFlag = (typeof booleanFlags)[number];

function parseFlags(arguments_: readonly string[], allowed: readonly (BooleanFlag | ValueFlag)[]) {
  const values: Partial<Record<ValueFlag, string>> = {};
  const enabled: Partial<Record<BooleanFlag, true>> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    if (!(allowed as readonly string[]).includes(flag)) {
      throw new Error(`Unexpected argument ${flag}.`);
    }
    if ((booleanFlags as readonly string[]).includes(flag)) {
      enabled[flag as BooleanFlag] = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (values[flag as ValueFlag] !== undefined) throw new Error(`${flag} was given twice.`);
    values[flag as ValueFlag] = value;
    index += 1;
  }
  return { enabled, values };
}

function requiredTarget(values: Partial<Record<ValueFlag, string>>) {
  if (!values["--target"]) throw new Error("--target <file> is required.");
  return values["--target"];
}

type FlagValues = Partial<Record<ValueFlag, string>>;

function requiredValue(values: FlagValues, flag: ValueFlag, placeholder: string) {
  const value = values[flag];
  if (!value) throw new Error(`${flag} <${placeholder}> is required.`);
  return value;
}

function releaseDigest(values: FlagValues, flag: "--from" | "--release" | "--to") {
  const value = requiredValue(values, flag, "digest");
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${flag} must be a release digest, the 64-hex SHA-256 of release.json.`);
  }
  return value;
}

function parseRegistryCommand(
  subcommand: string | undefined,
  arguments_: readonly string[],
): RegistryCommand | undefined {
  switch (subcommand) {
    case "publish": {
      const { values } = parseFlags(arguments_, [
        "--bucket",
        "--bundle",
        "--ci-run-id",
        "--deployer-image",
      ]);
      const ciRunId = values["--ci-run-id"];
      if (
        ciRunId !== undefined &&
        !(/^[1-9][0-9]*$/u.test(ciRunId) && Number.isSafeInteger(Number(ciRunId)))
      ) {
        throw new Error("--ci-run-id must be a positive integer.");
      }
      const deployerImage = values["--deployer-image"];
      if (deployerImage !== undefined && !/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(deployerImage)) {
        throw new Error("--deployer-image must be pinned by digest: <repository>@sha256:<hex>.");
      }
      return {
        bucket: requiredValue(values, "--bucket", "name"),
        bundle: requiredValue(values, "--bundle", "dir"),
        ciRunId: ciRunId === undefined ? null : Number(ciRunId),
        deployerImage: deployerImage ?? null,
        kind: "release-publish",
      };
    }
    case "fetch": {
      const { values } = parseFlags(arguments_, ["--bucket", "--bundle", "--profile", "--release"]);
      const requested = values["--profile"];
      const profile = rootProfileNames.find((name) => name === requested);
      if (requested !== undefined && !profile) {
        throw new Error(`--profile must be one of ${rootProfileNames.join(", ")}.`);
      }
      return {
        bucket: requiredValue(values, "--bucket", "name"),
        bundle: requiredValue(values, "--bundle", "dir"),
        kind: "release-fetch",
        profile,
        release: releaseDigest(values, "--release"),
      };
    }
    case "retain": {
      const { values } = parseFlags(arguments_, ["--bucket", "--release"]);
      return {
        bucket: requiredValue(values, "--bucket", "name"),
        kind: "release-retain",
        release: releaseDigest(values, "--release"),
      };
    }
    case "verify": {
      const { values } = parseFlags(arguments_, ["--bucket", "--bundle", "--release"]);
      const bundle = values["--bundle"];
      if (bundle !== undefined) {
        if (values["--bucket"] !== undefined || values["--release"] !== undefined) {
          throw new Error("release verify takes --bundle or --bucket with --release, not both.");
        }
        return { kind: "release-verify", source: { bundle, kind: "bundle" } };
      }
      return {
        kind: "release-verify",
        source: {
          bucket: requiredValue(values, "--bucket", "name"),
          kind: "registry",
          release: releaseDigest(values, "--release"),
        },
      };
    }
    case "compat": {
      const { values } = parseFlags(arguments_, ["--from", "--to"]);
      return {
        from: requiredValue(values, "--from", "commit"),
        kind: "release-compat",
        to: requiredValue(values, "--to", "commit"),
      };
    }
    case "rollback-check": {
      const { values } = parseFlags(arguments_, ["--bucket", "--from", "--to"]);
      return {
        bucket: requiredValue(values, "--bucket", "name"),
        from: releaseDigest(values, "--from"),
        kind: "release-rollback-check",
        to: releaseDigest(values, "--to"),
      };
    }
    default:
      return undefined;
  }
}

export function parseCli(argv: readonly string[]): CliCommand {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help" };
  }
  const [first, second, third] = argv;
  if (first === "release" && second === "build") {
    const { values } = parseFlags(argv.slice(2), ["--bundle"]);
    return { bundle: values["--bundle"] ?? deploymentArtifactDirectory, kind: "release-build" };
  }
  if (first === "release" && second === "share-ami") {
    const { values } = parseFlags(argv.slice(2), ["--account", "--ami", "--region"]);
    const ami = requiredValue(values, "--ami", "ami id");
    const account = requiredValue(values, "--account", "account id");
    const region = requiredValue(values, "--region", "region");
    if (!/^ami-[0-9a-f]{8,17}$/u.test(ami))
      throw new Error("--ami must be an AMI ID such as ami-0123456789abcdef0.");
    if (!/^\d{12}$/u.test(account)) throw new Error("--account must be a 12-digit AWS account ID.");
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/u.test(region))
      throw new Error("--region must be an AWS region such as us-east-2.");
    return { account, ami, kind: "release-share-ami", region };
  }
  const registryCommand =
    first === "release" ? parseRegistryCommand(second, argv.slice(2)) : undefined;
  if (registryCommand) return registryCommand;
  if (first === "deploy") {
    const { values } = parseFlags(argv.slice(1), ["--bundle", "--events", "--result", "--target"]);
    return {
      bundle: values["--bundle"] ?? deploymentArtifactDirectory,
      events: values["--events"],
      kind: "deploy",
      result: values["--result"],
      target: requiredTarget(values),
    };
  }
  if (first === "secrets" && second === "sync" && third === "model-runtime") {
    const { enabled, values } = parseFlags(argv.slice(3), ["--target", "--prepare-empty"]);
    return {
      kind: "secrets-sync",
      prepareEmpty: enabled["--prepare-empty"] === true,
      secret: third,
      target: requiredTarget(values),
    };
  }
  if (first === "identity" && second === "bootstrap") {
    const { values } = parseFlags(argv.slice(2), ["--target"]);
    return { kind: "identity-bootstrap", target: requiredTarget(values) };
  }
  if (first === "admin" && second === "bootstrap") {
    const { values } = parseFlags(argv.slice(2), ["--email", "--target"]);
    if (!values["--email"]) throw new Error("--email <email> is required.");
    return {
      email: normalizeEmail(values["--email"]),
      kind: "admin-bootstrap",
      target: requiredTarget(values),
    };
  }
  if (first === "lambdas" && second === "deploy") {
    const { enabled, values } = parseFlags(argv.slice(2), ["--bundle", "--dry-run", "--target"]);
    return {
      bundle: values["--bundle"] ?? deploymentArtifactDirectory,
      dryRun: enabled["--dry-run"] === true,
      kind: "lambdas-deploy",
      target: requiredTarget(values),
    };
  }
  if (first === "verify") {
    const { values } = parseFlags(argv.slice(1), ["--target"]);
    return { kind: "verify", target: requiredTarget(values) };
  }
  throw new Error(`Unknown command: ${argv.join(" ")}. Run with --help for usage.`);
}
