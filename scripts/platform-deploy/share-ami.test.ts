import { describe, expect, test } from "bun:test";
import { parseCli } from "./cli.ts";
import type { CommandRunner } from "./process.ts";
import { shareAmi } from "./share-ami.ts";

const ami = "ami-0123456789abcdef0";
const customer = "210987654321";
const customerKey = "arn:aws:kms:us-east-2:111122223333:key/00000000-0000-4000-8000-000000000001";
const awsManagedKey = "arn:aws:kms:us-east-2:111122223333:key/00000000-0000-4000-8000-000000000002";
const suffix = ["--region", "us-east-2", "--output", "json", "--no-cli-pager"];

function ec2(snapshots: readonly { readonly id: string; readonly key?: string }[]) {
  const calls: string[][] = [];
  const run: CommandRunner = async (command) => {
    calls.push([...command]);
    const operation = command.slice(1, 3).join(" ");
    switch (operation) {
      case "ec2 describe-images":
        return JSON.stringify({
          Images: [
            {
              BlockDeviceMappings: [
                ...snapshots.map(({ id }) => ({
                  DeviceName: "/dev/sda1",
                  Ebs: { SnapshotId: id },
                })),
                { DeviceName: "/dev/sdb", VirtualName: "ephemeral0" },
              ],
              ImageId: ami,
              State: "available",
            },
          ],
        });
      case "ec2 describe-snapshots":
        return JSON.stringify({
          Snapshots: snapshots.map(({ id, key }) => ({
            Encrypted: key !== undefined,
            ...(key ? { KmsKeyId: key } : {}),
            SnapshotId: id,
          })),
        });
      case "kms describe-key": {
        const keyId = command[4];
        return JSON.stringify({
          KeyMetadata: { Arn: keyId, KeyManager: keyId === awsManagedKey ? "AWS" : "CUSTOMER" },
        });
      }
      case "kms create-grant":
        return JSON.stringify({ GrantId: "grant", GrantToken: "token" });
      case "ec2 modify-snapshot-attribute":
      case "ec2 modify-image-attribute":
        return "";
      default:
        throw new Error(`unexpected command ${command.join(" ")}`);
    }
  };
  return { calls, run };
}

describe("AMI sharing", () => {
  test("grants the customer key, then shares each snapshot, then the AMI", async () => {
    const { calls, run } = ec2([
      { id: "snap-0aaaaaaaaaaaaaaaa", key: customerKey },
      { id: "snap-0bbbbbbbbbbbbbbbb" },
    ]);
    expect(await shareAmi({ account: customer, ami, region: "us-east-2", run })).toEqual({
      keys: [customerKey],
      snapshots: ["snap-0aaaaaaaaaaaaaaaa", "snap-0bbbbbbbbbbbbbbbb"],
    });
    expect(calls).toEqual([
      ["aws", "ec2", "describe-images", "--image-ids", ami, ...suffix],
      [
        "aws",
        "ec2",
        "describe-snapshots",
        "--snapshot-ids",
        "snap-0aaaaaaaaaaaaaaaa",
        "snap-0bbbbbbbbbbbbbbbb",
        ...suffix,
      ],
      ["aws", "kms", "describe-key", "--key-id", customerKey, ...suffix],
      [
        "aws",
        "kms",
        "create-grant",
        "--key-id",
        customerKey,
        "--grantee-principal",
        "arn:aws:iam::210987654321:root",
        "--operations",
        "Decrypt",
        "DescribeKey",
        "CreateGrant",
        "GenerateDataKey",
        "GenerateDataKeyWithoutPlaintext",
        "ReEncryptFrom",
        "ReEncryptTo",
        "--name",
        "ami-share-210987654321",
        ...suffix,
      ],
      [
        "aws",
        "ec2",
        "modify-snapshot-attribute",
        "--snapshot-id",
        "snap-0aaaaaaaaaaaaaaaa",
        "--attribute",
        "createVolumePermission",
        "--operation-type",
        "add",
        "--user-ids",
        customer,
        ...suffix,
      ],
      [
        "aws",
        "ec2",
        "modify-snapshot-attribute",
        "--snapshot-id",
        "snap-0bbbbbbbbbbbbbbbb",
        "--attribute",
        "createVolumePermission",
        "--operation-type",
        "add",
        "--user-ids",
        customer,
        ...suffix,
      ],
      [
        "aws",
        "ec2",
        "modify-image-attribute",
        "--image-id",
        ami,
        "--launch-permission",
        "Add=[{UserId=210987654321}]",
        ...suffix,
      ],
    ]);
  });

  test("refuses an AMI whose snapshots use the AWS managed key before it shares anything", async () => {
    const { calls, run } = ec2([{ id: "snap-0cccccccccccccccc", key: awsManagedKey }]);
    const refusal = await shareAmi({ account: customer, ami, region: "us-east-2", run }).then(
      () => "shared",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toBe(
      `AMI ${ami} cannot be shared: snap-0cccccccccccccccc use the AWS managed key ${awsManagedKey}. Copy the AMI with a customer managed key (aws ec2 copy-image --encrypted --kms-key-id <key>) and share the copy.`,
    );
    expect(calls.map((command) => command.slice(1, 3).join(" "))).toEqual([
      "ec2 describe-images",
      "ec2 describe-snapshots",
      "kms describe-key",
    ]);
  });
});

describe("release share-ami command line", () => {
  test("parses the AMI, the customer account, and the AMI's region", () => {
    expect(
      parseCli([
        "release",
        "share-ami",
        "--ami",
        ami,
        "--account",
        customer,
        "--region",
        "us-east-2",
      ]),
    ).toEqual({ account: customer, ami, kind: "release-share-ami", region: "us-east-2" });
    expect(() => parseCli(["release", "share-ami", "--ami", ami, "--account", customer])).toThrow(
      "--region <region> is required.",
    );
    expect(() =>
      parseCli([
        "release",
        "share-ami",
        "--ami",
        ami,
        "--account",
        "acme",
        "--region",
        "us-east-2",
      ]),
    ).toThrow("--account must be a 12-digit AWS account ID.");
  });
});
