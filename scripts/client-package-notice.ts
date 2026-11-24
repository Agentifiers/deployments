import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";

export interface ThirdPartyComponent {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseText: string;
}

const PackageManifest = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  license: Schema.NonEmptyString,
});

const BundleMetafile = Schema.Struct({
  outputs: Schema.Record(
    Schema.String,
    Schema.Struct({
      inputs: Schema.Record(Schema.String, Schema.Struct({ bytesInOutput: Schema.Number })),
    }),
  ),
});

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-.].*)?$/iu;
const NODE_MODULES_PACKAGE = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//u;

export async function readThirdPartyComponent(
  packageDirectory: string,
): Promise<ThirdPartyComponent> {
  const manifest = Schema.decodeUnknownSync(PackageManifest)(
    JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")),
  );
  const licenseFiles = (await readdir(packageDirectory))
    .filter((entry) => LICENSE_FILE.test(entry))
    .sort();
  if (licenseFiles.length === 0) {
    throw new Error(`${packageDirectory} ships no license file to reproduce.`);
  }
  const licenseTexts = await Promise.all(
    licenseFiles.map((file) => readFile(resolve(packageDirectory, file), "utf8")),
  );
  return {
    ...manifest,
    licenseText: licenseTexts.map((text) => text.trim()).join("\n\n"),
  };
}

export async function bundledThirdPartyComponents({
  root,
  metafile,
}: {
  readonly root: string;
  readonly metafile: unknown;
}): Promise<readonly ThirdPartyComponent[]> {
  const { outputs } = Schema.decodeUnknownSync(BundleMetafile)(metafile);
  const packageDirectories = new Set<string>();
  for (const output of Object.values(outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const packageDirectory = NODE_MODULES_PACKAGE.exec(input)?.[1];
      if (bytesInOutput > 0 && packageDirectory) {
        packageDirectories.add(resolve(root, packageDirectory));
      }
    }
  }
  const components = await Promise.all(Array.from(packageDirectories, readThirdPartyComponent));
  const unique = new Map(
    components.map((component) => [`${component.name}@${component.version}`, component]),
  );
  return Array.from(unique.values()).sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

export function renderClientPackageNotice({
  packageNotice,
  components,
}: {
  readonly packageNotice: string;
  readonly components: readonly ThirdPartyComponent[];
}): string {
  if (components.length === 0) return `${packageNotice.trimEnd()}\n`;
  const rule = "-".repeat(79);
  const sections = components.map((component) =>
    [
      rule,
      `${component.name} ${component.version} (${component.license})`,
      rule,
      "",
      component.licenseText,
    ].join("\n"),
  );
  return [
    packageNotice.trimEnd(),
    "",
    "This package includes the following third-party software. Each component",
    "remains under its own license, reproduced below.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}
