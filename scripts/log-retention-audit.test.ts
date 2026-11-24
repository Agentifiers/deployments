import { describe, expect, test } from "bun:test";
import { parseAuditCommand, unretainedLogGroups } from "./log-retention-audit.ts";

describe("log retention audit", () => {
  test("reports only never-expiring groups, in name order", () => {
    expect(
      unretainedLogGroups([
        { logGroupName: "/aws/lambda/identity-email-worker", storedBytes: 1307 },
        { logGroupName: "/aws/lambda/console", retentionInDays: 30, storedBytes: 900 },
        { logGroupName: "/aws/lambda/identity-api", storedBytes: 2_328_478 },
      ]),
    ).toEqual([
      { logGroupName: "/aws/lambda/identity-api", storedBytes: 2_328_478 },
      { logGroupName: "/aws/lambda/identity-email-worker", storedBytes: 1307 },
    ]);
  });

  test("reports by default and resolves the region from the environment", () => {
    expect(parseAuditCommand([], { AWS_REGION: "us-east-2" })).toEqual({
      kind: "report",
      region: "us-east-2",
    });
    expect(
      parseAuditCommand(["--region", "us-west-2"], { AWS_DEFAULT_REGION: "us-east-2" }),
    ).toEqual({ kind: "report", region: "us-west-2" });
  });

  test("applies only a CloudWatch retention value", () => {
    expect(parseAuditCommand(["--apply", "--days", "30"], { AWS_REGION: "us-east-2" })).toEqual({
      days: 30,
      kind: "apply",
      region: "us-east-2",
    });
    expect(() =>
      parseAuditCommand(["--apply", "--days", "31"], { AWS_REGION: "us-east-2" }),
    ).toThrow("--apply needs --days set to a CloudWatch Logs retention value");
    expect(() => parseAuditCommand(["--apply"], { AWS_REGION: "us-east-2" })).toThrow(
      "--apply needs --days set to a CloudWatch Logs retention value",
    );
  });

  test("rejects a retention without --apply and a missing region", () => {
    expect(() => parseAuditCommand(["--days", "30"], { AWS_REGION: "us-east-2" })).toThrow(
      "--days only applies with --apply.",
    );
    expect(() => parseAuditCommand([], {})).toThrow("A region is required.");
  });
});
