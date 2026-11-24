import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import type { MicrovmImageVariant } from "../lambda-microvm-image.ts";
import { repositoryRoot, singleLine } from "./process.ts";
import {
  defaultEcrRepositories,
  platformImageNames,
  type PlatformImageName,
  type RootProfile,
  rootProfileNames,
  rootProfiles,
  type RootProfileName,
} from "./profiles.ts";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/u)));

export const DeploymentTargetDocument = Schema.Struct({
  aws: Schema.Struct({
    accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{12}$/u))),
    region: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]{2}(-[a-z]+)+-\d$/u))),
  }),
  ecrRepositories: Schema.optionalKey(
    Schema.Struct({
      "agent-worker": Schema.optionalKey(NonEmptyString),
      "app-gateway": Schema.optionalKey(NonEmptyString),
      bifrost: Schema.optionalKey(NonEmptyString),
      "durable-streams": Schema.optionalKey(NonEmptyString),
      firecrawl: Schema.optionalKey(NonEmptyString),
      "model-gateway": Schema.optionalKey(NonEmptyString),
      "observability-hot-plane": Schema.optionalKey(NonEmptyString),
      "stream-gateway": Schema.optionalKey(NonEmptyString),
      "web-tools-proxy": Schema.optionalKey(NonEmptyString),
    }),
  ),
  /** Turns the profile's Lambda MicroVM steps off, for a region without Lambda MicroVMs. */
  lambdaMicrovm: Schema.optionalKey(Schema.Boolean),
  /** The MicroVM image variant the deploy publishes; `desktop` adds a desktop for computer use. */
  lambdaMicrovmImage: Schema.optionalKey(Schema.Literals(["sandbox", "desktop"])),
  name: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,30}$/u))),
  profile: Schema.Literals(rootProfileNames),
  terraform: Schema.Struct({
    root: Schema.optionalKey(NonEmptyString),
    stateBucket: NonEmptyString,
    stateKey: Schema.optionalKey(NonEmptyString),
    varFiles: Schema.optionalKey(Schema.Array(NonEmptyString)),
  }),
  version: Schema.Literal(1),
});

const decodeTargetDocument = Schema.decodeUnknownSync(DeploymentTargetDocument, {
  onExcessProperty: "error",
});

export interface DeploymentTarget {
  readonly aws: { readonly accountId: string; readonly region: string };
  readonly ecrRepositories: Readonly<Record<PlatformImageName, string>>;
  readonly lambdaMicrovmImage: MicrovmImageVariant;
  readonly name: string;
  readonly profile: RootProfile;
  readonly profileName: RootProfileName;
  readonly terraform: {
    /** Absolute path of the OpenTofu root the deploy runs in. */
    readonly root: string;
    readonly stateBucket: string;
    readonly stateKey: string;
    readonly varFiles: readonly string[];
  };
}

async function verifiedVarFile(path: string, base: string) {
  const absolute = resolve(base, path);
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    throw new Error(`OpenTofu var file ${absolute} does not exist or is unreadable.`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new Error(`OpenTofu var file ${absolute} is not valid JSON.`);
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`OpenTofu var file ${absolute} must contain a JSON object.`);
  }
  return absolute;
}

async function verifiedRoot(path: string) {
  const isDirectory = await stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isDirectory) throw new Error(`OpenTofu root ${path} does not exist or is not a directory.`);
  return path;
}

/** `terraform.root` resolves against `base`; without it the profile's in-repo root applies. */
async function resolvedRoot(
  document: typeof DeploymentTargetDocument.Type,
  profile: RootProfile,
  base: string,
) {
  if (document.terraform.root !== undefined) {
    return await verifiedRoot(resolve(base, document.terraform.root));
  }
  if (profile.terraformRoot === undefined) {
    throw new Error(
      `Deployment target ${document.name} uses profile ${document.profile}, whose OpenTofu root is not in this repository; set terraform.root to the root's directory.`,
    );
  }
  return await verifiedRoot(join(repositoryRoot, profile.terraformRoot));
}

/** Decodes a deployment target; relative root and var-file paths resolve against `base`. */
export async function decodeDeploymentTarget(
  value: unknown,
  base: string,
): Promise<DeploymentTarget> {
  let document: typeof DeploymentTargetDocument.Type;
  try {
    document = decodeTargetDocument(value);
  } catch (error) {
    throw new Error(`Invalid deployment target: ${singleLine(error)}`);
  }
  const baseProfile: RootProfile = rootProfiles[document.profile];
  const profile: RootProfile = {
    ...baseProfile,
    lambdaMicrovm: document.lambdaMicrovm ?? baseProfile.lambdaMicrovm,
  };
  if (document.lambdaMicrovmImage !== undefined && !profile.lambdaMicrovm) {
    throw new Error(
      `Deployment target ${document.name} sets lambdaMicrovmImage, but it publishes no Lambda MicroVM image.`,
    );
  }
  const root = await resolvedRoot(document, profile, base);
  const varFiles: string[] = [];
  for (const path of document.terraform.varFiles ?? []) {
    varFiles.push(await verifiedVarFile(path, base));
  }
  return {
    aws: { accountId: document.aws.accountId, region: document.aws.region },
    ecrRepositories: Object.fromEntries(
      platformImageNames.map((name) => [
        name,
        document.ecrRepositories?.[name] ?? defaultEcrRepositories[name],
      ]),
    ) as Record<PlatformImageName, string>,
    lambdaMicrovmImage: document.lambdaMicrovmImage ?? "sandbox",
    name: document.name,
    profile,
    profileName: document.profile,
    terraform: {
      root,
      stateBucket: document.terraform.stateBucket,
      stateKey: document.terraform.stateKey ?? `platform/${document.name}/terraform.tfstate`,
      varFiles,
    },
  };
}

export async function loadDeploymentTarget(path: string): Promise<DeploymentTarget> {
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    throw new Error(`Deployment target ${absolute} does not exist or is unreadable.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Deployment target ${absolute} is not valid JSON.`);
  }
  return await decodeDeploymentTarget(value, resolve(absolute, ".."));
}
