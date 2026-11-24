import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("infrastructure/modules/platform-api/governance-worker-iam.tf", "utf8");
const channelSource = readFileSync(
  "infrastructure/modules/channel-provider-runtime/main.tf",
  "utf8",
);
const apiSource = readFileSync("infrastructure/modules/platform-api/api-iam.tf", "utf8");
const governanceStatement = source.match(
  /statement \{\s+sid = "GovernanceTables"(?<body>[\s\S]*?)\n  \}/u,
)?.groups?.body;

describe("governance runtime IAM", () => {
  test("allows authoritative directory queries and strongly consistent batch reads", () => {
    expect(governanceStatement).toContain('"dynamodb:BatchGetItem"');
    expect(governanceStatement).toContain('"dynamodb:Query"');
    expect(governanceStatement).not.toContain('"dynamodb:Scan"');
  });

  test("lets the API batch-read governance operations for organization history", () => {
    const controlStatement = apiSource.match(
      /statement \{\s+sid = "AccessAgentLifecycleControlItems"(?<body>[\s\S]*?)\n  \}/u,
    )?.groups?.body;
    expect(controlStatement).toContain('"dynamodb:BatchGetItem"');
    expect(controlStatement).toContain("resources = [var.control_table_arn]");
  });

  test("allows scoped credential sessions to write only their tenant directory", () => {
    const readerDirectory = channelSource.match(
      /statement \{\s+sid = "WriteCredentialReadDirectory"(?<body>[\s\S]*?)\n  \}/u,
    )?.groups?.body;
    expect(readerDirectory).toContain('"dynamodb:PutItem"');
    expect(readerDirectory).toContain('"dynamodb:TransactWriteItems"');
    expect(readerDirectory).toContain(
      '"ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY"',
    );
    expect(readerDirectory).toContain(
      '"ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY#SHARD#*"',
    );

    const writerLifecycle = channelSource.match(
      /statement \{\s+sid = "WriteCredentialLifecycle"(?<body>[\s\S]*?)\n  \}/u,
    )?.groups?.body;
    expect(writerLifecycle).toContain('"dynamodb:PutItem"');
    expect(writerLifecycle).toContain('"dynamodb:TransactWriteItems"');
    expect(writerLifecycle).toContain(
      '"ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY"',
    );
    expect(writerLifecycle).toContain(
      '"ORG#$${aws:PrincipalTag/organizationId}#GOVERNANCE-INVENTORY#SHARD#*"',
    );
  });
});
