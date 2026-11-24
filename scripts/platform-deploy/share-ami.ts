import { Schema } from "effect";
import { type CommandRunner, log } from "./process.ts";

const DescribedImages = Schema.Struct({
  Images: Schema.Tuple([
    Schema.Struct({
      BlockDeviceMappings: Schema.Array(
        Schema.Struct({ Ebs: Schema.optionalKey(Schema.Struct({ SnapshotId: Schema.String })) }),
      ),
      State: Schema.String,
    }),
  ]),
});
const DescribedSnapshots = Schema.Struct({
  Snapshots: Schema.Array(
    Schema.Struct({
      Encrypted: Schema.Boolean,
      KmsKeyId: Schema.optionalKey(Schema.String),
      SnapshotId: Schema.String,
    }),
  ),
});
const DescribedKey = Schema.Struct({
  KeyMetadata: Schema.Struct({
    Arn: Schema.String,
    KeyManager: Schema.Literals(["AWS", "CUSTOMER"]),
  }),
});

/** The KMS operations EBS needs on a snapshot's key to launch or copy it in another account. */
const snapshotKeyOperations = [
  "Decrypt",
  "DescribeKey",
  "CreateGrant",
  "GenerateDataKey",
  "GenerateDataKeyWithoutPlaintext",
  "ReEncryptFrom",
  "ReEncryptTo",
];

/**
 * Lets another account launch and copy an AMI this account owns: a KMS grant
 * on every customer managed key that encrypts its snapshots, a create-volume
 * permission on each snapshot, and a launch permission on the AMI, in that
 * order, so the launch permission exists only once the rest does. Every step
 * adds a permission that may already exist, so a rerun converges.
 */
export async function shareAmi(input: {
  readonly account: string;
  readonly ami: string;
  readonly region: string;
  readonly run: CommandRunner;
}) {
  const { account, ami } = input;
  const aws = async (...args: string[]) =>
    await input.run([
      "aws",
      ...args,
      "--region",
      input.region,
      "--output",
      "json",
      "--no-cli-pager",
    ]);

  const [image] = Schema.decodeUnknownSync(DescribedImages)(
    JSON.parse(await aws("ec2", "describe-images", "--image-ids", ami)),
  ).Images;
  if (image.State !== "available") {
    throw new Error(`AMI ${ami} is ${image.State}; share it once it is available.`);
  }
  const snapshotIds = image.BlockDeviceMappings.flatMap(({ Ebs }) => (Ebs ? [Ebs.SnapshotId] : []));
  const snapshots =
    snapshotIds.length === 0
      ? []
      : Schema.decodeUnknownSync(DescribedSnapshots)(
          JSON.parse(await aws("ec2", "describe-snapshots", "--snapshot-ids", ...snapshotIds)),
        ).Snapshots;

  const snapshotsByKey = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.Encrypted) continue;
    if (!snapshot.KmsKeyId) throw new Error(`Snapshot ${snapshot.SnapshotId} names no KMS key.`);
    snapshotsByKey.set(snapshot.KmsKeyId, [
      ...(snapshotsByKey.get(snapshot.KmsKeyId) ?? []),
      snapshot.SnapshotId,
    ]);
  }
  const customerKeys: string[] = [];
  for (const [keyId, keySnapshots] of snapshotsByKey) {
    const { Arn, KeyManager } = Schema.decodeUnknownSync(DescribedKey)(
      JSON.parse(await aws("kms", "describe-key", "--key-id", keyId)),
    ).KeyMetadata;
    if (KeyManager === "AWS") {
      throw new Error(
        `AMI ${ami} cannot be shared: ${keySnapshots.join(", ")} use the AWS managed key ${Arn}. Copy the AMI with a customer managed key (aws ec2 copy-image --encrypted --kms-key-id <key>) and share the copy.`,
      );
    }
    customerKeys.push(Arn);
  }

  for (const keyArn of customerKeys) {
    const partition = keyArn.split(":")[1];
    log(`granting ${account} use of ${keyArn}`);
    await aws(
      "kms",
      "create-grant",
      "--key-id",
      keyArn,
      "--grantee-principal",
      `arn:${partition}:iam::${account}:root`,
      "--operations",
      ...snapshotKeyOperations,
      "--name",
      `ami-share-${account}`,
    );
  }
  for (const snapshotId of snapshotIds) {
    log(`sharing snapshot ${snapshotId} with ${account}`);
    await aws(
      "ec2",
      "modify-snapshot-attribute",
      "--snapshot-id",
      snapshotId,
      "--attribute",
      "createVolumePermission",
      "--operation-type",
      "add",
      "--user-ids",
      account,
    );
  }
  log(`sharing ${ami} with ${account}`);
  await aws(
    "ec2",
    "modify-image-attribute",
    "--image-id",
    ami,
    "--launch-permission",
    `Add=[{UserId=${account}}]`,
  );
  return { keys: customerKeys, snapshots: snapshotIds };
}
