import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { loadSharedConfigFiles } from "@smithy/core/config";
import type { RegistryCommand } from "../cli.ts";
import { type Environment, repositoryRoot, runCommand } from "../process.ts";
import { rootProfiles } from "../profiles.ts";
import { verifyReleaseBundle } from "../release-bundle.ts";
import { compatibilityReasons } from "./compat.ts";
import { fetchRelease } from "./fetch.ts";
import { publishRelease } from "./publish.ts";
import { retainRelease } from "./retain.ts";
import { checkRollback } from "./rollback-check.ts";
import { s3RegistryStore } from "./s3-store.ts";
import { kmsReleaseSigner } from "./signing.ts";
import { verifyPublishedRelease } from "./verify.ts";

function print(line: string) {
  process.stdout.write(`${line}\n`);
}

/** The SDK's own region lookup ends by asking EC2 instance metadata, which can hang under Bun. */
export async function registryRegion(environment: Environment) {
  const fromVariables = environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim();
  if (fromVariables) return fromVariables;
  const profile = environment.AWS_PROFILE || "default";
  const { configFile, credentialsFile } = await loadSharedConfigFiles({
    ...(environment.AWS_CONFIG_FILE ? { configFilepath: environment.AWS_CONFIG_FILE } : {}),
    ...(environment.AWS_SHARED_CREDENTIALS_FILE
      ? { filepath: environment.AWS_SHARED_CREDENTIALS_FILE }
      : {}),
  });
  const fromProfile = (credentialsFile[profile]?.region ?? configFile[profile]?.region)?.trim();
  if (fromProfile) return fromProfile;
  throw new Error(
    `The release registry needs a region. Set AWS_REGION or AWS_DEFAULT_REGION, or set region in AWS profile "${profile}" (AWS_PROFILE selects the profile).`,
  );
}

export async function runRegistryCommand(command: RegistryCommand, environment: Environment) {
  const registry = async (bucket: string) =>
    s3RegistryStore({
      bucket,
      client: new S3Client({
        followRegionRedirects: true,
        region: await registryRegion(environment),
      }),
    });
  const signingPublicKeyPath = environment.RELEASE_SIGNING_PUBLIC_KEY || undefined;
  switch (command.kind) {
    case "release-publish": {
      const kmsKeyId = environment.RELEASE_SIGNING_KMS_KEY_ID;
      const record = await publishRelease({
        bundle: command.bundle,
        ciRunId: command.ciRunId,
        compatibilityReasons: (from, to) =>
          compatibilityReasons({ cwd: repositoryRoot, from, run: runCommand, to }),
        deployerImage: command.deployerImage,
        now: () => new Date(),
        signer: kmsKeyId
          ? kmsReleaseSigner({
              client: new KMSClient({ region: await registryRegion(environment) }),
              keyId: kmsKeyId,
            })
          : undefined,
        signingPublicKeyPath,
        store: await registry(command.bucket),
      });
      print(record.releaseManifestSha256);
      return;
    }
    case "release-fetch": {
      const release = await fetchRelease({
        bundle: command.bundle,
        images: command.profile ? rootProfiles[command.profile].images : "all",
        releaseManifestSha256: command.release,
        signingPublicKeyPath,
        store: await registry(command.bucket),
      });
      print(release.directory);
      return;
    }
    case "release-retain": {
      const { objects, retagged } = await retainRelease({
        releaseManifestSha256: command.release,
        store: await registry(command.bucket),
      });
      print(`retained ${command.release}: retagged ${retagged} of ${objects} objects`);
      return;
    }
    case "release-verify": {
      const { source } = command;
      if (source.kind === "bundle") {
        const release = await verifyReleaseBundle(source.bundle, [], { signingPublicKeyPath });
        const absent = release.absentImages.length > 0 ? release.absentImages.join(", ") : "none";
        const installConsole =
          release.consoleBuild === "install" ? "; console: install-supplied build" : "";
        print(
          `verified ${release.manifestSha256} (${release.sourceCommit}); absent images: ${absent}${installConsole}`,
        );
        return;
      }
      const record = await verifyPublishedRelease({
        releaseManifestSha256: source.release,
        signingPublicKeyPath,
        store: await registry(source.bucket),
      });
      print(`verified ${record.releaseManifestSha256} (${record.label})`);
      return;
    }
    case "release-compat": {
      const reasons = await compatibilityReasons({
        cwd: repositoryRoot,
        from: command.from,
        run: runCommand,
        to: command.to,
      });
      print(JSON.stringify({ rollbackBarrier: reasons.length > 0, reasons }, null, 2));
      return;
    }
    case "release-rollback-check": {
      const decision = await checkRollback({
        from: command.from,
        signingPublicKeyPath,
        store: await registry(command.bucket),
        to: command.to,
      });
      if (decision.kind === "refused") {
        throw new Error(`Rollback refused. ${decision.reasons.join(" ")}`);
      }
      print(`rollback allowed ${command.to}`);
      if (decision.target.deployer) print(`deployer ${decision.target.deployer.image}`);
      return;
    }
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}
